/**
 * 到账金额 → credit 的换算（金额精度唯一真源）。
 *
 * 2026-09-15 修复背景：
 *   原实现为 `Number(amount * creditPerUsdc / unit)`，其中 unit = 10^decimals。
 *   对 USDC（6 位小数）× creditPerUsdc=100 而言，这等价于
 *   `credits = floor(amount / 10000)`，即 **小于 0.01 USDC 的到账一律被截断成 0**。
 *   真实案例：客户转账 0.005 USDC（= 0.5 credit），换算结果 0 → 不入队、静默丢失，
 *   客户付了钱却永远拿不到额度，且链路无任何告警。
 *
 * 现行策略（明确的 dust 策略）：
 *   1. 换算保留小数，精度 1e-6 credit（= 1e-8 USDC），不再做整数截断；
 *      creditPerUsdc 允许是小数（如 1.5 credits/USDC），同样按 1e-6 精度换算。
 *   2. 单笔换算结果 < MIN_CREDIT（1e-6 credit）才视为 dust：不入队、但要告警
 *      （避免"静默丢单"，见 credit-daemon 的 [ALERT] 日志）。
 *   3. 使用 BigInt 做整数运算后四舍五入，避免浮点乘法误差。
 *
 * 注意：入队门槛是"credit > 0"，不是"够一次调用"。0.005 USDC → 0.5 credit 会正常入账，
 * 但 0.5 < ENDPOINT_COST.label(1)，客户会收到 402 充值指引，
 * 即【最小可用充值 = 0.01 USDC = 1 credit】（x402 标价同款）。
 */

/** credit 保留的小数位数（1e-6 credit = 1e-8 USDC） */
export const CREDIT_DECIMALS = 6;

/** 小于该值的换算结果视为 dust（不入队，但必须告警） */
export const MIN_CREDIT = 1e-6;

const SCALE = 10n ** BigInt(CREDIT_DECIMALS);
const SCALE_NUM = Number(SCALE);

/** Number 的安全整数上限（超出则 BigInt→Number 会丢精度） */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 把资产原始单位金额换算成 credit（保留小数，四舍五入到 1e-6 credit）。
 *
 * @param amount        链上金额（资产原始单位，如 USDC 6 位小数下的 5000 = 0.005 USDC）
 * @param decimals      资产小数位（USDC = 6）
 * @param creditPerUsdc 每 1 个计价单位（USDC）换算多少 credit
 */
export function rawToCredits(
  amount: bigint,
  decimals: number,
  creditPerUsdc: number,
): number {
  if (amount <= 0n) return 0;
  if (!Number.isFinite(creditPerUsdc) || creditPerUsdc <= 0) return 0;

  // 先把"每 USDC 的 credit 数"放大到 1e-6 精度，全程整数运算
  const perUsdcScaled = BigInt(Math.round(creditPerUsdc * SCALE_NUM));
  if (perUsdcScaled <= 0n) return 0;

  const den = 10n ** BigInt(decimals);
  const num = amount * perUsdcScaled;

  // 四舍五入：q = round(num / den)，单位 1e-6 credit
  const q = (num * 2n + den) / (den * 2n);
  if (q <= 0n) return 0;

  if (q > MAX_SAFE) {
    // 单笔换算超过 9e9 credit（约 9 千万 USDC）在业务上不现实；
    // 真出现时按安全整数截断并告警，避免 Number 精度漂移出静默错账。
    console.warn(
      `[credit-math] 换算结果超出安全整数范围（amount=${amount}），已按上限截断`,
    );
    return Math.floor(Number.MAX_SAFE_INTEGER / SCALE_NUM);
  }

  // 先转 Number 再除回 1e-6 精度，消除二进制浮点尾差（如 0.30000000000000004）
  return Number(q) / SCALE_NUM;
}

/** 是否为 dust（小到无法换算成 credit，需要告警而不是静默丢弃） */
export function isDustCredits(credits: number): boolean {
  return !(credits >= MIN_CREDIT);
}

/** 人类可读的 credit 文本（0.5 → "0.5"，1 → "1"），用于日志/CLI 输出 */
export function formatCredits(credits: number): string {
  if (!Number.isFinite(credits)) return String(credits);
  const trimmed = Number(credits.toFixed(CREDIT_DECIMALS));
  return String(trimmed);
}
