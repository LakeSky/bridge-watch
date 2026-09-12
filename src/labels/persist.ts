import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Label } from "./types.js";

/**
 * 标签持久化。
 *
 * 护城河的本质：标签是"越攒越值钱"的资产，不能每次都重新拉取。
 * 这里把合并后的标签落盘到 data/labels.json（派生数据，可随时重建），
 * 下次启动直接加载，避免重复下载 22MB 的源数据。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// bridge-watch/data/labels.json
const DATA_DIR = join(__dirname, "..", "..", "data");
const LABELS_FILE = join(DATA_DIR, "labels.json");

export function loadPersistedLabels(): Label[] {
  if (!existsSync(LABELS_FILE)) return [];
  try {
    const raw = readFileSync(LABELS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Label[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[persist] 读取失败，忽略: ${(err as Error).message}`);
    return [];
  }
}

export function savePersistedLabels(labels: Label[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LABELS_FILE, JSON.stringify(labels), "utf-8");
}
