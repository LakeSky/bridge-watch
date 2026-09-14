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
