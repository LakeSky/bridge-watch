import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// 隔离 deposits.ts 对真实 data/deposits.json 的读写，避免污染护城河资产与磁盘。
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { mergeDeposits, loadDeposits, saveDeposits } from "./deposits.js";

const A = "0x" + "a".repeat(40);
const mk = (
  txHash: string,
  logIndex: number,
  amount = 1n,
): import("./deposits.js").Deposit => ({
  from: A as `0x${string}`,
  amount,
  txHash: txHash as `0x${string}`,
  logIndex,
  blockNumber: 1n,
  ts: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mergeDeposits（到账去重，充值不重复计费的基线）", () => {
  it("existing 为空、incoming 有 N 笔 → added=N、all=N", () => {
    const incoming = [mk("0x1", 0), mk("0x2", 1)];
    const { all, added } = mergeDeposits([], incoming);
    expect(added).toHaveLength(2);
    expect(all).toHaveLength(2);
    expect(added).toEqual(incoming);
  });

  it("incoming 为空 → added=[]、all 保持 existing 不变", () => {
    const existing = [mk("0x1", 0, 100n)];
    const { all, added } = mergeDeposits(existing, []);
    expect(added).toEqual([]);
    expect(all).toEqual(existing);
  });

  it("incoming 与 existing 完全重复 → added=[]", () => {
    const existing = [mk("0x1", 0, 100n), mk("0x2", 1, 200n)];
    const incoming = [mk("0x1", 0, 100n), mk("0x2", 1, 200n)];
    const { all, added } = mergeDeposits(existing, incoming);
    expect(added).toEqual([]);
    expect(all).toHaveLength(2);
  });

  it("部分重叠 → added 只含真正新增的条目", () => {
    const existing = [mk("0x1", 0, 100n)];
    const incoming = [mk("0x1", 0, 100n), mk("0x2", 1, 200n)];
    const { all, added } = mergeDeposits(existing, incoming);
    expect(added).toHaveLength(1);
    expect(added[0]!.txHash).toBe("0x2");
    expect(all).toHaveLength(2);
  });

  it("incoming 内部存在重复 key → 只计一次（去重粒度 txHash:logIndex）", () => {
    const incoming = [mk("0x1", 0, 100n), mk("0x1", 0, 999n)];
    const { all, added } = mergeDeposits([], incoming);
    expect(added).toHaveLength(1);
    expect(all).toHaveLength(1);
    expect(all[0]!.amount).toBe(100n); // 首次出现的为准
  });

  it("不同 txHash 同 logIndex 视为不同条目", () => {
    const { added } = mergeDeposits([], [mk("0x1", 5), mk("0x2", 5)]);
    expect(added).toHaveLength(2);
  });

  it("保留 existing 顺序并在末尾追加新增", () => {
    const existing = [mk("0x1", 0), mk("0x2", 0)];
    const { all } = mergeDeposits(existing, [mk("0x3", 0)]);
    expect(all.map((d) => d.txHash)).toEqual(["0x1", "0x2", "0x3"]);
  });
});

describe("loadDeposits（持久化到账读取 + 降级）", () => {
  it("文件缺失 → 返回 []（不抛错、不读盘内容）", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadDeposits()).toEqual([]);
  });

  it("JSON 损坏 → 降级返回 []（不抛错）", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not json{{");
    expect(loadDeposits()).toEqual([]);
  });

  it("合法数组 → 反序列化且 amount 由字符串还原为 bigint", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify([
        {
          from: A,
          amount: "100000",
          txHash: "0xabc",
          logIndex: 0,
          blockNumber: 100,
          ts: 1,
        },
      ]),
    );
    const got = loadDeposits();
    expect(got).toHaveLength(1);
    expect(got[0]!.amount).toBe(100000n);
    expect(typeof got[0]!.amount).toBe("bigint");
  });

  it("JSON 为非数组对象 → 降级返回 []", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ foo: 1 }));
    expect(loadDeposits()).toEqual([]);
  });
});

describe("saveDeposits（落盘序列化）", () => {
  it("bigint 字段（amount/blockNumber）序列化为字符串，且不抛错", () => {
    // 回归保护：此前 spread 含 blockNumber(bigint) 会导致 JSON.stringify 抛
    // "Do not know how to serialize a BigInt"，使存款文件永远写不出。
    expect(() => saveDeposits([mk("0x1", 0, 100000n)])).not.toThrow();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeFileSync).mock.calls[0];
    expect(call).toBeDefined();
    const payload = call![1] as string;
    const parsed = JSON.parse(payload) as { amount: string; blockNumber: string }[];
    expect(parsed[0]!.amount).toBe("100000");
    expect(parsed[0]!.blockNumber).toBe("1"); // bigint → 字符串
  });
});
