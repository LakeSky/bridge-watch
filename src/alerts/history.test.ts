import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadAlerts,
  appendAlert,
  queryAlerts,
  getAlertStats,
} from "./history.js";
import type { Alert, AlertKind, AlertSeverity } from "../types.js";

/**
 * 告警历史模块此前零测试覆盖。
 * 这里用一块内存态 `node:fs` mock 驱动真实函数（loadAlerts/appendAlert/
 * queryAlerts/getAlertStats），既验证过滤/排序/统计/截断逻辑，又不污染真实
 * data/alerts.json，也不改动源码签名，与其他智能体零冲突。
 */

const { fsState } = vi.hoisted(() => {
  let store: string | null = null;
  return {
    fsState: {
      get: () => store,
      set: (s: string | null) => {
        store = s;
      },
      reset: () => {
        store = null;
      },
    },
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn((_p: string) => fsState.get() !== null),
  readFileSync: vi.fn((_p: string, _enc: string) => {
    const s = fsState.get();
    if (s === null) {
      const e = new Error("ENOENT");
      (e as NodeJS.ErrnoException).code = "ENOENT";
      throw e;
    }
    return s;
  }),
  writeFileSync: vi.fn((_p: string, content: string) => {
    fsState.set(content);
  }),
  mkdirSync: vi.fn(() => undefined),
}));

const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
const A3 = "0xAbCdEf0123456789012345678901234567890AbC"; // 混合大小写

function mkAlert(over: Partial<Alert> = {}): Alert {
  return {
    kind: "large_outflow",
    severity: "warn",
    address: A1,
    title: "test alert",
    fields: {},
    ts: 1000,
    ...over,
  };
}

function seed(alerts: Alert[]) {
  fsState.set(JSON.stringify(alerts));
}

beforeEach(() => {
  fsState.reset();
});

describe("loadAlerts", () => {
  it("文件不存在时返回空数组", () => {
    expect(loadAlerts()).toEqual([]);
  });

  it("JSON 损坏时降级返回空数组（不抛错）", () => {
    fsState.set("{ this is not json");
    expect(loadAlerts()).toEqual([]);
  });

  it("JSON 非数组时返回空数组", () => {
    fsState.set(JSON.stringify({ total: 3 }));
    expect(loadAlerts()).toEqual([]);
  });

  it("与 appendAlert 往返一致", () => {
    appendAlert(mkAlert({ ts: 111 }));
    appendAlert(mkAlert({ ts: 222, address: A2 }));
    const loaded = loadAlerts();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.ts).toBe(111);
    expect(loaded[1]!.address).toBe(A2);
  });
});

describe("appendAlert 持久化与截断", () => {
  it("多次追加保留追加顺序", () => {
    appendAlert(mkAlert({ ts: 1 }));
    appendAlert(mkAlert({ ts: 2 }));
    appendAlert(mkAlert({ ts: 3 }));
    const loaded = loadAlerts();
    expect(loaded.map((a) => a.ts)).toEqual([1, 2, 3]);
  });

  it("超过 MAX_ALERTS 时丢弃最旧记录并保留新增", () => {
    // 预置 10001 条，再追加 1 条 → 应截断为 10000，且最旧 2 条被丢弃、新增仍在
    const base: Alert[] = [];
    for (let i = 0; i < 10001; i++) {
      base.push(mkAlert({ ts: i }));
    }
    seed(base);
    appendAlert(mkAlert({ ts: 99999, title: "newest" }));
    const loaded = loadAlerts();
    expect(loaded).toHaveLength(10000);
    expect(loaded.at(-1)!.title).toBe("newest");
    expect(loaded.at(-1)!.ts).toBe(99999);
    // 最旧的两条（ts=0, ts=1）已被丢弃
    expect(loaded.some((a) => a.ts === 0)).toBe(false);
    expect(loaded.some((a) => a.ts === 1)).toBe(false);
    expect(loaded[0]!.ts).toBe(2);
  });
});

