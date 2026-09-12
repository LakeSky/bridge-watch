/**
 * 计费/额度系统。
 *
 * 两种身份：
 *   1. API key —— 由配置预置额度（seed）；
 *   2. 付款地址 —— 由 USDC 到账充值额度（credit）。
 * 扣费逻辑统一：余额不足返回 402。
 *
 * v0 为内存态（重启清零）；正式版需落盘（SQLite）+ 签名验证付款地址归属。
 */

export interface ChargeResult {
  ok: boolean;
  remaining: number;
  reason?: string;
}

export interface BillingProvider {
  charge(apiKey: string, cost: number): Promise<ChargeResult>;
  balance(key: string): number;
}

export class LocalBilling implements BillingProvider {
  private balances = new Map<string, number>();

  /** 预置额度（给 API key） */
  seed(key: string, credits: number): void {
    this.balances.set(key, credits);
  }

  /** 充值（给付款地址，USDC 到账后换算成 credit） */
  credit(key: string, amount: number): void {
    const cur = this.balances.get(key) ?? 0;
    this.balances.set(key, cur + amount);
  }

  balance(key: string): number {
    return this.balances.get(key) ?? 0;
  }

  async charge(key: string, cost: number): Promise<ChargeResult> {
    const bal = this.balances.get(key) ?? 0;
    if (bal < cost) {
      return { ok: false, remaining: bal, reason: "credits exhausted" };
    }
    this.balances.set(key, bal - cost);
    return { ok: true, remaining: bal - cost };
  }
}

/** 各端点计费单价（credit/次） */
export const ENDPOINT_COST = {
  label: 1,
  explain: 2,
  cluster: 5,
} as const;
