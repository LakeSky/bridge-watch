import { describe, it, expect, vi } from "vitest";
import type { PublicClient, Log } from "viem";
import { clusterByFunder } from "./cluster.js";

// 独特测试地址（合法十六进制，但模式罕见，避免与 10 万+ 真实标签冲突）
const FUNDER = "0xa11ce0000000000000000000000000000000a11c" as `0x${string}`;
const ASSET = "0xc0ffee254729296a45a3885639ac7e10f9d54979" as `0x${string}`;
const A = "0x00000000000000000000000000000000000000a1" as `0x${string}`;
const B = "0x00000000000000000000000000000000000000b2" as `0x${string}`;
const C = "0x00000000000000000000000000000000000000c3" as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

function makeTransferLog(to: `0x${string}`): Log {
  // cluster.ts 只读取 log.args.to，其余字段非必需，用最小对象即可
  return { args: { from: FUNDER, to, value: 1n } } as unknown as Log;
}

function makeClient(opts: { latest?: bigint; logs?: Log[] }) {
  let lastGetLogsArgs: any = null;
  const getBlockNumber = vi.fn(async () => opts.latest ?? 5000n);
  const getLogs = vi.fn(async (params: any) => {
    lastGetLogsArgs = params;
    return opts.logs ?? [];
  });
  const client = { getBlockNumber, getLogs } as unknown as PublicClient;
  return { client, getBlockNumber, getLogs, getLastGetLogsArgs: () => lastGetLogsArgs };
}

describe("clusterByFunder", () => {
  describe("聚类判定（默认 minMembers=3）", () => {
    it("没有任何转出记录 → 不是聚类", async () => {
      const { client } = makeClient({ latest: 5000n, logs: [] });
      const res = await clusterByFunder(client, FUNDER, ASSET);
      expect(res.members).toEqual([]);
      expect(res.confidence).toBe(0);
      expect(res.reason).toContain("0"); // 0 个被资助地址
    });

    it("只资助 1 个地址 → 成员数 2 < 3，仍不是聚类", async () => {
      const { client } = makeClient({ latest: 5000n, logs: [makeTransferLog(A)] });
      const res = await clusterByFunder(client, FUNDER, ASSET);
      expect(res.members).toEqual([]);
      expect(res.confidence).toBe(0);
    });

    it("资助 2 个地址 → 成员数 3 >= 3，判定为聚类", async () => {
      const { client } = makeClient({
        latest: 5000n,
        logs: [makeTransferLog(A), makeTransferLog(B)],
      });
      const res = await clusterByFunder(client, FUNDER, ASSET);
      expect(res.members).toHaveLength(3);
      expect(res.members[0]).toBe(FUNDER);
      expect(res.members).toContain(A);
      expect(res.members).toContain(B);
      expect(res.confidence).toBe(0.4);
      expect(res.reason).toContain("2"); // 2 个被资助地址
    });

    it("聚类 reason 包含 funder 与资助数量", async () => {
      const { client } = makeClient({
        latest: 5000n,
        logs: [makeTransferLog(A), makeTransferLog(B)],
      });
      const res = await clusterByFunder(client, FUNDER, ASSET);
      expect(res.reason).toContain(FUNDER.toLowerCase());
    });
  });

  describe("噪声过滤", () => {
    it("自转账（to == funder）被排除", async () => {
      const { client } = makeClient({
        latest: 5000n,
        logs: [makeTransferLog(FUNDER)],
      });
      const res = await clusterByFunder(client, FUNDER, ASSET);
      expect(res.members).toEqual([]);
    });

    it("大小写不同的自转账也被排除", async () => {
      const { client } = makeClient({
        latest: 5000n,
        logs: [makeTransferLog(FUNDER.toUpperCase() as `0x${string}`)],
      });
      const res = await clusterByFunder(client, FUNDER, ASSET);
      expect(res.members).toEqual([]);
    });

    it("转入零地址被排除", async () => {
      const { client } = makeClient({
        latest: 5000n,
        // 只有零地址 + 一笔真实地址；真实地址单独不足以成簇
        logs: [makeTransferLog(ZERO), makeTransferLog(A)],
      });
      const res = await clusterByFunder(client, FUNDER, ASSET);
      expect(res.members).toEqual([]);
      expect(res.reason).toContain("1"); // 仅 1 个有效被资助地址
    });
  });

  describe("去重", () => {
    it("同一收款地址出现多次只计为一个成员", async () => {
      const { client } = makeClient({
        latest: 5000n,
        logs: [makeTransferLog(A), makeTransferLog(A), makeTransferLog(B)],
      });
      // minMembers=2 便于验证去重后的成员集合
      const res = await clusterByFunder(client, FUNDER, ASSET, { minMembers: 2 });
      expect(res.members).toHaveLength(3); // funder + A + B
      expect(res.members.filter((m) => m === A)).toHaveLength(1);
      expect(res.confidence).toBe(0.4);
    });
  });

  describe("扫描窗口（windowBlocks）", () => {
    it("latest > windowBlocks 时 fromBlock = latest - windowBlocks", async () => {
      const { client, getLastGetLogsArgs } = makeClient({ latest: 5000n, logs: [] });
      await clusterByFunder(client, FUNDER, ASSET, { windowBlocks: 1000n });
      const call = getLastGetLogsArgs();
      expect(call.fromBlock).toBe(4000n);
      expect(call.toBlock).toBe(5000n);
    });

    it("latest < windowBlocks 时 fromBlock 回退为 0", async () => {
      const { client, getLastGetLogsArgs } = makeClient({ latest: 500n, logs: [] });
      await clusterByFunder(client, FUNDER, ASSET, { windowBlocks: 1000n });
      const call = getLastGetLogsArgs();
      expect(call.fromBlock).toBe(0n);
      expect(call.toBlock).toBe(500n);
    });
  });

  describe("getLogs 入参正确性", () => {
    it("按 assetAddress 与 funder 过滤，且携带 toBlock", async () => {
      const { client, getLastGetLogsArgs } = makeClient({
        latest: 9000n,
        logs: [makeTransferLog(A), makeTransferLog(B), makeTransferLog(C)],
      });
      await clusterByFunder(client, FUNDER, ASSET, { minMembers: 2 });
      const call = getLastGetLogsArgs();
      expect(call.address).toBe(ASSET);
      expect(call.args.from).toBe(FUNDER);
      expect(call.toBlock).toBe(9000n);
    });
  });

  describe("自定义 minMembers", () => {
    it("minMembers=2 时资助 1 个地址即判定为聚类", async () => {
      const { client } = makeClient({ latest: 5000n, logs: [makeTransferLog(A)] });
      const res = await clusterByFunder(client, FUNDER, ASSET, { minMembers: 2 });
      expect(res.members).toHaveLength(2);
      expect(res.members).toContain(FUNDER);
      expect(res.members).toContain(A);
      expect(res.confidence).toBe(0.4);
    });
  });
});
