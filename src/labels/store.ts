import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressProfile, Cluster, Label } from "./types.js";
import { loadPersistedLabels } from "./persist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 标签存储。地址 → 身份映射。
 *
 * 设计要点（护城河的本质）：
 *   - 标签是"越攒越准"的复利资产，所以提供 upsert，随时追加/修正；
 *   - 置信度分层：人工 > LLM > 启发式，用于后续告警时决定"敢不敢下结论"；
 *   - 地址统一小写，避免大小写导致查不到。
 */
export class LabelStore {
  private labels = new Map<`0x${string}`, Label>();

  constructor() {
    this.loadSeed();
    // 加载已持久化的累积标签（导入 eth-labels 等后落盘的规模数据）
    this.bulkUpsert(loadPersistedLabels());
  }

  private loadSeed(): void {
    try {
      const raw = readFileSync(join(__dirname, "seed.json"), "utf-8");
      const parsed = JSON.parse(raw) as { labels?: Label[] };
      for (const l of parsed.labels ?? []) {
        this.upsert(l);
      }
    } catch (err) {
      // 种子文件缺失/损坏不应让整个监控挂掉
      console.warn(`[labels] 种子标签加载失败: ${(err as Error).message}`);
    }
  }

  /** 解析地址身份：先查标签，再给聚类（聚类由调用方用 on-chain 数据补充） */
  resolve(address: `0x${string}`): Label | null {
    return this.labels.get(address.toLowerCase() as `0x${string}`) ?? null;
  }

  upsert(label: Label): void {
    this.labels.set(label.address.toLowerCase() as `0x${string}`, {
      ...label,
      address: label.address.toLowerCase() as `0x${string}`,
      confidence: clamp01(label.confidence),
    });
  }

  size(): number {
    return this.labels.size;
  }

  /** 导出全部标签（用于持久化） */
  dump(): Label[] {
    return [...this.labels.values()];
  }

  /** 批量 upsert，返回新增数量（地址此前不存在） */
  bulkUpsert(labels: Label[]): number {
    let added = 0;
    for (const l of labels) {
      const key = l.address.toLowerCase() as `0x${string}`;
      if (!this.labels.has(key)) added++;
      this.upsert(l);
    }
    return added;
  }

  /** 用标签 + 聚类结果拼出完整画像 */
  static profile(
    address: `0x${string}`,
    label: Label | null,
    cluster: Cluster | null,
  ): AddressProfile {
    return { address, label, cluster };
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
