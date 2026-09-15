import { describe, it, expect } from "vitest";
import {
  rawToCredits,
  isDustCredits,
  formatCredits,
  MIN_CREDIT,
} from "./credit-math.js";

/**
 * 换算精度回归保护。
 *
 * 事故复盘：客户转账 0.005 USDC（raw=5000，6 位小数，creditPerUsdc=100），
 * 原实现 `Number((amount * creditPerUsdc) / 10^decimals)` 做整数除法：
 *   5000 * 100 / 1000000 = 0 → 换算成 0 credit → 被 appendInbox 过滤 → 不入队、不入账、无告警。
 * 用户"付了钱却没到账"，且日志上看不出任何异常。本文件锁死"不再截断成 0"。
 */

const USDC_DECIMALS = 6;
const PER_USDC = 100;

describe("rawToCredits（到账换算：保留小数，禁止整数截断）", () => {
  it("【事故回归】0.005 USDC → 0.5 credit（修复前为 0）", () => {
    expect(rawToCredits(5000n, USDC_DECIMALS, PER_USDC)).toBe(0.5);
  });

  it("1 USDC → 100 credits（正常充值不受影响）", () => {
    expect(rawToCredits(1_000_000n, USDC_DECIMALS, PER_USDC)).toBe(100);
  });

  it("0.01 USDC → 1 credit（x402 单次调用标价，即最小可用充值）", () => {
    expect(rawToCredits(10_000n, USDC_DECIMALS, PER_USDC)).toBe(1);
  });

  it("0.000001 USDC（最小可转账单位 raw=1）→ 0.0001 credit", () => {
    expect(rawToCredits(1n, USDC_DECIMALS, PER_USDC)).toBe(0.0001);
  });

  it("0.123456 USDC → 12.3456 credits（逐位精确，无浮点尾差）", () => {
    expect(rawToCredits(123_456n, USDC_DECIMALS, PER_USDC)).toBe(12.3456);
  });

  it("小数 creditPerUsdc（1.5 credits/USDC）：0.5 USDC → 0.75 credit", () => {
    expect(rawToCredits(500_000n, USDC_DECIMALS, 1.5)).toBe(0.75);
  });

  it("大额：1234.56789 USDC → 123456.789 credits", () => {
    expect(rawToCredits(1_234_567_890n, USDC_DECIMALS, PER_USDC)).toBe(123456.789);
  });

  it("多笔小额累加不丢精度：3 × 0.001 USDC = 0.3 credit", () => {
    const one = rawToCredits(1_000n, USDC_DECIMALS, PER_USDC);
    expect(one).toBe(0.1);
    const sum = Number((one + one + one).toFixed(6));
    expect(sum).toBe(0.3);
  });

  it("非法/边界输入返回 0：amount=0、负数、creditPerUsdc=0/NaN", () => {
    expect(rawToCredits(0n, USDC_DECIMALS, PER_USDC)).toBe(0);
    expect(rawToCredits(-1n, USDC_DECIMALS, PER_USDC)).toBe(0);
    expect(rawToCredits(1_000_000n, USDC_DECIMALS, 0)).toBe(0);
    expect(rawToCredits(1_000_000n, USDC_DECIMALS, NaN)).toBe(0);
  });

  it("不同小数位资产（18 位）同样正确：1e18 raw = 1 计价单位 → 100 credits", () => {
    expect(rawToCredits(10n ** 18n, 18, PER_USDC)).toBe(100);
  });
});

describe("isDustCredits（明确 dust 策略：低于 1e-6 credit 才丢弃，且必须告警）", () => {
  it("0 → dust", () => {
    expect(isDustCredits(0)).toBe(true);
  });

  it("刚好等于阈值 1e-6 → 不算 dust（可入队）", () => {
    expect(isDustCredits(MIN_CREDIT)).toBe(false);
  });

  it("低于阈值（1e-7）→ dust", () => {
    expect(isDustCredits(1e-7)).toBe(true);
  });

  it("0.5 credit（客户那笔 0.005 USDC）→ 不是 dust，必须入队", () => {
    expect(isDustCredits(0.5)).toBe(false);
  });

  it("极微小 creditPerUsdc 下 1 raw 会落入 dust（低配换算才可能触发）", () => {
    const c = rawToCredits(1n, USDC_DECIMALS, 0.0001);
    expect(c).toBe(0);
    expect(isDustCredits(c)).toBe(true);
  });
});

describe("formatCredits（日志展示）", () => {
  it("整数与小数都按 1e-6 精度截齐", () => {
    expect(formatCredits(100)).toBe("100");
    expect(formatCredits(0.5)).toBe("0.5");
    expect(formatCredits(0.30000000000000004)).toBe("0.3");
  });
});
