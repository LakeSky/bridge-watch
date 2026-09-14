import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { LocalBilling } from "./billing.js";

const TEST_DATA_DIR = join(
  process.cwd(),
  "data",
  `__test_billing_${Date.now()}__`,
);

describe("LocalBilling", () => {
  const key1 = "test-key-abc-1";
  const key2 = "test-key-abc-2";
  const addr1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  beforeEach(() => {
    // 确保测试目录干净
    if (existsSync(TEST_DATA_DIR)) {
      const file = join(TEST_DATA_DIR, "billing.json");
      if (existsSync(file)) unlinkSync(file);
      rmdirSync(TEST_DATA_DIR);
    }
  });

  afterEach(() => {
    const file = join(TEST_DATA_DIR, "billing.json");
    if (existsSync(file)) unlinkSync(file);
    if (existsSync(TEST_DATA_DIR)) rmdirSync(TEST_DATA_DIR);
  });

  function createBilling(): LocalBilling {
    return new LocalBilling(TEST_DATA_DIR);
  }

  it("初始余额为 0", () => {
    const billing = createBilling();
    expect(billing.balance(key1)).toBe(0);
  });

  it("seed 设置初始额度", () => {
    const billing = createBilling();
    billing.seed(key1, 1000);
    expect(billing.balance(key1)).toBe(1000);
  });

  it("同一个 key 第二次 seed 不重复加额度（幂等）", () => {
    const billing = createBilling();
    billing.seed(key1, 1000);
    billing.seed(key1, 1000);
    expect(billing.balance(key1)).toBe(1000);
  });

  it("不同 key 独立 seed", () => {
    const billing = createBilling();
    billing.seed(key1, 1000);
    billing.seed(key2, 500);
    expect(billing.balance(key1)).toBe(1000);
    expect(billing.balance(key2)).toBe(500);
  });

  it("credit 充值增加余额", () => {
    const billing = createBilling();
    billing.credit(addr1, 100);
    expect(billing.balance(addr1)).toBe(100);
    billing.credit(addr1, 50);
    expect(billing.balance(addr1)).toBe(150);
  });

  it("charge 成功扣费并返回剩余额度", async () => {
    const billing = createBilling();
    billing.seed(key1, 100);
    const result = await billing.charge(key1, 30);
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(70);
    expect(billing.balance(key1)).toBe(70);
  });

  it("charge 余额不足返回 false", async () => {
    const billing = createBilling();
    billing.seed(key1, 10);
    const result = await billing.charge(key1, 30);
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(10);
    expect(result.reason).toBe("credits exhausted");
    expect(billing.balance(key1)).toBe(10);
  });

  it("charge 扣到 0 也成功", async () => {
    const billing = createBilling();
    billing.seed(key1, 50);
    const result = await billing.charge(key1, 50);
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("known: 未接触过的身份为 false，seed 后为 true", () => {
    const billing = createBilling();
    expect(billing.known("never-seen-key")).toBe(false);
    billing.seed(key1, 100);
    expect(billing.known(key1)).toBe(true);
    expect(billing.known(key1.toUpperCase())).toBe(true);
  });

  it("known: 余额扣到 0 后仍为 true（用于区分 402 与 401）", async () => {
    const billing = createBilling();
    billing.seed(key1, 10);
    await billing.charge(key1, 10);
    expect(billing.balance(key1)).toBe(0);
    expect(billing.known(key1)).toBe(true);
  });

  it("key 大小写不敏感", () => {
    const billing = createBilling();
    billing.seed("Test-Key-ABC", 1000);
    expect(billing.balance("test-key-abc")).toBe(1000);
    expect(billing.balance("TEST-KEY-ABC")).toBe(1000);
  });

  it("地址大小写不敏感", () => {
    const billing = createBilling();
    billing.credit("0xABCDabcdABCDabcdABCDabcdABCDabcdABCDabcd", 200);
    expect(
      billing.balance("0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd"),
    ).toBe(200);
  });

  it("flushSync 强制同步落盘（不抛错）", () => {
    const billing = createBilling();
    billing.seed(key1, 500);
    expect(() => billing.flushSync()).not.toThrow();
    expect(billing.balance(key1)).toBe(500);
  });

  it("持久化后重启仍保留余额", async () => {
    // 第一次实例：seed + 扣费
    const billing1 = createBilling();
    billing1.seed(key1, 1000);
    await billing1.charge(key1, 200);
    billing1.flushSync(); // 强制落盘

    // 第二次实例：从文件加载
    const billing2 = createBilling();
    expect(billing2.balance(key1)).toBe(800);
  });

  it("重启后已 seed 的 key 不会重复 seed", () => {
    const billing1 = createBilling();
    billing1.seed(key1, 1000);
    billing1.flushSync();

    const billing2 = createBilling();
    billing2.seed(key1, 1000); // 第二次启动时的 seed，应跳过
    expect(billing2.balance(key1)).toBe(1000); // 不是 2000
  });
});
