import { describe, it, expect, vi, beforeEach } from "vitest";
import { tick } from "./credit-daemon.js";
import { saveDeposits, loadDeposits } from "./deposits.js";
import { appendInboxDefault, type CreditEntry } from "./credit-inbox.js";
import type { Deposit } from "./deposits.js";

// credit-daemon（收款→自动入账守护进程）此前零测试覆盖。
// 它是「客户链上付款 → 自动变成可用 credit」唯一代码路径，是赚钱闭环的临门一脚。
// 本测试锁定 tick() 的编排 + 换算逻辑：扫描 → 合并去重 → 落盘 → 入队。
// 不依赖真实网络/磁盘：链上日志由 fake client 注入，saveDeposits/appendInboxDefault 用 spy 拦截。
// scanDeposits / mergeDeposits 走真实实现（验证 getLogs→toDeposit→self-pay 过滤→去重 全链路）。

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

// viem 被整体 mock：createPublicClient 返回可控 fake client；
// 同时提供 parseAbiItem（deposits.ts 顶层调用）与 http，避免 importActual 时崩溃。
const hoisted = vi.hoisted(() => {
  const client = {
    getBlockNumber: vi.fn(),
    getLogs: vi.fn(),
  };
  return { client };
});

vi.mock("viem", () => ({
  createPublicClient: vi.fn(() => hoisted.client),
  http: vi.fn(() => ({})),
  parseAbiItem: vi.fn(() => ({})),
}));

vi.mock("../config", () => ({
  loadConfig: vi.fn(() => CONFIG),
}));

// 保留真实 scanDeposits / mergeDeposits；loadDeposits 可控、saveDeposits 拦截（不落盘）。
vi.mock("./deposits", async () => {
  const actual = await vi.importActual<typeof import("./deposits.js")>("./deposits.js");
  return {
    ...actual,
    loadDeposits: vi.fn(() => [] as Deposit[]),
    saveDeposits: vi.fn(),
  };
});

vi.mock("./credit-inbox", async () => {
  const actual = await vi.importActual<typeof import("./credit-inbox.js")>("./credit-inbox.js");
  return {
    ...actual,
    appendInboxDefault: vi.fn(),
  };
});

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

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.client.getBlockNumber.mockResolvedValue(20_000n);
  hoisted.client.getLogs.mockResolvedValue([]);
  vi.mocked(loadDeposits).mockReturnValue([]);
});

describe("credit-daemon tick · 收款→入账编排", () => {
  it("单笔 1 USDC 到账 → 入账 100 credits 并入队（1 USDC = 100 credits）", async () => {
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 1_000_000n, "0xtx1", 0, 19_999n),
    ]);

    const added = await tick();

    expect(added).toBe(1);
    // 落盘合并后的全量（existing 空 + 新增 1）
    expect(saveDeposits).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveDeposits).mock.calls[0]![0] as Deposit[];
    expect(saved).toHaveLength(1);
    // 入队条目：key 小写、credits=100、txHash/logIndex 透传
    expect(appendInboxDefault).toHaveBeenCalledTimes(1);
    const entries = vi.mocked(appendInboxDefault).mock.calls[0]![0] as CreditEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: PAYER.toLowerCase(),
      credits: 100,
      txHash: "0xtx1",
      logIndex: 0,
    });
    expect(typeof entries[0]!.ts).toBe("number");
  });

  it("无链上到账 → 返回 0 且不写盘、不入队", async () => {
    hoisted.client.getLogs.mockResolvedValue([]);
    const added = await tick();
    expect(added).toBe(0);
    expect(saveDeposits).not.toHaveBeenCalled();
    expect(appendInboxDefault).not.toHaveBeenCalled();
  });

  it("付款方等于收款地址（自转账）被过滤 → 不入账", async () => {
    // scanDeposits 会过滤 from === paymentAddress 的日志
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYTO, 1_000_000n, "0xself", 0, 19_999n),
    ]);
    const added = await tick();
    expect(added).toBe(0);
    expect(appendInboxDefault).not.toHaveBeenCalled();
  });

  it("换算精度：0.5 USDC → 50 credits；2.5 USDC → 250 credits", async () => {
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 500_000n, "0xhalf", 0, 19_999n),
      makeLog(PAYER, 2_500_000n, "0xtwofive", 1, 19_999n),
    ]);
    const added = await tick();
    expect(added).toBe(2);
    const entries = vi.mocked(appendInboxDefault).mock.calls[0]![0] as CreditEntry[];
    const byTx = Object.fromEntries(entries.map((e) => [e.txHash, e.credits]));
    expect(byTx["0xhalf"]).toBe(50);
    expect(byTx["0xtwofive"]).toBe(250);
  });

  it("幂等：已存在的到账（同 txHash:logIndex）不再重复入账", async () => {
    const existing: Deposit = {
      from: PAYER,
      amount: 1_000_000n,
      txHash: "0xtx1",
      logIndex: 0,
      blockNumber: 19_999n,
      ts: 1,
    };
    vi.mocked(loadDeposits).mockReturnValue([existing]);
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 1_000_000n, "0xtx1", 0, 19_999n),
    ]);
    const added = await tick();
    expect(added).toBe(0);
    // 无新增 → tick 在 save 之前就 return，避免重复写盘/重复入账
    expect(saveDeposits).not.toHaveBeenCalled();
    expect(appendInboxDefault).not.toHaveBeenCalled();
  });

  it("多笔不同到账全部入账，且 key 均为小写", async () => {
    const payer2 = "0xDeF0000000000000000000000000000000000002" as `0x${string}`;
    hoisted.client.getLogs.mockResolvedValue([
      makeLog(PAYER, 1_000_000n, "0xtx1", 0, 19_999n),
      makeLog(payer2, 2_000_000n, "0xtx2", 0, 19_999n),
    ]);
    const added = await tick();
    expect(added).toBe(2);
    const entries = vi.mocked(appendInboxDefault).mock.calls[0]![0] as CreditEntry[];
    expect(entries.map((e) => e.key)).toEqual([
      PAYER.toLowerCase(),
      payer2.toLowerCase(),
    ]);
    expect(entries.map((e) => e.credits)).toEqual([100, 200]);
  });
});
