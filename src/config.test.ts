import { describe, it, expect } from "vitest";
import { usdcToRaw } from "./config.js";

/**
 * usdcToRaw 是把"人类可读 USDC 金额"换算成资产原始单位（bigint）的唯一入口，
 * 直接决定大额转出阈值与付款换算精度。用字符串拼接而非浮点乘法，
 * 必须守住「0.1 * 1e6 不会出现 100000.00000000001」这类精度陷阱。
 */
describe("usdcToRaw（金额精度）", () => {
  it("整数无小数 → 右补 6 个零", () => {
    expect(usdcToRaw(1, 6)).toBe(1_000_000n);
  });

  it("0 → 0n", () => {
    expect(usdcToRaw(0, 6)).toBe(0n);
  });

  it("小数位数不足 → 右侧补零对齐 decimals", () => {
    expect(usdcToRaw(0.1, 6)).toBe(100_000n);
  });

  it("精确 6 位小数", () => {
    expect(usdcToRaw(1.5, 6)).toBe(1_500_000n);
  });

  it("避开浮点精度误差：0.1 * 1e6 必须恰好 100000n", () => {
    // 若用 Number 乘法会得 100000.00000000001，这里必须用字符串解析
    expect(usdcToRaw(0.1, 6)).toBe(100_000n);
  });

  it("小数超过 decimals 位 → 按 decimals 截断（非四舍五入）", () => {
    expect(usdcToRaw(1.1234567, 6)).toBe(1_123_456n);
  });

  it("18 位小数资产（如 ETH/WETH 场景）", () => {
    expect(usdcToRaw(2.5, 18)).toBe(2_500000000000000000n);
  });

  it("大额金额仍精确", () => {
    expect(usdcToRaw(100_000, 6)).toBe(100_000_000_000n);
  });

  it("恰好等于 decimals 位宽度的零尾随小数", () => {
    expect(usdcToRaw(1.000000, 6)).toBe(1_000_000n);
  });

  it("返回类型为 bigint（后续 BigInt 运算不会隐式转 Number）", () => {
    expect(usdcToRaw(1, 6)).toBeTypeOf("bigint");
  });
});
