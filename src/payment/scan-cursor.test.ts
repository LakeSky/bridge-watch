import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScanCursor, saveScanCursor, clearScanCursor } from "./scan-cursor.js";

/**
 * 扫链游标持久化。
 *
 * 事故复盘：旧实现每轮只回看最近 2000 块（Base 约 66 分钟），宕机/重启超过该窗口
 * 的到账会永久丢失，而日志上只表现为"无新到账"。游标是"不丢单"的地基，
 * 因此这里锁死：可持久化、可覆盖、损坏可降级（返回 null → 退化为窗口回看，而非从 0 重扫或崩溃）。
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bw-cursor-"));
  file = join(dir, "scan-cursor.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadScanCursor", () => {
  it("文件不存在 → null（调用方退化为窗口回看）", () => {
    expect(loadScanCursor(file)).toBeNull();
  });

  it("损坏 JSON → null 且不抛错", () => {
    writeFileSync(file, "not json{{", "utf-8");
    expect(loadScanCursor(file)).toBeNull();
  });

  it("字段缺失/类型错误/非数字 → null", () => {
    for (const bad of [
      "{}",
      JSON.stringify({ lastScannedBlock: 123 }),
      JSON.stringify({ lastScannedBlock: "-5" }),
      JSON.stringify({ lastScannedBlock: "0x10" }),
      JSON.stringify({ lastScannedBlock: "" }),
    ]) {
      writeFileSync(file, bad, "utf-8");
      expect(loadScanCursor(file)).toBeNull();
    }
  });

  it('合法记录 → bigint（"0" 为合法值）', () => {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, lastScannedBlock: "0", updatedAt: 1 }),
      "utf-8",
    );
    expect(loadScanCursor(file)).toBe(0n);
  });
});

describe("saveScanCursor", () => {
  it("写入后可读回，且为原子写（不残留 .tmp）", () => {
    saveScanCursor(19_123_456n, file);
    expect(loadScanCursor(file)).toBe(19_123_456n);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("重复写入覆盖旧值（游标只前进/回退都由写入者决定）", () => {
    saveScanCursor(100n, file);
    saveScanCursor(200n, file);
    expect(loadScanCursor(file)).toBe(200n);
  });

  it("目录不存在时自动创建（不抛错）", () => {
    const nested = join(dir, "a", "b", "cursor.json");
    expect(() => saveScanCursor(7n, nested)).not.toThrow();
    expect(loadScanCursor(nested)).toBe(7n);
  });
});

describe("clearScanCursor", () => {
  it("清空后 load 返回 null（运维可强制退化为窗口回看）", () => {
    saveScanCursor(500n, file);
    clearScanCursor(file);
    expect(loadScanCursor(file)).toBeNull();
  });

  it("文件不存在时不抛错", () => {
    expect(() => clearScanCursor(join(dir, "nope.json"))).not.toThrow();
  });
});
