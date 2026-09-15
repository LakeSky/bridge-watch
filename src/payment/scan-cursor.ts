/**
 * 扫链游标（scan cursor）：记录"已经扫到哪个块"，供 credit-daemon 增量扫描。
 *
 * 2026-09-15 修复背景：
 *   credit-daemon 原来每轮都只回看最近 LOOKBACK_BLOCKS = 2000 个块（Base 约 66 分钟）。
 *   一旦守护进程宕机、被重启、或 RPC 抖动超过这个窗口，窗口内滑过的到账就
 *   **永久丢失**（例如客户那笔 0x0e3c8b…3dfee3dfee0 在修好换算前已滑出窗口）。
 *   这类丢单在日志上表现为"无新到账"，与"真的没人付款"完全无法区分。
 *
 * 现行方案：把"已扫到的最高块号"持久化到 data/scan-cursor.json，
 *   每轮从 cursor+1 扫到最新块（分页），扫完才推进游标：
 *     - 长时间宕机后也能按块高补齐（不再依赖 66 分钟窗口）；
 *     - 游标写入采用 tmp + rename 原子写，避免半截文件导致游标回退；
 *     - 文件缺失/损坏时返回 null（调用方退化为回看窗口扫描），不会静默丢单。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

/** 默认游标文件路径 */
export const DEFAULT_CURSOR_FILE = join(DATA_DIR, "scan-cursor.json");

interface CursorRecord {
  version: 1;
  /** 已成功扫描到的最高块号（十进制字符串，避免 bigint 序列化问题） */
  lastScannedBlock: string;
  updatedAt: number;
}

/** 读取游标；文件缺失/损坏/非法时返回 null（调用方应退化为按窗口回看） */
export function loadScanCursor(file: string = DEFAULT_CURSOR_FILE): bigint | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<CursorRecord>;
    const v = raw?.lastScannedBlock;
    if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
    return BigInt(v);
  } catch {
    return null;
  }
}

/** 原子写游标（先写 .tmp 再 rename） */
export function saveScanCursor(
  block: bigint,
  file: string = DEFAULT_CURSOR_FILE,
): void {
  const rec: CursorRecord = {
    version: 1,
    lastScannedBlock: block.toString(),
    updatedAt: Date.now(),
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf-8");
  renameSync(tmp, file);
}

/** 清除游标（运维/测试用）：下次扫描退化为按窗口回看 */
export function clearScanCursor(file: string = DEFAULT_CURSOR_FILE): void {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // 清除失败不应影响主流程
  }
}