describe("queryAlerts 过滤", () => {
  const sample: Alert[] = [
    mkAlert({ ts: 100, address: A1, kind: "large_outflow", severity: "warn" }),
    mkAlert({ ts: 200, address: A2, kind: "large_inflow", severity: "info" }),
    mkAlert({ ts: 300, address: A3, kind: "balance_drain", severity: "critical" }),
    mkAlert({ ts: 400, address: A1, kind: "large_outflow", severity: "critical" }),
  ];

  it("按地址过滤（大小写不敏感）", () => {
    seed(sample);
    const r = queryAlerts({ address: A3.toLowerCase() });
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe("balance_drain");
  });

  it("按 kind 过滤", () => {
    seed(sample);
    const r = queryAlerts({ kind: "large_outflow" as AlertKind });
    expect(r).toHaveLength(2);
    expect(r.every((a) => a.kind === "large_outflow")).toBe(true);
  });

  it("按 severity 过滤", () => {
    seed(sample);
    const r = queryAlerts({ severity: "critical" as AlertSeverity });
    expect(r).toHaveLength(2);
    expect(r.every((a) => a.severity === "critical")).toBe(true);
  });

  it("按 since 过滤（ts >= since）", () => {
    seed(sample);
    const r = queryAlerts({ since: 300 });
    expect(r.map((a) => a.ts).sort((x, y) => x - y)).toEqual([300, 400]);
  });

  it("组合多个过滤条件", () => {
    seed(sample);
    const r = queryAlerts({ address: A1, kind: "large_outflow" as AlertKind });
    expect(r).toHaveLength(2);
    expect(r.every((a) => a.address === A1 && a.kind === "large_outflow")).toBe(true);
  });

  it("无匹配时返回空数组", () => {
    seed(sample);
    const r = queryAlerts({ kind: "startup" as AlertKind });
    expect(r).toEqual([]);
  });
});

describe("queryAlerts 排序与分页", () => {
  it("默认按时间倒序返回", () => {
    seed([
      mkAlert({ ts: 100 }),
      mkAlert({ ts: 300 }),
      mkAlert({ ts: 200 }),
    ]);
    const r = queryAlerts();
    expect(r.map((a) => a.ts)).toEqual([300, 200, 100]);
  });

  it("limit 截断条数（取最新）", () => {
    seed([
      mkAlert({ ts: 100 }),
      mkAlert({ ts: 200 }),
      mkAlert({ ts: 300 }),
      mkAlert({ ts: 400 }),
      mkAlert({ ts: 500 }),
    ]);
    const r = queryAlerts({ limit: 2 });
    expect(r).toHaveLength(2);
    expect(r.map((a) => a.ts)).toEqual([500, 400]);
  });
});

describe("getAlertStats 聚合", () => {
  const sample: Alert[] = [
    mkAlert({ ts: 100, address: A1, kind: "large_outflow", severity: "warn" }),
    mkAlert({ ts: 200, address: A2, kind: "large_inflow", severity: "info" }),
    mkAlert({ ts: 300, address: A1, kind: "balance_drain", severity: "critical" }),
    mkAlert({ ts: 400, address: A3, kind: "large_outflow", severity: "critical" }),
  ];

  it("聚合 total / byKind / bySeverity / byAddress / latestTs", () => {
    seed(sample);
    const s = getAlertStats();
    expect(s.total).toBe(4);
    expect(s.byKind).toEqual({
      large_outflow: 2,
      large_inflow: 1,
      balance_drain: 1,
    });
    expect(s.bySeverity).toEqual({
      warn: 1,
      info: 1,
      critical: 2,
    });
    expect(s.byAddress[A1]).toBe(2);
    expect(s.byAddress[A2]).toBe(1);
    expect(s.byAddress[A3]).toBe(1);
    expect(s.latestTs).toBe(400);
  });

  it("按 sinceMs 限定统计窗口", () => {
    seed(sample);
    const s = getAlertStats(300);
    expect(s.total).toBe(2);
    expect(s.byKind).toEqual({ balance_drain: 1, large_outflow: 1 });
    expect(s.latestTs).toBe(400);
  });

  it("空历史返回 total=0 且 latestTs=null", () => {
    const s = getAlertStats();
    expect(s.total).toBe(0);
    expect(s.latestTs).toBeNull();
    expect(s.byKind).toEqual({});
    expect(s.bySeverity).toEqual({});
    expect(s.byAddress).toEqual({});
  });
});
