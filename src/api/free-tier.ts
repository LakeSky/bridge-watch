/**
 * 首次调用免费额度（free tier）。
 *
 * 目的：付费转化漏斗里最贵的一步是"第一次调用"——要求陌生调用方先打 USDC 再试，
 * 实际上等于没有试用。这里给每个新身份（API key / 付款地址）发放一次性免费额度，
 * 让任何 agent / 开发者可以零成本先跑通一次，再决定是否充值。
 *
 * 安全边界（防止变成无限免费）：
 *   1. 同一 key 只发一次，记录在 data/free-tier.json（持久化，重启不重置）；
 *   2. 每日全局发放上限 FREE_TIER_DAILY_CAP（默认 100 credits ≈ $1），超额即停止发放；
 *   3. FREE_TIER_CREDITS=0 可整体关闭，恢复"必须充值才能调用"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(__dirname, "..", "..", "data");

export interface FreeTierBilling {
  balance(key: string): number;
  /** 可选：BillingProvider 接口本身不含 credit，缺失时视为不支持发放 */
  credit?(key: string, amount: number): void;
}

export interface FreeTierResult {
  granted: number;
  reason: "granted" | "disabled" | "empty-key" | "already-granted" | "daily-cap" | "already-funded";
}

interface FreeTierData {
  /** key → 首次发放时间戳（毫秒） */
  granted: Record<string, number>;
  /** 日期（YYYY-MM-DD，UTC+8）→ 当日已发放 credits */
  byDay: Record<string, number>;
}

export interface FreeTierConfig {
  credits: number;
  dailyCap: number;
}

/** 从环境变量读取配置（默认：每个新身份 10 credits，每日上限 100） */
export function freeTierConfig(env: NodeJS.ProcessEnv = process.env): FreeTierConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  return {
    credits: num(env.FREE_TIER_CREDITS, 10),
    dailyCap: num(env.FREE_TIER_DAILY_CAP, 100),
  };
}

/** 当日日期键（UTC+8） */
function dayKey(ts: number): string {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
}

function load(file: string): FreeTierData {
  if (!existsSync(file)) return { granted: {}, byDay: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<FreeTierData>;
    return { granted: parsed.granted ?? {}, byDay: parsed.byDay ?? {} };
  } catch {
    return { granted: {}, byDay: {} };
  }
}

function save(file: string, data: FreeTierData): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    /* 发放记录写入失败不阻断请求（最坏情况是重复发放一次） */
  }
}

/**
 * 若该身份从未使用过，且当日额度未超上限，则发放一次性免费额度。
 *
 * @param billing  计费实现（需支持 balance / credit）
 * @param key      身份（API key 或付款地址），小写
 * @param dataDir  数据目录（默认项目根 data/）
 * @param env      环境变量（用于读取配置）
 * @param now      当前时间（毫秒，注入便于测试）
 */
export function ensureFreeTier(
  billing: FreeTierBilling,
  key: string,
  dataDir: string = DEFAULT_DATA_DIR,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): FreeTierResult {
  const cfg = freeTierConfig(env);
  if (cfg.credits <= 0) return { granted: 0, reason: "disabled" };
  if (typeof billing.credit !== "function") return { granted: 0, reason: "disabled" };
  const k = (key ?? "").toLowerCase().trim();
  if (!k) return { granted: 0, reason: "empty-key" };

  const file = join(dataDir, "free-tier.json");
  const data = load(file);
  if (data.granted[k]) return { granted: 0, reason: "already-granted" };
  if (billing.balance(k) > 0) {
    // 已有余额（预置 key 或已充值），无需免费额度，但记一笔避免反复检查
    data.granted[k] = now;
    save(file, data);
    return { granted: 0, reason: "already-funded" };
  }

  const day = dayKey(now);
  const used = data.byDay[day] ?? 0;
  if (used + cfg.credits > cfg.dailyCap) return { granted: 0, reason: "daily-cap" };

  billing.credit?.(k, cfg.credits);
  data.granted[k] = now;
  data.byDay[day] = used + cfg.credits;
  save(file, data);
  return { granted: cfg.credits, reason: "granted" };
}
