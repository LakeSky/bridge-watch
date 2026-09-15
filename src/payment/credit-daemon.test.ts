import { describe, it, expect, vi, beforeEach } from "vitest";
import { tick } from "./credit-daemon.js";
import { loadConfig } from "../config.js";
import { saveDeposits, loadDeposits } from "./deposits.js";
import { appendInboxDefault, readInbox, type CreditEntry } from "./credit-inbox.js";
import { saveScanCursor, loadScanCursor } from "./scan-cursor.js";
import type { Deposit } from "./deposits.js";

// credit-daemon（收款→自动入账守护进程）是「客户链上付款 → 自动变成可用 credit」的
// 唯一代码路径，是赚钱闭环的临门一脚。本文件锁定 tick() 的编排与修复后的语义：
//   扫描（游标增量）→ upsert deposits → 按 inbox 幂等入队 → 推进游标 → 异常告警。
// 不依赖真实网络/磁盘：链上日志由 fake client 注入，deposits/inbox/游标全部 mock。
//
// 2026-09-15 修复的四项，都在这里各有回归用例：
//   ① 换算不截断（0.005 USDC → 0.5 credit）  ② 入队基准改为 inbox 幂等（历史漏单自动回填）
//   ③ 游标增量扫描（宕机不丢单）              ④ 静默失败变告警（新增/入队数不一致、dust、截断）

const PAYTO = "0x381cdbb664608bf7b1dd4f9403a572c1c57332c2" as `0x${string}`;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
const PAYER = "0xAbC0000000000000000000000000000000000001" as `0x${string}`;

const CONFIG = {
  paymentAddress: PAYTO,
  assetAddress: USDC,
  assetDecimals: 6,
  creditPerUsdc: 100,
  rpcUrl: "http://localhost:8545",
};

const hoisted = vi.hoisted(() => {
  const client = { getBlockNumber: vi.fn(), getLogs: vi.fn() };
  const inbox: CreditEntry[] = [];
  const cursor = { value: null as bigint | null };
  return { client, inbox, cursor };
});

vi.mock("viem", () => ({
  createPublicClient: vi.fn(() => hoisted.client),
  http: vi.fn(() => ({})),
  parseAbiItem: vi.fn(() => ({})),
}));

vi.mock("../config", () => ({
  loadConfig: vi.fn(() => CONFIG),
}));

// 保留真实 scanDeposits/scanDepositsSince/mergeDeposits；loadDeposits 可控、saveDeposits 拦截（不落盘）。
vi.mock("./deposits", async () => {
  const actual = await vi.importActual<typeof import("./deposits.js")>("./deposits.js");
  return {
    ...actual,
    loadDeposits: vi.fn(() => [] as Deposit[]),
    saveDeposits: vi.fn(),
  };
});

// inbox：用内存数组模拟真实的"幂等追加"语义，让 queued / queuedCredits 可被真实计算。
vi.mock("./credit-inbox", async () => {
  const actual = await vi.importActual<typeof import("./credit-inbox.js")>(
    "./credit-inbox.js",
  );
  const id = (e: { txHash: string; logIndex: number }) => `${e.txHash}:${e.logIndex}`;
  return {
    ...actual,
    readInbox: vi.fn(() => hoisted.inbox.slice()),
    appendInboxDefault: vi.fn((entries: CreditEntry[]) => {
      let n = 0;
      for (const e of entries) {
        if (!hoisted.inbox.some((x) => id(x) === id(e))) {
          hoisted.inbox.push(e);
          n++;
        }
      }
      return n;
    }),
  };
});

// 游标：内存变量替身，不碰真实 data/scan-cursor.json
vi.mock("./scan-cursor", () => ({
  loadScanCursor: vi.fn(() => hoisted.cursor.value),
  saveScanCursor: vi.fn((b: bigint) => {
    hoisted.cursor.value = b;
  }),
  clearScanCursor: vi.fn(),
  DEFAULT_CURSOR_FILE: "data/scan-cursor.json",
}));

function makeLog(
  from: string,
  value: bigint,
  txHash: string,
  logIndex: number,
  blockNumber: bigint,
) {
  return {
    address: USDC,
    topics: [] as string[],
    data: "0x",
    args: { from, to: PAYTO, value },
    transactionHash: txHash,
    logIndex,
    blockNumber,
  } as never;
}

const mkDeposit = (
  txHash: `0x${string}`,
  logIndex: number,
  amount: bigint,
): Deposit => ({
  from: PAYER,
  amount,
  txHash,
  logIndex,
  blockNumber: 19_999n,
  ts: 1,
});

