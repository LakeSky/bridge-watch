import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanRange, scanDepositsSince, MAX_BLOCK_RANGE } from "./deposits.js";

/**
 * 扫链分页 / 增量扫描测试。
 *
 * 事故复盘：旧实现每轮固定回看最近 2000 块，宕机超过 ~66 分钟就永久丢单。
 * 新增的 scanDepositsSince + 持久化游标要求：
 *   - 从游标之后扫到链头，落后很多时分页补齐；
 *   - 单轮页数上限触顶时不跳块（scannedTo 只推进到"确实扫完的块"）；
 *   - 已扫到链头时不发无谓 RPC。
 * 这里用 fake client 精确锁死 eth_getLogs 的区间与调用次数（分页边界最容易出错）。
 */

const PAYTO = "0x381cdbb664608bf7b1dd4f9403a572c1c57332c2" as `0x${string}`;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
const PAYER = "0xAbC0000000000000000000000000000000000001" as `0x${string}`;

const hoisted = vi.hoisted(() => {
  const client = { getBlockNumber: vi.fn(), getLogs: vi.fn() };
  return { client };
});

vi.mock("viem", () => ({
  createPublicClient: vi.fn(() => hoisted.client),
  http: vi.fn(() => ({})),
  parseAbiItem: vi.fn(() => ({})),
}));

function makeLog(value: bigint, txHash: string, blockNumber: bigint, logIndex = 0) {
  return {
    address: USDC,
    topics: [] as string[],
    data: "0x",
    args: { from: PAYER, to: PAYTO, value },
    transactionHash: txHash,
    logIndex,
    blockNumber,
  } as never;
}

/** 取第 n 次 getLogs 调用的 {fromBlock, toBlock} */
const rangeOf = (n: number) => {
  const call = hoisted.client.getLogs.mock.calls[n];
  expect(call).toBeDefined();
  return call![0] as { fromBlock: bigint; toBlock: bigint };
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.client.getBlockNumber.mockResolvedValue(20_000n);
  hoisted.client.getLogs.mockResolvedValue([]);
});

describe("scanRange（分页边界）", () => {
  it("区间不足一页 → 单次调用，区间原样", async () => {
    const r = await scanRange(hoisted.client as never, PAYTO, USDC, 100n, 2_000n);
    expect(hoisted.client.getLogs).toHaveBeenCalledTimes(1);
    expect(rangeOf(0)).toMatchObject({ fromBlock: 100n, toBlock: 2_000n });
    expect(r.pages).toBe(1);
    expect(r.scannedTo).toBe(2_000n);
    expect(r.truncated).toBe(false);
  });

  it("恰好一页（MAX_BLOCK_RANGE 块）→ 单次调用", async () => {
    const to = 1n + MAX_BLOCK_RANGE - 1n; // 1..2000
    const r = await scanRange(hoisted.client as never, PAYTO, USDC, 1n, to);
    expect(hoisted.client.getLogs).toHaveBeenCalledTimes(1);
    expect(rangeOf(0)).toMatchObject({ fromBlock: 1n, toBlock: to });
    expect(r.pages).toBe(1);
  });

  it("超一页 → 分两页且区间连续不重叠（2001..3000 落在第二页）", async () => {
    const r = await scanRange(hoisted.client as never, PAYTO, USDC, 1000n, 3_000n);
    expect(hoisted.client.getLogs).toHaveBeenCalledTimes(2);
    expect(rangeOf(0)).toMatchObject({ fromBlock: 1000n, toBlock: 2999n });
    expect(rangeOf(1)).toMatchObject({ fromBlock: 3000n, toBlock: 3_000n });
    expect(r.pages).toBe(2);
    expect(r.scannedTo).toBe(3_000n);
    expect(r.truncated).toBe(false);
  });

  it("页数触顶 → truncated=true，scannedTo 停在已扫完的块（绝不跳块）", async () => {
    const r = await scanRange(hoisted.client as never, PAYTO, USDC, 2n, 100_000n, 2);
    expect(hoisted.client.getLogs).toHaveBeenCalledTimes(2);
    expect(rangeOf(1)).toMatchObject({ fromBlock: 2_002n, toBlock: 4_001n });
    expect(r.truncated).toBe(true);
    expect(r.scannedTo).toBe(4_001n); // 下次从 4002 继续
  });

  it("自转账（from == 收款地址）被过滤", async () => {
    hoisted.client.getLogs.mockResolvedValue([
      {
        address: USDC,
        topics: [],
        data: "0x",
        args: { from: PAYTO, to: PAYTO, value: 1_000_000n },
        transactionHash: "0xself",
        logIndex: 0,
        blockNumber: 1n,
      } as never,
    ]);
    const r = await scanRange(hoisted.client as never, PAYTO, USDC, 1n, 10n);
    expect(r.deposits).toHaveLength(0);
  });

  it("多页结果全部收集，amount 为 bigint", async () => {
    hoisted.client.getLogs
      .mockResolvedValueOnce([makeLog(5_000n, "0xa", 1n)])
      .mockResolvedValueOnce([makeLog(1_000_000n, "0xb", 3_000n)]);
    const r = await scanRange(hoisted.client as never, PAYTO, USDC, 1n, 3_000n);
    expect(r.deposits.map((d) => d.txHash)).toEqual(["0xa", "0xb"]);
    expect(r.deposits[0]!.amount).toBe(5_000n);
  });
});

