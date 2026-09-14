import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.js";
import { LabelStore } from "./labels/store.js";
import { clusterByFunder } from "./labels/cluster.js";
import { queryAlerts, getAlertStats } from "./alerts/history.js";
import type { Alert } from "./types.js";

/**
 * 命令行查询工具。
 *
 *   npm run label -- 0x...   查某个地址的身份标签
 *   npm run cluster -- 0x... 查某个出资方资助了哪些地址（实体聚类）
 *   npm run alerts           查看历史告警（可选 --limit N --kind xxx --severity xxx --address 0x... --hours N）
 *   npm run alerts:stats     查看告警统计
 */
async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error(
      "用法:\n  npm run label -- <0x地址>\n  npm run cluster -- <0x地址>\n  npm run alerts [--address 0x...] [--kind xxx] [--severity xxx] [--limit N] [--hours N]\n  npm run alerts:stats [hours]",
    );
    process.exit(1);
  }

  const config = loadConfig();
  const store = new LabelStore();

  if (cmd === "label") {
    const addrArg = process.argv[3];
    if (!addrArg) {
      console.error("用法: npm run label -- <0x地址>");
      process.exit(1);
    }
    const addr = addrArg.toLowerCase() as `0x${string}`;
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
    const funderArg = process.argv[3];
    if (!funderArg) {
      console.error("用法: npm run cluster -- <0x地址>");
      process.exit(1);
    }
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    const funder = funderArg.toLowerCase() as `0x${string}`;
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

  if (cmd === "alerts") {
    const opts = parseAlertArgs(process.argv.slice(3));
    const alerts = queryAlerts(opts);
    console.log(`[alerts] 共 ${alerts.length} 条${opts.since ? `（最近 ${Math.round((Date.now() - opts.since) / 3600000)} 小时）` : ""}，显示最新 ${Math.min(alerts.length, opts.limit ?? 50)} 条：\n`);
    if (alerts.length === 0) {
      console.log("  （暂无告警记录）");
    } else {
      for (const a of alerts) {
        printAlert(a);
        console.log("");
      }
    }
    return;
  }

  if (cmd === "alerts:stats") {
    const hours = parseInt(process.argv[3] ?? "", 10);
    const since = !isNaN(hours) ? Date.now() - hours * 3600 * 1000 : undefined;
    const stats = getAlertStats(since);
    console.log(`[alerts:stats] 告警统计${since ? `（最近 ${hours} 小时）` : "（全部）"}：`);
    console.log(`  总数     : ${stats.total}`);
    console.log(`  最新告警 : ${stats.latestTs ? new Date(stats.latestTs).toISOString() : "无"}`);
    console.log(`  按类型   :`);
    for (const [k, v] of Object.entries(stats.byKind)) {
      console.log(`    ${k.padEnd(16)} ${v}`);
    }
    console.log(`  按严重度 :`);
    for (const [k, v] of Object.entries(stats.bySeverity)) {
      console.log(`    ${k.padEnd(16)} ${v}`);
    }
    const topAddrs = Object.entries(stats.byAddress)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (topAddrs.length > 0) {
      console.log(`  告警最多的地址（Top 5）:`);
      for (const [addr, count] of topAddrs) {
        console.log(`    ${addr}  ${count}`);
      }
    }
    return;
  }

  console.error(`未知命令: ${cmd}（支持 label / cluster / alerts / alerts:stats）`);
  process.exit(1);
}

main().catch((err) => {
  console.error("[cli] 失败:", err);
  process.exit(1);
});

// ============================================================
// 辅助函数
// ============================================================

function parseAlertArgs(argv: string[]): {
  address?: string;
  kind?: Alert["kind"];
  severity?: Alert["severity"];
  limit?: number;
  since?: number;
} {
  const opts: ReturnType<typeof parseAlertArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    const val = argv[i + 1];
    switch (key) {
      case "--address":
        if (val) opts.address = val.toLowerCase();
        i++;
        break;
      case "--kind":
        if (val) opts.kind = val as Alert["kind"];
        i++;
        break;
      case "--severity":
        if (val) opts.severity = val as Alert["severity"];
        i++;
        break;
      case "--limit":
        if (val) opts.limit = parseInt(val, 10);
        i++;
        break;
      case "--hours":
        if (val) {
          const h = parseInt(val, 10);
          if (!isNaN(h)) opts.since = Date.now() - h * 3600 * 1000;
        }
        i++;
        break;
    }
  }
  return opts;
}

function printAlert(a: Alert): void {
  const time = new Date(a.ts).toISOString();
  const sevIcon =
    a.severity === "critical" ? "🔴" : a.severity === "warn" ? "🟡" : "🔵";
  console.log(`${sevIcon} [${time}] ${a.title}`);
  console.log(`   地址: ${a.address}`);
  console.log(`   类型: ${a.kind} (${a.severity})`);
  for (const [k, v] of Object.entries(a.fields)) {
    console.log(`   ${k}: ${v}`);
  }
}
