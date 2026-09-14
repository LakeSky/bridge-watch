import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Alert } from "../types.js";

/**
 * 告警历史持久化。
 *
 * 价值：
 *   1. 可回溯：告警触发后不会丢失，可随时查询历史
 *   2. 可统计：误报率、告警频率、规则分布等
 *   3. 可回测：对比"告警后是否真的出事了"，优化规则
 *
 * 存储格式：JSON 数组，按时间升序追加。Week 1–2 用文件即可，
 * 量大后再换 SQLite。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const ALERTS_FILE = join(DATA_DIR, "alerts.json");

/** 单文件最多保存多少条告警，超出截断旧的（防止文件无限增长） */
const MAX_ALERTS = 10_000;

export interface AlertHistoryQuery {
  /** 按地址过滤 */
  address?: string;
  /** 按规则种类过滤 */
  kind?: Alert["kind"];
  /** 按严重程度过滤 */
  severity?: Alert["severity"];
  /** 起始时间戳（毫秒） */
  since?: number;
  /** 最多返回条数 */
  limit?: number;
}

/** 加载历史告警 */
export function loadAlerts(): Alert[] {
  if (!existsSync(ALERTS_FILE)) return [];
  try {
    const raw = readFileSync(ALERTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Alert[];
    if (!Array.isArray(parsed)) return [];
    // JSON 序列化会把 bigint 丢了，这里只存字符串形式的字段
    return parsed;
  } catch (err) {
    console.warn(`[alerts] 历史记录读取失败，忽略: ${(err as Error).message}`);
    return [];
  }
}

/** 追加一条告警到历史记录（异步落盘，不阻塞主流程） */
export function appendAlert(alert: Alert): void {
  const all = loadAlerts();
  all.push(alert);
  // 超出上限则截断旧记录
  if (all.length > MAX_ALERTS) {
    all.splice(0, all.length - MAX_ALERTS);
  }
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ALERTS_FILE, JSON.stringify(all, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[alerts] 历史记录写入失败: ${(err as Error).message}`);
  }
}

/** 查询历史告警（按条件过滤，按时间倒序返回） */
export function queryAlerts(query: AlertHistoryQuery = {}): Alert[] {
  const all = loadAlerts();
  let filtered = all;

  if (query.address) {
    const addr = query.address.toLowerCase();
    filtered = filtered.filter((a) => a.address.toLowerCase() === addr);
  }
  if (query.kind) {
    filtered = filtered.filter((a) => a.kind === query.kind);
  }
  if (query.severity) {
    filtered = filtered.filter((a) => a.severity === query.severity);
  }
  if (query.since) {
    filtered = filtered.filter((a) => a.ts >= query.since!);
  }

  // 按时间倒序
  filtered = [...filtered].sort((a, b) => b.ts - a.ts);

  if (query.limit && query.limit > 0) {
    filtered = filtered.slice(0, query.limit);
  }

  return filtered;
}

/** 获取告警统计概览 */
export function getAlertStats(sinceMs?: number): {
  total: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
  byAddress: Record<string, number>;
  latestTs: number | null;
} {
  const alerts = sinceMs ? queryAlerts({ since: sinceMs }) : loadAlerts();
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byAddress: Record<string, number> = {};
  let latestTs: number | null = null;

  for (const a of alerts) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
    byAddress[a.address] = (byAddress[a.address] ?? 0) + 1;
    if (latestTs === null || a.ts > latestTs) latestTs = a.ts;
  }

  return {
    total: alerts.length,
    byKind,
    bySeverity,
    byAddress,
    latestTs,
  };
}