/** 取 appendInboxDefault 第 n 次调用的入队条目 */
const queuedEntries = (n = 0) =>
  vi.mocked(appendInboxDefault).mock.calls[n]![0] as CreditEntry[];

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.inbox.length = 0;
  hoisted.cursor.value = null;
  vi.mocked(loadConfig).mockReturnValue(CONFIG as never);
  hoisted.client.getBlockNumber.mockResolvedValue(20_000n);
  hoisted.client.getLogs.mockResolvedValue([]);
  vi.mocked(loadDeposits).mockReturnValue([]);
});

describe("credit-daemon tick · 收款→入账编排", () => {
  it("单笔 1 USDC 到账 → 入账 100 credits 并入队（1 USDC = 100 credits）", async () => {
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 1_000_000n, "0xtx1", 0, 19_999n),
    ]);

    const r = await tick();

    expect(r.added).toBe(1);
    expect(r.queued).toBe(1);
    expect(r.queuedCredits).toBe(100);
    // 落盘合并后的全量（existing 空 + 新增 1）
    expect(saveDeposits).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveDeposits).mock.calls[0]![0] as Deposit[];
    expect(saved).toHaveLength(1);
    // 入队条目：key 小写、credits=100、txHash/logIndex 透传
    const entries = queuedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: PAYER.toLowerCase(),
      credits: 100,
      txHash: "0xtx1",
      logIndex: 0,
    });
    expect(typeof entries[0]!.ts).toBe("number");
  });

  it("【事故回归】0.005 USDC（客户那笔）→ 0.5 credit 正常入队，不再被截断成 0", async () => {
    hoisted.client.getLogs.mockResolvedValue([
      makeLog("0xe3Badbd40000000000000000000000000000fB3", 5_000n, "0x0e3c8b", 0, 19_999n),
    ]);

    const r = await tick();

    expect(r.added).toBe(1);
    expect(r.queued).toBe(1);
    expect(r.queuedCredits).toBe(0.5);
    expect(queuedEntries()[0]!.credits).toBe(0.5);
    expect(r.dust).toHaveLength(0);
    expect(r.alerts).toEqual([]);
  });

  it("无链上到账 → 不入队、不写盘，游标照常推进", async () => {
    const r = await tick();
    expect(r.added).toBe(0);
    expect(r.queued).toBe(0);
    expect(saveDeposits).not.toHaveBeenCalled();
    expect(appendInboxDefault).not.toHaveBeenCalled();
    expect(saveScanCursor).toHaveBeenCalledWith(20_000n);
  });

  it("付款方等于收款地址（自转账）被过滤 → 不入账", async () => {
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYTO, 1_000_000n, "0xself", 0, 19_999n),
    ]);
    const r = await tick();
    expect(r.added).toBe(0);
    expect(appendInboxDefault).not.toHaveBeenCalled();
  });

  it("换算精度：0.5 USDC → 50 credits；2.5 USDC → 250 credits", async () => {
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 500_000n, "0xhalf", 0, 19_999n),
      makeLog(PAYER, 2_500_000n, "0xtwofive", 1, 19_999n),
    ]);
    const r = await tick();
    expect(r.added).toBe(2);
    const byTx = Object.fromEntries(queuedEntries().map((e) => [e.txHash, e.credits]));
    expect(byTx["0xhalf"]).toBe(50);
    expect(byTx["0xtwofive"]).toBe(250);
  });

  it("多笔不同到账全部入账，且 key 均为小写", async () => {
    const payer2 = "0xDeF0000000000000000000000000000000000002" as `0x${string}`;
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 1_000_000n, "0xtx1", 0, 19_999n),
      makeLog(payer2, 2_000_000n, "0xtx2", 0, 19_999n),
    ]);
    const r = await tick();
    expect(r.added).toBe(2);
    expect(queuedEntries().map((e) => e.key)).toEqual([
      PAYER.toLowerCase(),
      payer2.toLowerCase(),
    ]);
    expect(queuedEntries().map((e) => e.credits)).toEqual([100, 200]);
  });

  it("幂等：同一笔到账重复扫描 → 队列 +0 条（不重复给额度）", async () => {
    vi.mocked(loadDeposits).mockReturnValue([mkDeposit("0xtx1", 0, 1_000_000n)]);
    hoisted.inbox.push({
      key: PAYER.toLowerCase(),
      credits: 100,
      txHash: "0xtx1",
      logIndex: 0,
      ts: 1,
    });
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 1_000_000n, "0xtx1", 0, 19_999n),
    ]);

    const r = await tick();

    expect(r.added).toBe(0);
    expect(r.queued).toBe(0);
    expect(r.queuedCredits).toBe(0);
    expect(saveDeposits).not.toHaveBeenCalled(); // 无新增 → 不重复写盘
    expect(hoisted.inbox).toHaveLength(1);
  });
});

