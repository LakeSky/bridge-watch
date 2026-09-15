import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbiItem, type PublicClient, type Log } from "viem";

/**
 * USDC 到账监控：扫描付款地址收到的 USDC，持久化去重，供 credit 充值。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const DEPOSITS_FILE = join(DATA_DIR, "deposits.json");

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export interface Deposit {
  from: `0x${string}`;
  /** 金额（资产原始单位，如 USDC 6 位小数） */
  amount: bigint;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  /** 首次记录时间（毫秒） */
  ts: number;
}

// 公共 RPC 的 eth_getLogs 限 2000 块；生产可换成 Alchemy/QuickNode 或分页扫描
const LOOKBACK_BLOCKS = 2000n;

/** 单次 eth_getLogs 允许的最大块跨度（公共 RPC 限制） */
export const MAX_BLOCK_RANGE = 2000n;

/**
 * 单轮增量扫描最多翻多少页（2000 块/页 → 默认最多追 40000 块，Base 约 22 小时）。
 * 追不上时不会跳过：只把游标推进到"确实扫完的块"，下一轮继续追。
 */
export const DEFAULT_MAX_PAGES = 20;

/** 分页扫描 [fromBlock, toBlock] 区间内的到账 */
export async function scanRange(
  client: PublicClient,
  paymentAddress: `0x${string}`,
  assetAddress: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<{ deposits: Deposit[]; scannedTo: bigint; pages: number; truncated: boolean }> {
  const out: Deposit[] = [];
  let from = fromBlock;
  let pages = 0;
  let truncated = false;

  while (from <= toBlock) {
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    const spanEnd = from + MAX_BLOCK_RANGE - 1n;
    const to = spanEnd < toBlock ? spanEnd : toBlock;

    const logs = await client.getLogs({
      address: assetAddress,
      event: transferEvent,
      args: { to: paymentAddress },
      fromBlock: from,
      toBlock: to,
    });
    out.push(...logs.map(toDeposit).filter((d) => d.from !== paymentAddress));

    pages++;
    from = to + 1n;
  }

  // 未截断时 from 已越过 toBlock，实际扫完的块 = toBlock
  const scannedTo = truncated ? from - 1n : toBlock;
  return { deposits: out, scannedTo, pages, truncated };
}

/** 扫描付款地址收到的 USDC（近 LOOKBACK_BLOCKS 块） */
export async function scanDeposits(
  client: PublicClient,
  paymentAddress: `0x${string}`,
  assetAddress: `0x${string}`,
): Promise<Deposit[]> {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;

  const logs = await client.getLogs({
    address: assetAddress,
    event: transferEvent,
    args: { to: paymentAddress },
    fromBlock,
    toBlock: latest,
  });

  return logs.map(toDeposit).filter((d) => d.from !== paymentAddress);
}

/**
 * 增量扫描：从游标之后扫到最新块（分页）。
 *
 * @param cursor 上次已扫到的块号；null 表示无游标（退化为回看 LOOKBACK_BLOCKS）
 *
 * 返回的 scannedTo 是"确实扫完的最高块"，调用方应据此推进游标：
 * 截断（truncated=true）时 scannedTo < 最新块，下一轮接着追，绝不跳块。
 */
export async function scanDepositsSince(
  client: PublicClient,
  paymentAddress: `0x${string}`,
  assetAddress: `0x${string}`,
  cursor: bigint | null,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<{
  deposits: Deposit[];
  latest: bigint;
  fromBlock: bigint;
  scannedTo: bigint;
  pages: number;
  truncated: boolean;
}> {
  const latest = await client.getBlockNumber();
  const fromBlock =
    cursor === null
      ? latest > LOOKBACK_BLOCKS
        ? latest - LOOKBACK_BLOCKS
        : 0n
      : cursor + 1n;

  if (fromBlock > latest) {
    // 已扫到链头（常见于上一轮刚扫完、间隔又短）
    return {
      deposits: [],
      latest,
      fromBlock,
      scannedTo: latest,
      pages: 0,
      truncated: false,
    };
  }

  const r = await scanRange(
    client,
    paymentAddress,
    assetAddress,
    fromBlock,
    latest,
    maxPages,
  );
  return { ...r, latest, fromBlock };
}

function toDeposit(log: Log): Deposit {
  const args = (
    log as Log & { args?: { from?: `0x${string}`; value?: bigint } }
  ).args;
  return {
    from: (args?.from ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
    amount: args?.value ?? 0n,
    txHash: (log.transactionHash ?? "0x") as `0x${string}`,
    logIndex: log.logIndex ?? 0,
    blockNumber: log.blockNumber ?? 0n,
    ts: Date.now(),
  };
}

/** 读取已持久化的存款（去重依据） */
export function loadDeposits(): Deposit[] {
  if (!existsSync(DEPOSITS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(DEPOSITS_FILE, "utf-8")) as Deposit[];
    return parsed.map((d) => ({
      ...d,
      amount: BigInt(d.amount),
      blockNumber: BigInt(d.blockNumber ?? 0),
    }));
  } catch {
    return [];
  }
}

/** 合并新存款（按 txHash+logIndex 去重），返回新增 */
export function mergeDeposits(
  existing: Deposit[],
  incoming: Deposit[],
): { all: Deposit[]; added: Deposit[] } {
  const seen = new Set(existing.map((d) => `${d.txHash}:${d.logIndex}`));
  const added: Deposit[] = [];
  for (const d of incoming) {
    const key = `${d.txHash}:${d.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(d);
  }
  return { all: [...existing, ...added], added };
}

/** 落盘 */
export function saveDeposits(deposits: Deposit[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  // Deposit 含 amount / blockNumber 等 bigint 字段，原生 JSON.stringify 会抛
  // "Do not know how to serialize a BigInt"；用 replacer 把 bigint 统一转字符串。
  writeFileSync(
    DEPOSITS_FILE,
    JSON.stringify(deposits, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
    "utf-8",
  );
}
