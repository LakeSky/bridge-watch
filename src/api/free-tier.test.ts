import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreeTier, freeTierConfig } from "./free-tier.js";

class FakeBilling {
  private m = new Map<string, number>();
  balance(k: string): number {
    return this.m.get(k.toLowerCase()) ?? 0;
  }
  credit(k: string, n: number): void {
    this.m.set(k.toLowerCase(), this.balance(k) + n);
  }
}

const NO_CREDIT_METHOD = { balance: () => 0 };
const dir = () => mkdtempSync(join(tmpdir(), "bw-freetier-"));
const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("freeTierConfig", () => {
  it("默认每人 10 credits、每日上限 100；非法值回退默认", () => {
    expect(freeTierConfig(env({}))).toEqual({ credits: 10, dailyCap: 100 });
    expect(freeTierConfig(env({ FREE_TIER_CREDITS: "abc" })).credits).toBe(10);
    expect(freeTierConfig(env({ FREE_TIER_CREDITS: "5", FREE_TIER_DAILY_CAP: "20" }))).toEqual({
      credits: 5,
      dailyCap: 20,
    });
  });
});

describe("ensureFreeTier", () => {
  it("新身份首次调用发放额度并落盘", () => {
    const d = dir();
    const b = new FakeBilling();
    const r = ensureFreeTier(b, "0xAaa", d, env({}), Date.now());
    expect(r).toEqual({ granted: 10, reason: "granted" });
    expect(b.balance("0xaaa")).toBe(10);
    const saved = JSON.parse(readFileSync(join(d, "free-tier.json"), "utf-8")) as {
      granted: Record<string, number>;
    };
    expect(Object.keys(saved.granted)).toEqual(["0xaaa"]);
  });

  it("同一身份第二次调用不再发放（防无限免费）", () => {
    const d = dir();
    const b = new FakeBilling();
    ensureFreeTier(b, "0xbbb", d, env({}), Date.now());
    const r2 = ensureFreeTier(b, "0xbbb", d, env({}), Date.now());
    expect(r2).toEqual({ granted: 0, reason: "already-granted" });
    expect(b.balance("0xbbb")).toBe(10);
  });

  it("已有余额的身份不发放（预置 key / 已充值）", () => {
    const d = dir();
    const b = new FakeBilling();
    b.credit("0xccc", 50);
    const r = ensureFreeTier(b, "0xccc", d, env({}), Date.now());
    expect(r.reason).toBe("already-funded");
    expect(b.balance("0xccc")).toBe(50);
  });

  it("超过每日全局上限后停止发放", () => {
    const d = dir();
    const b = new FakeBilling();
    const e = env({ FREE_TIER_CREDITS: "10", FREE_TIER_DAILY_CAP: "15" });
    expect(ensureFreeTier(b, "0xd1", d, e, Date.now()).reason).toBe("granted");
    const r2 = ensureFreeTier(b, "0xd2", d, e, Date.now());
    expect(r2).toEqual({ granted: 0, reason: "daily-cap" });
    expect(b.balance("0xd2")).toBe(0);
  });

  it("FREE_TIER_CREDITS=0 时整体关闭", () => {
    const d = dir();
    const b = new FakeBilling();
    const r = ensureFreeTier(b, "0xeee", d, env({ FREE_TIER_CREDITS: "0" }), Date.now());
    expect(r.reason).toBe("disabled");
    expect(b.balance("0xeee")).toBe(0);
  });

  it("空 key 不发放；billing 无 credit 能力时降级为关闭", () => {
    const d = dir();
    expect(ensureFreeTier(new FakeBilling(), "  ", d, env({}), Date.now()).reason).toBe("empty-key");
    expect(ensureFreeTier(NO_CREDIT_METHOD, "0xfff", d, env({}), Date.now()).reason).toBe("disabled");
  });
});
