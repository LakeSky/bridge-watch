import { createPublicClient, http } from "viem";
import { loadConfig } from "../config.js";
import {
  loadDeposits,
  mergeDeposits,
  saveDeposits,
  scanDeposits,
} from "./deposits.js";
import { appendInboxDefault, type CreditEntry } from "./credit-inbox.js";

/**
 * 到账自动入账守护进程（credit daemon）。
 *
 * 为什么需要它：api 进程只在【启动时】读取一次 deposits.json 换算额度，
 * 之后链上再有 USDC 到账必须"手动跑扫描 + 重启 api"才会生效 —— 这对
 * "无人值守赚钱"是硬伤（客户付了钱却用不了，直到有人重启服务）。
 *
 * 本进程每 N 分钟做一次：
 *   1. 扫描收款地址在链上收到的 USDC 转账（近 LOOKBACK_BLOCKS 个区块）；
 *   2. 与 data/deposits.json 合并去重后落盘；
 *   3. 把【新增】到账换算成 credit，追加到 data/credits-inbox.json。
 *
 * api 侧 billing 在每次请求时感知 inbox 变化并自动入账（无需重启）。
 *
 * 用法：
 *   npm run credit:once                 单次扫描（适合 cron）
 *   npm run credit:daemon               常驻循环（默认 300s 一轮）
 *   tsx src/payment/credit-daemon.ts --interval=60
 */

function parseArgs(argv: string[]): { once: boolean; intervalSec: number } {
  const once = argv.includes("--once");
  const hit = argv.find((a) => a.startsWith("--interval="));
  const raw = hit ? Number(hit.split("=")[1]) : NaN;
  const intervalSec = Number.isFinite(raw) && raw >= 30 ? raw : 300;
  return { once, intervalSec };
}

/** 单轮扫描：返回本轮新增到账笔数 */
async function tick(): Promise<number> {
  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const unit = 10n ** BigInt(config.assetDecimals);

  const existing = loadDeposits();
  const scanned = await scanDeposits(
    client,
    config.paymentAddress,
    config.assetAddress,
  );
  const { all, added } = mergeDeposits(existing, scanned);

  if (added.length === 0) {
    console.log(
      `[credit-daemon] ${new Date().toISOString()} 无新到账（累计 ${all.length} 笔）`,
    );
    return 0;
  }

  saveDeposits(all);

  const entries: CreditEntry[] = added.map((d) => ({
    key: d.from.toLowerCase(),
    credits: Number((d.amount * BigInt(config.creditPerUsdc)) / unit),
    txHash: d.txHash,
    logIndex: d.logIndex,
    ts: Date.now(),
  }));

  const queued = appendInboxDefault(entries);
  console.log(
    `[credit-daemon] 新到账 ${added.length} 笔，入账队列 +${queued} 条` +
      `（收款地址 ${config.paymentAddress}）`,
  );
  return added.length;
}

async function main(): Promise<void> {
  const { once, intervalSec } = parseArgs(process.argv.slice(2));

  console.log(
    `[credit-daemon] 启动：模式=${once ? "单次" : `循环 ${intervalSec}s`}`,
  );

  let stopping = false;
  const stop = (sig: string) => {
    console.log(`[credit-daemon] 收到 ${sig}，退出`);
    stopping = true;
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  do {
    try {
      await tick();
    } catch (err) {
      // 网络抖动/RPC 限流不应让守护进程退出
      console.warn(`[credit-daemon] 本轮失败: ${(err as Error).message}`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  } while (!stopping);
}

main().catch((err) => {
  console.error("[credit-daemon] 致命错误:", err);
  process.exit(1);
});
