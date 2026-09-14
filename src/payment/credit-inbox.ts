import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 到账入账队列（credit inbox）。
 *
 * 背景：链上到账扫描（credit-daemon，独立进程）与计费账本（api 进程）是两个
 * 进程。为了不产生"双方同时写 billing.json"的竞态，这里采用单向队列：
 *
 *   credit-daemon  --只追加-->  data/credits-inbox.json  <--只读--  api(billing)
 *
 * api 侧把已处理的条目 id 记在自己的 billing.json（appliedTxs），因此队列文件
 * 只由 daemon 写、api 只读，不需要加锁也不会互相覆盖。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

/** 默认队列文件路径 */
export const DEFAULT_INBOX_FILE = join(DATA_DIR, "credits-inbox.json");

export interface CreditEntry {
  /** 付款地址（小写），作为计费账本的 key */
  key: string;
  /** 换算后的 credit 数（<=0 的条目不入队） */
  credits: number;
  txHash: string;
  logIndex: number;
  ts: number;
}

/** 条目唯一 id：交易哈希 + 日志序号 */
export function entryId(e: Pick<CreditEntry, "txHash" | "logIndex">): string {
  return `${e.txHash}:${e.logIndex}`;
}

/** 读取队列（文件不存在或损坏时返回空数组） */
export function readInbox(file: string = DEFAULT_INBOX_FILE): CreditEntry[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is CreditEntry =>
        !!e &&
        typeof (e as CreditEntry).key === "string" &&
        typeof (e as CreditEntry).credits === "number" &&
        typeof (e as CreditEntry).txHash === "string",
    );
  } catch {
    return [];
  }
}

/** 队列文件 mtime（毫秒）；不存在返回 0 */
export function inboxMtimeMs(file: string = DEFAULT_INBOX_FILE): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 原子写（先写 .tmp 再 rename，避免读到半截文件） */
function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, file);
}

/**
 * 追加入账条目（daemon 专用），按 txHash:logIndex 去重。
 * @returns 实际新增条数
 */
export function appendInbox(
  entries: CreditEntry[],
  file: string = DEFAULT_INBOX_FILE,
): number {
  const cur = readInbox(file);
  const seen = new Set(cur.map((e) => entryId(e)));
  const added: CreditEntry[] = [];
  for (const e of entries) {
    const id = entryId(e);
    if (seen.has(id)) continue;
    if (!(e.credits > 0)) continue;
    seen.add(id);
    added.push(e);
  }
  if (added.length === 0) return 0;
  writeAtomic(file, JSON.stringify([...cur, ...added], null, 2));
  return added.length;
}

/** 便捷：写入默认队列文件 */
export function appendInboxDefault(entries: CreditEntry[]): number {
  return appendInbox(entries, DEFAULT_INBOX_FILE);
}
