import { createPublicClient, http } from "viem";
import { loadConfig } from "../config.js";
import {
  loadDeposits,
  mergeDeposits,
  saveDeposits,
  scanDepositsSince,
} from "./deposits.js";
import {
  appendInboxDefault,
  entryId,
  readInbox,
  type CreditEntry,
} from "./credit-inbox.js";
import { loadScanCursor, saveScanCursor } from "./scan-cursor.js";
import { rawToCredits, isDustCredits, formatCredits } from "./credit-math.js";

/**
 * 到账自动入账守护进程（credit daemon）。
 *
 * 为什么需要它：api 进程只在【启动时】读取一次 deposits.json 换算额度，
 * 之后链上再有 USDC 到账必须"手动跑扫描 + 重启 api"才会生效 —— 这对
 * "无人值守赚钱"是硬伤（客户付了钱却用不了，直到有人重启服务）。
 *
 * 本进程每 N 分钟做一次：
 *   1. 从持久化游标之后扫到链头（分页），不再依赖 66 分钟回看窗口；
 *   2. 与 data/deposits.json 合并去重后落盘；
 *   3. 把【换算后 > 0】的到账追加到 data/credits-inbox.json，
 *      幂等基准是"inbox 是否已收录该 txHash:logIndex"，因此历史漏单会被自动补齐。
 *
 * api 侧 billing 在每次请求时感知 inbox 变化并自动入账（无需重启）。
 *
 * 2026-09-15 修复（客户 0.005 USDC 未入账事故）：
 *   - 换算不再整数截断（0.005 USDC 曾换算成 0 被静默丢弃），改见 credit-math.ts；
 *   - 入队基准由"deposits 新增"改为"inbox 未收录"，历史漏单（已写入 deposits
 *     但从未入队）会在下一轮自动补入队；
 *   - 扫链游标持久化（scan-cursor.ts），宕机/重启不再永久丢单；
 *   - 新增到账却 0 条入队、dust 到账、扫描被截断，全部打 [ALERT] 告警，
 *     不再以"无新到账"糊过去。
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

/** 换算不足最小精度（dust）的到账 */
export interface DustDeposit {
  txHash: string;
  logIndex: number;
  from: string;
  /** 资产原始单位金额 */
  amount: bigint;
  credits: number;
}

/** 单轮扫描结果（供日志/测试断言） */
export interface TickReport {
  /** 本轮链上扫到的日志条数 */
  scanned: number;
  /** 本轮新记录的到账笔数（deposits.json 新增） */
  added: number;
  /** 本轮新入队条数（inbox 实际新增） */
  queued: number;
  /** 本轮新入队 credit 合计（含小数） */
  queuedCredits: number;
  /** 本轮新发现但换算为 dust 的到账 */
  dust: DustDeposit[];
  /** 本轮扫描区间与进度 */
  fromBlock: string;
  scannedTo: string;
  latest: string;
  pages: number;
  truncated: boolean;
  /** 需要人工关注的告警文案（空数组 = 一切正常） */
  alerts: string[];
}

