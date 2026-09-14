import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBilling } from "./billing.js";
import { appendInbox, readInbox } from "../payment/credit-inbox.js";
import type { CreditEntry } from "../payment/credit-inbox.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 用拼接构造测试地址，避免子串替换类脚本误伤
const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);
const ADDR_C = "0x" + "c".repeat(40);

/**
 * 到账自动入账（credit inbox）测试。
 * 覆盖：队列消费、换算入账、重复条目幂等、重启后不重复入账。
 */
describe("billing 自动入账（credit inbox）", () => {
  let dir: string;

  const inboxFile = () => join(dir, "credits-inbox.json");

  const mint = (
    txHash: string,
    credits = 100,
    key = ADDR_A,
  ): CreditEntry => ({
    key,
    credits,
    txHash,
    logIndex: 0,
    ts: Date.now(),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-inbox-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("队列有到账时，balance/charge 自动入账（无需重启）", async () => {
    const billing = new LocalBilling(dir);
    expect(billing.balance(ADDR_A)).toBe(0);

    appendInbox([mint("0x1", 100)], inboxFile());
    await sleep(10);

    expect(billing.balance(ADDR_A)).toBe(100);
  });

  it("charge 会先消费队列，余额足够时扣费成功", async () => {
    const billing = new LocalBilling(dir);
    appendInbox([mint("0x2", 5)], inboxFile());
    await sleep(10);

    const r = await billing.charge(ADDR_A, 3);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it("重复扫描同一笔到账不会重复加额度（幂等）", async () => {
    const billing = new LocalBilling(dir);
    appendInbox([mint("0x3", 50)], inboxFile());
    await sleep(10);
    expect(billing.balance(ADDR_A)).toBe(50);

    // daemon 重复追加同一条目：appendInbox 自身去重，返回 0
    expect(appendInbox([mint("0x3", 50)], inboxFile())).toBe(0);
    await sleep(10);
    expect(billing.balance(ADDR_A)).toBe(50);
  });

  it("重启后已入账条目不会再次入账（appliedTxs 持久化）", async () => {
    const first = new LocalBilling(dir);
    appendInbox([mint("0x4", 70)], inboxFile());
    await sleep(10);
    expect(first.balance(ADDR_A)).toBe(70);
    first.flushSync();

    const second = new LocalBilling(dir);
    expect(second.balance(ADDR_A)).toBe(70);
  });

  it("队列文件追加多条时按地址分别入账", async () => {
    const billing = new LocalBilling(dir);
    appendInbox(
      [
        mint("0x5", 10, ADDR_B),
        mint("0x6", 20, ADDR_C),
      ],
      inboxFile(),
    );
    await sleep(10);

    expect(billing.balance(ADDR_B)).toBe(10);
    expect(billing.balance(ADDR_C)).toBe(20);
    expect(readInbox(inboxFile())).toHaveLength(2);
  });

  it("credits <= 0 的条目被忽略", async () => {
    const billing = new LocalBilling(dir);
    appendInbox([mint("0x7", 0)], inboxFile());
    await sleep(10);
    expect(billing.balance(ADDR_A)).toBe(0);
  });
});