describe("credit-daemon tick · 历史漏单回填（本次事故的核心修复）", () => {
  it("deposits 已有 0.005 到账但 inbox 从未收录、本轮链上无新日志 → 仍补齐入队 0.5 credit", async () => {
    vi.mocked(loadDeposits).mockReturnValue([mkDeposit("0x0e3c8b", 0, 5_000n)]);
    hoisted.client.getLogs.mockResolvedValue([]); // 该笔早已滑出回看窗口

    const r = await tick();

    expect(r.added).toBe(0); // 无新增到账
    expect(r.queued).toBe(1); // 但漏单被补入队
    expect(r.queuedCredits).toBe(0.5);
    expect(queuedEntries()[0]).toMatchObject({
      key: PAYER.toLowerCase(),
      credits: 0.5,
      txHash: "0x0e3c8b",
    });
  });

  it("回填同样幂等：连续两轮 tick，第二轮队列 +0", async () => {
    vi.mocked(loadDeposits).mockReturnValue([mkDeposit("0x0e3c8b", 0, 5_000n)]);

    const first = await tick();
    const second = await tick();

    expect(first.queued).toBe(1);
    expect(second.queued).toBe(0);
    expect(second.queuedCredits).toBe(0);
    expect(hoisted.inbox).toHaveLength(1);
  });

  it("历史 dust 到账不重复告警（只对本轮新发现的 dust 告警，避免每轮刷屏）", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ...CONFIG,
      creditPerUsdc: 0.0001, // 1 raw = 1e-8 credit < 1e-6 → dust
    } as never);
    vi.mocked(loadDeposits).mockReturnValue([mkDeposit("0xdust", 0, 1n)]);

    const r = await tick();

    expect(r.queued).toBe(0);
    expect(r.dust).toHaveLength(0); // 非本轮新增
    expect(r.alerts).toEqual([]);
  });
});

describe("credit-daemon tick · 游标增量（宕机不丢单）", () => {
  it("有游标 → 从 cursor+1 扫到链头（不再固定回看 2000 块）", async () => {
    hoisted.cursor.value = 19_000n;
    await tick();
    const arg = hoisted.client.getLogs.mock.calls[0]![0] as {
      fromBlock: bigint;
      toBlock: bigint;
    };
    expect(arg.fromBlock).toBe(19_001n);
    expect(arg.toBlock).toBe(20_000n);
  });

  it("无游标 → 回看 MAX_BLOCK_RANGE 块（首跑场景）", async () => {
    await tick();
    const arg = hoisted.client.getLogs.mock.calls[0]![0] as {
      fromBlock: bigint;
      toBlock: bigint;
    };
    expect(arg.fromBlock).toBe(18_000n);
  });

  it("扫描成功后游标推进到链头；下一轮从新游标继续", async () => {
    await tick();
    expect(saveScanCursor).toHaveBeenLastCalledWith(20_000n);
    expect(loadScanCursor()).toBe(20_000n);
  });

  it("扫描抛错 → 不吞异常（由 main 记录），且不推进游标（避免跳过未扫区间）", async () => {
    hoisted.client.getLogs.mockRejectedValue(new Error("rpc timeout"));
    await expect(tick()).rejects.toThrow("rpc timeout");
    expect(saveScanCursor).not.toHaveBeenCalled();
    expect(saveDeposits).not.toHaveBeenCalled();
  });

  it("落后超一轮扫描上限 → truncated 告警，游标停在已扫完的块", async () => {
    hoisted.cursor.value = 1n;
    hoisted.client.getBlockNumber.mockResolvedValue(100_000n);

    const r = await tick();

    expect(r.truncated).toBe(true);
    expect(r.scannedTo).toBe("40001"); // 20 页 × 2000 块
    expect(saveScanCursor).toHaveBeenCalledWith(40_001n);
    expect(r.alerts.join("\n")).toMatch(/未追平链头/);
  });
});

describe("credit-daemon tick · 静默失败告警", () => {
  it("本轮新发现 dust 到账（换算精度不足）→ 入队 0 条但必须告警", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ...CONFIG,
      creditPerUsdc: 0.0001,
    } as never);
    hoisted.client.getLogs.mockResolvedValue([makeLog(PAYER, 1n, "0xdust", 0, 19_999n)]);

    const r = await tick();

    expect(r.added).toBe(1);
    expect(r.queued).toBe(0);
    expect(r.dust).toHaveLength(1);
    expect(r.dust[0]!.amount).toBe(1n);
    expect(r.dust[0]!.credits).toBe(0);
    expect(r.alerts.join("\n")).toMatch(/低于最小入账精度/);
  });

  it("新到账条数 > 实际入队条数（inbox 写失败/被拒）→ 告警", async () => {
    vi.mocked(appendInboxDefault).mockReturnValue(0); // 模拟写入失败：返回 0 但确实有新到账
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 1_000_000n, "0xtx1", 0, 19_999n),
    ]);

    const r = await tick();

    expect(r.added).toBe(1);
    expect(r.queued).toBe(0);
    expect(r.alerts.join("\n")).toMatch(/队列只新增 0 条/);
  });
});