/** 单轮扫描：扫描 → upsert deposits → 幂等入队 → 推进游标（异步，可被测试直接驱动） */
export async function tick(): Promise<TickReport> {
  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });

  const cursorBefore = loadScanCursor();
  const scan = await scanDepositsSince(
    client,
    config.paymentAddress,
    config.assetAddress,
    cursorBefore,
  );

  const existing = loadDeposits();
  const { all, added } = mergeDeposits(existing, scan.deposits);
  // 先落盘到账，再推进游标：宁可重复扫描，不可"游标前进但到账没记下"
  if (added.length > 0) saveDeposits(all);

  const entries: CreditEntry[] = all.map((d) => ({
    key: d.from.toLowerCase(),
    credits: rawToCredits(d.amount, config.assetDecimals, config.creditPerUsdc),
    txHash: d.txHash,
    logIndex: d.logIndex,
    ts: Date.now(),
  }));

  // 入队：对【全量到账】重算，按 inbox 已收录条目去重（appendInbox 内部幂等）。
  // 这样"已写进 deposits 但从未入队"的历史漏单会在下一轮被自动补上。
  const payable = entries.filter((e) => e.credits > 0);
  let queued = 0;
  let queuedCredits = 0;
  if (payable.length > 0) {
    const before = new Set(readInbox().map((e) => entryId(e)));
    queued = appendInboxDefault(payable);
    queuedCredits = readInbox()
      .filter((e) => !before.has(entryId(e)))
      .reduce((sum, e) => sum + e.credits, 0);
  }

  // 扫描成功才推进游标（截断时推进到"确实扫完的块"，下一轮继续追）
  saveScanCursor(scan.scannedTo);

  // ---- 告警（修复"静默失败"：此前这些情形都只表现为"无新到账"）----
  const alerts: string[] = [];

  const addedIds = new Set(added.map((d) => `${d.txHash}:${d.logIndex}`));
  const dust: DustDeposit[] = entries
    .filter((e) => addedIds.has(entryId(e)) && isDustCredits(e.credits))
    .map((e) => {
      const d = all.find((x) => `${x.txHash}:${x.logIndex}` === entryId(e));
      return {
        txHash: e.txHash,
        logIndex: e.logIndex,
        from: e.key,
        amount: d?.amount ?? 0n,
        credits: e.credits,
      };
    });

  if (dust.length > 0) {
    const detail = dust
      .map(
        (d) =>
          `${d.txHash.slice(0, 12)}…(raw=${d.amount}, credits=${d.credits})`,
      )
      .join(", ");
    alerts.push(
      `发现 ${dust.length} 笔到账低于最小入账精度，未入队（金额过小，无法换算成 credit）：${detail}`,
    );
  }

  const payableNew = entries.filter(
    (e) => addedIds.has(entryId(e)) && e.credits > 0,
  ).length;
  if (payableNew > queued) {
    alerts.push(
      `本轮新发现 ${payableNew} 笔可入账到账，但队列只新增 ${queued} 条：可能被 inbox 去重或写入失败，请检查 data/credits-inbox.json`,
    );
  }

  if (scan.truncated) {
    alerts.push(
      `扫描未追平链头（本轮扫到 ${scan.scannedTo}，链头 ${scan.latest}），落后过大，下一轮继续追`,
    );
  }

  return {
    scanned: scan.deposits.length,
    added: added.length,
    queued,
    queuedCredits,
    dust,
    fromBlock: scan.fromBlock.toString(),
    scannedTo: scan.scannedTo.toString(),
    latest: scan.latest.toString(),
    pages: scan.pages,
    truncated: scan.truncated,
    alerts,
  };
}

function reportLine(r: TickReport): string {
  const head = `[credit-daemon] ${new Date().toISOString()} 块 ${r.fromBlock}→${r.scannedTo}（链头 ${r.latest}，${r.pages} 页）`;
  if (r.added === 0 && r.queued === 0) {
    return `${head} 无新到账`;
  }
  return (
    `${head} 新到账 ${r.added} 笔，入账队列 +${r.queued} 条` +
    `（+${formatCredits(r.queuedCredits)} credits）`
  );
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
      const report = await tick();
      console.log(reportLine(report));
      for (const a of report.alerts) {
        console.warn(`[credit-daemon][ALERT] ${a}`);
      }
    } catch (err) {
      // 网络抖动/RPC 限流不应让守护进程退出
      console.warn(`[credit-daemon] 本轮失败: ${(err as Error).message}`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  } while (!stopping);
}

// 仅当以脚本方式直接运行时才启动守护进程；被测试/其他模块 import 时不自动运行，
// 避免 import 即触发扫描循环（卡死测试 / 污染环境）。
const isMain =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[credit-daemon] 致命错误:", err);
    process.exit(1);
  });
}