describe("scanDepositsSince（增量：游标 → 链头）", () => {
  it("无游标 → 退化为回看 MAX_BLOCK_RANGE 块（与旧行为兼容）", async () => {
    const r = await scanDepositsSince(hoisted.client as never, PAYTO, USDC, null);
    expect(r.fromBlock).toBe(18_000n);
    // 18000..20000 共 2001 块 → 按 2000 块切两页
    expect(hoisted.client.getLogs).toHaveBeenCalledTimes(2);
    expect(rangeOf(0)).toMatchObject({ fromBlock: 18_000n, toBlock: 19_999n });
    expect(rangeOf(1)).toMatchObject({ fromBlock: 20_000n, toBlock: 20_000n });
    expect(r.scannedTo).toBe(20_000n);
  });

  it("有游标 → 从 cursor+1 扫到链头（不重复扫已扫过的块）", async () => {
    const r = await scanDepositsSince(hoisted.client as never, PAYTO, USDC, 19_000n);
    expect(r.fromBlock).toBe(19_001n);
    expect(rangeOf(0)).toMatchObject({ fromBlock: 19_001n, toBlock: 20_000n });
    expect(r.scannedTo).toBe(20_000n);
  });

  it("游标落后很多 → 分页补齐，scannedTo 追平链头", async () => {
    hoisted.client.getBlockNumber.mockResolvedValue(5_000n);
    const r = await scanDepositsSince(hoisted.client as never, PAYTO, USDC, 1n);
    // 2..5000 共 4999 块 → 3 页
    expect(hoisted.client.getLogs).toHaveBeenCalledTimes(3);
    expect(r.pages).toBe(3);
    expect(r.scannedTo).toBe(5_000n);
    expect(r.truncated).toBe(false);
  });

  it("游标已达链头 → 不发 RPC，返回空且 scannedTo=链头", async () => {
    const r = await scanDepositsSince(hoisted.client as never, PAYTO, USDC, 20_000n);
    expect(hoisted.client.getLogs).not.toHaveBeenCalled();
    expect(r.deposits).toEqual([]);
    expect(r.pages).toBe(0);
    expect(r.scannedTo).toBe(20_000n);
  });

  it("游标超链头（reorg/回滚）→ 同样不发 RPC，不倒退", async () => {
    const r = await scanDepositsSince(hoisted.client as never, PAYTO, USDC, 30_000n);
    expect(hoisted.client.getLogs).not.toHaveBeenCalled();
    expect(r.scannedTo).toBe(20_000n);
  });

  it("genesis 附近（latest < lookback）→ from 取 0，不会出现负块号", async () => {
    hoisted.client.getBlockNumber.mockResolvedValue(500n);
    const r = await scanDepositsSince(hoisted.client as never, PAYTO, USDC, null);
    expect(r.fromBlock).toBe(0n);
  });
});
