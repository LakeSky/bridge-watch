import { LabelStore } from "./labels/store.js";
import { savePersistedLabels } from "./labels/persist.js";
import { fetchEthLabels } from "./labels/importers/ethlabels.js";

/**
 * 标签导入 CLI。
 *   npm run import
 * 流程：种子 + 已持久化 → 拉取 eth-labels → 合并 → 落盘 → 打印统计。
 */
async function main(): Promise<void> {
  const store = new LabelStore(); // 自动加载种子 + 已持久化
  const before = store.size();
  console.log(`[import] 起始标签数: ${before}`);

  console.log(`[import] 拉取 eth-labels accounts.json ...`);
  const fetched = await fetchEthLabels();
  console.log(`[import] 拉取到 ${fetched.length} 条`);

  const added = store.bulkUpsert(fetched);
  console.log(`[import] 新增 ${added} 条，合并后总数 ${store.size()}`);

  savePersistedLabels(store.dump());
  console.log(`[import] 已持久化到 data/labels.json`);

  const byCat = new Map<string, number>();
  for (const l of store.dump()) {
    byCat.set(l.category, (byCat.get(l.category) ?? 0) + 1);
  }
  console.log(`[import] 分类分布:`);
  for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${n}`);
  }
}

main().catch((err) => {
  console.error("[import] 失败:", err);
  process.exit(1);
});
