import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.js";
import { LabelStore } from "./labels/store.js";
import { clusterByFunder } from "./labels/cluster.js";

/**
 * 命令行查询工具。
 *
 *   npm run label -- 0x...   查某个地址的身份标签
 *   npm run cluster -- 0x... 查某个出资方资助了哪些地址（实体聚类）
 */
async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || !arg) {
    console.error(
      "用法:\n  npm run label -- <0x地址>\n  npm run cluster -- <0x地址>",
    );
    process.exit(1);
  }

  const config = loadConfig();
  const store = new LabelStore();

  if (cmd === "label") {
    const addr = arg.toLowerCase() as `0x${string}`;
    const label = store.resolve(addr);
    if (label) {
      console.log(`[label] ${addr}`);
      console.log(`  名称    : ${label.name}`);
      console.log(`  类别    : ${label.category}`);
      console.log(`  来源    : ${label.source}（置信度 ${label.confidence}）`);
    } else {
      console.log(`[label] ${addr} 暂无标签（未知地址）`);
      console.log(
        `        （标签库当前 ${store.size()} 条；扩充方式：编辑 seed.json 或调用 LabelStore.upsert）`,
      );
    }
    return;
  }

  if (cmd === "cluster") {
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    const funder = arg.toLowerCase() as `0x${string}`;
    console.log(`[cluster] 分析出资方 ${funder} 在近 2000 块内的资金去向...`);
    const cluster = await clusterByFunder(client, funder, config.assetAddress);
    if (cluster.members.length > 0) {
      console.log(`  依据    : ${cluster.reason}`);
      console.log(`  置信度  : ${cluster.confidence}`);
      console.log(`  疑似聚类成员（${cluster.members.length}）:`);
      const shown = cluster.members.slice(0, 10);
      for (const m of shown) console.log(`    - ${m}`);
      const rest = cluster.members.length - shown.length;
      if (rest > 0) console.log(`    … 还有 ${rest} 个（省略）`);
    } else {
      console.log(`  未发现足够规模的聚类（成员不足 ${cluster.members.length}）`);
    }
    return;
  }

  console.error(`未知命令: ${cmd}（支持 label / cluster）`);
  process.exit(1);
}

main().catch((err) => {
  console.error("[cli] 失败:", err);
  process.exit(1);
});
