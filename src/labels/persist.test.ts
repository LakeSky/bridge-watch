import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// 隔离 node:fs，避免触碰真实 data/labels.json（护城河资产，禁止测试污染）
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { loadPersistedLabels, savePersistedLabels } from "./persist.js";
import type { Label } from "./types.js";

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);
const mockMkdir = vi.mocked(mkdirSync);

const sample: Label[] = [
  {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin (USDC)",
    category: "token",
    source: "curated",
    confidence: 1,
    chainId: 8453,
  },
  {
    address: "0x381cdbb664608bf7b1dd4f9403a572c1c57332c2",
    name: "Bridge-Watch Treasury",
    category: "other",
    source: "curated",
    confidence: 1,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadPersistedLabels", () => {
  it("文件不存在时返回空数组（不抛错）", () => {
    mockExists.mockReturnValue(false);
    expect(loadPersistedLabels()).toEqual([]);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("JSON 损坏时降级返回空数组（控制台告警，不抛错）", () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue("{ this is not json");
    // 不应抛出
    expect(() => loadPersistedLabels()).not.toThrow();
    expect(loadPersistedLabels()).toEqual([]);
  });

  it("合法数组正常反序列化并返回", () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(JSON.stringify(sample));
    expect(loadPersistedLabels()).toEqual(sample);
  });

  it("JSON 是对象（非数组）时降级返回空数组", () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(JSON.stringify({ foo: "bar" }));
    expect(loadPersistedLabels()).toEqual([]);
  });

  it("JSON 是标量（数字/字符串）时降级返回空数组", () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue("123");
    expect(loadPersistedLabels()).toEqual([]);
    mockRead.mockReturnValue('"a string"');
    expect(loadPersistedLabels()).toEqual([]);
  });

  it("空数组也正常返回（边界）", () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue("[]");
    expect(loadPersistedLabels()).toEqual([]);
  });
});

describe("savePersistedLabels", () => {
  it("写入前先递归创建目录，并把数组序列化为 JSON 落盘", () => {
    savePersistedLabels(sample);
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining("data"),
      { recursive: true },
    );
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const [path, body, enc] = mockWrite.mock.calls[0]!;
    expect(String(path)).toContain("labels.json");
    expect(enc).toBe("utf-8");
    expect(JSON.parse(String(body))).toEqual(sample);
  });

  it("单条标签也能正确序列化", () => {
    savePersistedLabels([sample[0]!]);
    const body = String(mockWrite.mock.calls[0]![1]);
    expect(JSON.parse(body)).toEqual([sample[0]]);
  });

  it("空数组写入后仍是合法 JSON 空数组", () => {
    savePersistedLabels([]);
    expect(JSON.parse(String(mockWrite.mock.calls[0]![1]))).toEqual([]);
  });
});
