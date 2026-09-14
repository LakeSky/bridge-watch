import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { entryId, inboxMtimeMs, readInbox } from "../payment/credit-inbox.js";

/**
 * 计费/额度系统。
 *
 * 两种身份：
 *   1. API key —— 由配置预置额度（seed）；
 *   2. 付款地址 —— 由 USDC 到账充值额度（credit）。
 * 扣费逻辑统一：余额不足返回 402。
 *
 * v1：JSON 文件持久化（重启不清零）；
 * v2：SQLite + 签名验证付款地址归属。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(__dirname, "..", "..", "data");

export interface ChargeResult {
  ok: boolean;
  remaining: number;
  reason?: string;
}

export interface BillingProvider {
  charge(apiKey: string, cost: number): Promise<ChargeResult>;
  balance(key: string): number;
}

interface BillingData {
  balances: Record<string, number>;
  /** 已 seed 过的 key 集合，避免重复 seed（配置重启后也不会重复加额度） */
  seededKeys: string[];
  /** 已入账的到账条目 id（txHash:logIndex），保证重复扫描不会重复加额度 */
  appliedTxs?: string[];
}

export class LocalBilling implements BillingProvider {
  private data: BillingData;
  private dataDir: string;
  private billingFile: string;
  /** 防抖写入计时器 */
  private writeTimer: NodeJS.Timeout | null = null;
  /** 上次消费到账队列时的文件 mtime（毫秒），用于判断队列是否有新内容 */
  private lastInboxMtime = 0;
  /** 已入账条目集合（appliedTxs 的查重副本） */
  private appliedSet: Set<string> = new Set();

  /**
   * @param dataDir 数据目录（可选，默认 data/，测试时可传入临时目录）
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? DEFAULT_DATA_DIR;
    this.billingFile = join(this.dataDir, "billing.json");
    this.data = this.load();
    this.appliedSet = new Set(this.data.appliedTxs ?? []);
  }

  private load(): BillingData {
    if (!existsSync(this.billingFile)) {
      return { balances: {}, seededKeys: [] };
    }
    try {
      const raw = readFileSync(this.billingFile, "utf-8");
      const parsed = JSON.parse(raw) as Partial<BillingData>;
      return {
        balances: parsed.balances ?? {},
        seededKeys: Array.isArray(parsed.seededKeys) ? parsed.seededKeys : [],
        appliedTxs: Array.isArray(parsed.appliedTxs) ? parsed.appliedTxs : [],
      };
    } catch (err) {
      console.warn(`[billing] 持久化文件读取失败，从零开始: ${(err as Error).message}`);
      return { balances: {}, seededKeys: [] };
    }
  }

  /** 序列化账本（含已入账条目，供落盘） */
  private serialize(): string {
    return JSON.stringify(
      { ...this.data, appliedTxs: [...this.appliedSet] },
      null,
      2,
    );
  }

  /**
   * 消费到账队列（data/credits-inbox.json）。
   *
   * 由 credit-daemon（独立进程）扫描链上到账后追加条目；本进程只读该文件，
   * 已处理条目记在 appliedTxs 里，因此不需要加锁、也不会与 daemon 互相覆盖。
   * 通过比较文件 mtime 判断"有没有新内容"，无新内容时只是一次 stat 调用。
   */
  private consumeInbox(): void {
    const inboxFile = join(this.dataDir, "credits-inbox.json");
    const mtime = inboxMtimeMs(inboxFile);
    if (mtime === 0 || mtime <= this.lastInboxMtime) return;
    this.lastInboxMtime = mtime;

    const entries = readInbox(inboxFile);
    let changed = false;
    for (const e of entries) {
      const id = entryId(e);
      if (this.appliedSet.has(id)) continue;
      if (!(e.credits > 0)) continue;
      const k = e.key.toLowerCase();
      this.data.balances[k] = (this.data.balances[k] ?? 0) + e.credits;
      this.appliedSet.add(id);
      changed = true;
      console.log(
        `[billing] 自动入账 +${e.credits} credits → ${k}（tx ${e.txHash.slice(0, 12)}…）`,
      );
    }
    if (changed) this.scheduleSave();
  }

  /** 异步落盘（防抖，避免频繁写磁盘） */
  private scheduleSave(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      try {
        mkdirSync(this.dataDir, { recursive: true });
        writeFileSync(this.billingFile, this.serialize(), "utf-8");
      } catch (err) {
        console.warn(`[billing] 持久化写入失败: ${(err as Error).message}`);
      }
    }, 500);
  }

  /**
   * 预置额度（给 API key）。
   * 同一个 key 只会 seed 一次（重启后如果已 seed 过则跳过），
   * 避免每次重启都把额度重置回初始值（用户用掉的部分应该保留）。
   * 如果 key 之前不存在（新配置的 key），则正常 seed。
   */
  seed(key: string, credits: number): void {
    const k = key.toLowerCase();
    if (this.data.seededKeys.includes(k)) return; // 已 seed 过，跳过
    if (this.data.balances[k] === undefined) {
      this.data.balances[k] = credits;
    }
    this.data.seededKeys.push(k);
    this.scheduleSave();
  }

  /** 充值（给付款地址，USDC 到账后换算成 credit） */
  credit(key: string, amount: number): void {
    const k = key.toLowerCase();
    const cur = this.data.balances[k] ?? 0;
    this.data.balances[k] = cur + amount;
    this.scheduleSave();
  }

  balance(key: string): number {
    this.consumeInbox();
    return this.data.balances[key.toLowerCase()] ?? 0;
  }

  async charge(key: string, cost: number): Promise<ChargeResult> {
    this.consumeInbox();
    const k = key.toLowerCase();
    const bal = this.data.balances[k] ?? 0;
    if (bal < cost) {
      return { ok: false, remaining: bal, reason: "credits exhausted" };
    }
    const newBal = bal - cost;
    this.data.balances[k] = newBal;
    this.scheduleSave();
    return { ok: true, remaining: newBal };
  }

  /** 手动强制落盘（用于优雅退出） */
  flushSync(): void {
    this.consumeInbox();
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.billingFile, this.serialize(), "utf-8");
    } catch (err) {
      console.warn(`[billing] 强制落盘失败: ${(err as Error).message}`);
    }
  }
}

/** 各端点计费单价（credit/次） */
export const ENDPOINT_COST = {
  label: 1,
  explain: 2,
  cluster: 5,
  alerts: 1,
  alertStats: 1,
  track: 3,
} as const;
