import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendInbox,
  entryId,
  inboxMtimeMs,
  readInbox,
  type CreditEntry,
} from "./credit-inbox.js";

// 用拼接构造测试地址，避免子串替换类脚本误伤
const ADDR_A = "0x" + "a".repeat(40);

const make = (
  txHash: string,
  opts: Partial<CreditEntry> = {},
): CreditEntry => ({
  key: ADDR_A,
  credits: 100,
  txHash,
  logIndex: 0,
  ts: 1_700_000_000_000,
  ...opts,
});

describe("credit-inbox 队列逻辑（付费入账闭环核心）", () => {
  let dir: string;
  const inboxFile = () => join(dir, "credits-inbox.json");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-inbox-qa-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("entryId", () => {
    it("按 txHash:logIndex 拼装唯一 id", () => {
      expect(entryId({ txHash: "0xabc", logIndex: 0 })).toBe("0xabc:0");
      expect(entryId({ txHash: "0xabc", logIndex: 7 })).toBe("0xabc:7");
    });

    it("相同 txHash 不同 logIndex 视为不同条目（去重粒度正确）", () => {
      expect(entryId({ txHash: "0x1", logIndex: 0 })).not.toBe(
        entryId({ txHash: "0x1", logIndex: 1 }),
      );
    });
  });

  describe("readInbox", () => {
    it("文件不存在时返回空数组（不抛错）", () => {
      expect(readInbox(inboxFile())).toEqual([]);
    });

    it("JSON 损坏时降级返回空数组", () => {
      writeFileSync(inboxFile(), "{ not valid json", "utf-8");
      expect(readInbox(inboxFile())).toEqual([]);
    });

    it("JSON 非数组（对象/数字）时降级返回空数组", () => {
      writeFileSync(inboxFile(), JSON.stringify({ foo: "bar" }), "utf-8");
      expect(readInbox(inboxFile())).toEqual([]);
      writeFileSync(inboxFile(), JSON.stringify(42), "utf-8");
      expect(readInbox(inboxFile())).toEqual([]);
    });

    it("过滤字段缺失/类型错误的条目，只保留合法项", () => {
      const bad = JSON.stringify([
        make("0xgood"), // 合法
        { key: ADDR_A, credits: "100", txHash: "0xstr" }, // credits 是字符串 → 过滤
        { key: ADDR_A, credits: 100 }, // 缺 txHash → 过滤
        { credits: 100, txHash: "0xh" }, // 缺 key → 过滤
        null,
        "garbage",
      ]);
      writeFileSync(inboxFile(), bad, "utf-8");
      const got = readInbox(inboxFile());
      expect(got).toHaveLength(1);
      expect(got.some((e) => e.txHash === "0xgood")).toBe(true);
    });

    it("与 appendInbox 往返一致", () => {
      appendInbox([make("0xa"), make("0xb", { key: "0x" + "b".repeat(40) })], inboxFile());
      const got = readInbox(inboxFile());
      expect(got).toHaveLength(2);
      expect(got.map((e) => e.txHash).sort()).toEqual(["0xa", "0xb"]);
    });
  });

  describe("inboxMtimeMs", () => {
    it("文件不存在返回 0", () => {
      expect(inboxMtimeMs(inboxFile())).toBe(0);
    });

    it("存在的文件返回正的时间戳", () => {
      appendInbox([make("0xm")], inboxFile());
      expect(inboxMtimeMs(inboxFile())).toBeGreaterThan(0);
    });
  });

  describe("appendInbox", () => {
    it("写入并返回实际新增条数", () => {
      const n = appendInbox([make("0x1"), make("0x2")], inboxFile());
      expect(n).toBe(2);
      expect(readInbox(inboxFile())).toHaveLength(2);
    });

    it("按 txHash:logIndex 去重，重复条目返回 0", () => {
      expect(appendInbox([make("0x1")], inboxFile())).toBe(1);
      expect(appendInbox([make("0x1")], inboxFile())).toBe(0);
      expect(readInbox(inboxFile())).toHaveLength(1);
    });

    it("同 txHash 不同 logIndex 视为不同条目（不被误去重）", () => {
      appendInbox([make("0x1", { logIndex: 0 })], inboxFile());
      appendInbox([make("0x1", { logIndex: 1 })], inboxFile());
      expect(readInbox(inboxFile())).toHaveLength(2);
    });

    it("credits <= 0 的条目被忽略（不入账 = 客户不会白扣费）", () => {
      appendInbox([make("0x0", { credits: 0 })], inboxFile());
      appendInbox([make("0xneg", { credits: -5 })], inboxFile());
      expect(readInbox(inboxFile())).toHaveLength(0);
    });

    it("与已有条目合并时保留原顺序并追加在末尾", () => {
      appendInbox([make("0xold")], inboxFile());
      appendInbox([make("0xnew")], inboxFile());
      const got = readInbox(inboxFile());
      expect(got.map((e) => e.txHash)).toEqual(["0xold", "0xnew"]);
    });

    it("没有新增时返回 0 且不重复写入（保持幂等，daemon 重扫安全）", () => {
      appendInbox([make("0xx")], inboxFile());
      // 再次追加完全相同的条目：命中去重，返回 0
      expect(appendInbox([make("0xx")], inboxFile())).toBe(0);
      // 队列长度不增长，文件没有被重复写入
      expect(readInbox(inboxFile())).toHaveLength(1);
    });

    it("多条不同新条目全部写入且文件仍是合法 JSON", () => {
      appendInbox(
        [make("0xa"), make("0xb"), make("0xc", { key: "0x" + "c".repeat(40) })],
        inboxFile(),
      );
      const got = readInbox(inboxFile());
      expect(got).toHaveLength(3);
      // 再追加一批混合（含一条重复）只新增 2 条
      const added = appendInbox(
        [make("0xa"), make("0xd"), make("0xe")],
        inboxFile(),
      );
      expect(added).toBe(2);
      expect(readInbox(inboxFile())).toHaveLength(5);
    });
  });
});
