/**
 * 请求访问日志中间件（v5 新增，2026-09-14；v6 接通并支持注入目录）。
 *
 * 目的：让"到底有没有人访问/调用"变成可测量的事实，
 * 追加写入 data/access.jsonl（每行一个 JSON），失败不影响主流程。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, "..", "..", "data");
export const ACCESS_LOG_FILE = join(DATA_DIR, "access.jsonl");

/** 记录单条访问（内部使用，导出便于测试） */
export function appendAccessLine(
  file: string,
  entry: Record<string, unknown>,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    /* 日志写入失败绝不能影响服务 */
  }
}

/**
 * 访问日志中间件。
 * @param dataDir 数据目录，默认项目根 data/（测试可注入临时目录）
 */
export function accessLog(dataDir: string = DATA_DIR) {
  const file = join(dataDir, "access.jsonl");
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on("finish", () => {
      const xff = String(req.headers["x-forwarded-for"] ?? "");
      const ip = (xff.split(",")[0] || req.socket.remoteAddress || "").trim();
      appendAccessLine(file, {
        ts: Date.now(),
        ip,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - start,
        auth: req.headers.authorization ? "yes" : "no",
        ua: String(req.headers["user-agent"] ?? "").slice(0, 160),
      });
    });
    next();
  };
}

export interface AccessSummary {
  logFile: string;
  sampled: number;
  last24h: number;
  last: string | null;
  topPaths: Array<{ value: string; count: number }>;
  topIps: Array<{ value: string; count: number }>;
}

/** 只读聚合最近若干条访问日志，供 /statusz 展示 */
export function accessSummary(
  limit = 20000,
  file: string = ACCESS_LOG_FILE,
): AccessSummary {
  const empty: AccessSummary = {
    logFile: file,
    sampled: 0,
    last24h: 0,
    last: null,
    topPaths: [],
    topIps: [],
  };
  if (!existsSync(file)) return empty;
  try {
    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-limit);
    const now = Date.now();
    const paths = new Map<string, number>();
    const ips = new Map<string, number>();
    let last24h = 0;
    let last: string | null = null;
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { ts: number; path: string; ip: string };
        if (typeof e.ts === "number") {
          if (now - e.ts < 86_400_000) last24h++;
          last = new Date(e.ts).toISOString();
        }
        const p = String(e.path ?? "");
        paths.set(p, (paths.get(p) ?? 0) + 1);
        const ip = String(e.ip ?? "");
        ips.set(ip, (ips.get(ip) ?? 0) + 1);
      } catch {
        /* 跳过坏行 */
      }
    }
    const top = (m: Map<string, number>) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
    return {
      logFile: file,
      sampled: lines.length,
      last24h,
      last,
      topPaths: top(paths),
      topIps: top(ips),
    };
  } catch {
    return empty;
  }
}
