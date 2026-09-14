import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessLog, accessSummary } from "./accesslog.js";

/** 构造极简 req/res（accessLog 只用到这几个字段 + finish 事件） */
function fake(
  opts: {
    headers?: Record<string, string>;
    method?: string;
    url?: string;
    status?: number;
  } = {},
) {
  const res = new EventEmitter() as unknown as {
    statusCode: number;
    on: (e: string, cb: () => void) => void;
    emit: (e: string) => void;
  };
  res.statusCode = opts.status ?? 200;
  const req = {
    headers: opts.headers ?? {},
    method: opts.method ?? "GET",
    originalUrl: opts.url ?? "/v1/label/0xabc",
    socket: { remoteAddress: "10.0.0.1" },
  };
  return { req, res };
}

describe("accessLog 中间件", () => {
  it("finish 时写入一行 JSON，含 ip/状态码/鉴权标记", () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-access-"));
    const mw = accessLog(dir);
    const { req, res } = fake({
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.9", authorization: "Bearer abc" },
      url: "/v1/label/0xdead",
      status: 402,
    });
    let called = false;
    mw(req as never, res as never, () => {
      called = true;
    });
    expect(called).toBe(true);
    res.emit("finish");

    const line = readFileSync(join(dir, "access.jsonl"), "utf-8").trim();
    const e = JSON.parse(line) as Record<string, unknown>;
    expect(e.ip).toBe("9.9.9.9"); // 取 x-forwarded-for 第一段
    expect(e.status).toBe(402);
    expect(e.path).toBe("/v1/label/0xdead");
    expect(e.auth).toBe("yes");
    expect(typeof e.ts).toBe("number");
  });

  it("无 x-forwarded-for 时回退到 socket 地址", () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-access-"));
    const mw = accessLog(dir);
    const { req, res } = fake({ method: "POST", url: "/mcp" });
    mw(req as never, res as never, () => {});
    res.emit("finish");
    const e = JSON.parse(readFileSync(join(dir, "access.jsonl"), "utf-8").trim()) as {
      ip: string;
      method: string;
      auth: string;
    };
    expect(e.ip).toBe("10.0.0.1");
    expect(e.method).toBe("POST");
    expect(e.auth).toBe("no");
  });
});

describe("accessSummary", () => {
  it("文件不存在时返回空摘要而非抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-access-"));
    const s = accessSummary(20000, join(dir, "nope.jsonl"));
    expect(s.sampled).toBe(0);
    expect(s.last).toBeNull();
    expect(s.topPaths).toEqual([]);
  });

  it("聚合条数、24h 计数与热门路径，跳过坏行", () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-access-"));
    const file = join(dir, "access.jsonl");
    const now = Date.now();
    const rows = [
      { ts: now - 1000, ip: "1.1.1.1", path: "/v1/label/0xa" },
      { ts: now - 2000, ip: "1.1.1.1", path: "/v1/label/0xa" },
      { ts: now - 3 * 86_400_000, ip: "2.2.2.2", path: "/healthz" }, // 超过 24h
    ];
    writeFileSync(
      file,
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n{坏行\n",
      "utf-8",
    );
    const s = accessSummary(20000, file);
    expect(s.sampled).toBe(4);
    expect(s.last24h).toBe(2);
    expect(s.topPaths[0]).toEqual({ value: "/v1/label/0xa", count: 2 });
    expect(s.topIps[0]).toEqual({ value: "1.1.1.1", count: 2 });
    expect(s.last).not.toBeNull();
  });
});
