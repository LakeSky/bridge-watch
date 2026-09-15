import { createPublicClient, http } from "viem";
import { loadConfig } from "../config.js";
import { LabelStore } from "../labels/store.js";
import { LocalBilling } from "./billing.js";
import { createApiServer } from "./server.js";
import { readInbox } from "../payment/credit-inbox.js";

/**
 * API 服务入口。
 *   npm run api
 * 把 label / explain / cluster 查询暴露为带鉴权 + 计量的付费 API。
 * 鉴权：API key（预置额度）或付款地址（USDC 到账充值）。
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const labelStore = new LabelStore();
  const billing = new LocalBilling();

  // 1. API key 预置额度
  for (const key of config.apiKeys) {
    billing.seed(key, config.apiCredits);
  }

  // 2. USDC 到账充值（付款地址 → credit）
  //
  //    历史实现每次启动都把 data/deposits.json 全量重新 credit 一遍，且没有任何
  //    幂等基准（不查 appliedTxs）：每重启一次就给同一笔到账重复加额度。
  //    2026-09-15 修复：本进程不再自行扫描 deposits，改为只消费 credit-daemon
  //    写入的到账队列（data/credits-inbox.json），幂等由 billing.json 的
  //    appliedTxs 保证；"扫描→换算→入队"职责单一收敛到 daemon。
  billing.flushSync(); // 消费一次队列并落盘（无新到账时为空操作）
  const inboxCount = readInbox().length;

  const app = createApiServer({
    client,
    labelStore,
    billing,
    validKeys: new Set(config.apiKeys),
    assetAddress: config.assetAddress,
    assetDecimals: config.assetDecimals,
    assetSymbol: config.assetSymbol,
    payTo: config.paymentAddress,
    creditPerUsdc: config.creditPerUsdc,
  });

  const server = app.listen(config.apiPort, () => {
    console.log(`[api] 监听 http://0.0.0.0:${config.apiPort}`);
    console.log(`[api] 端点: /healthz /v1/me /v1/label/:address /v1/explain/:txHash /v1/cluster/:funder /v1/alerts /v1/alerts/stats`);
    console.log(`[api] API key ${config.apiKeys.length} 个（各 ${config.apiCredits} credits）`);
    console.log(`[api] 收款地址 ${config.paymentAddress}；到账队列 ${inboxCount} 条（由 credit-daemon 维护，幂等并入账本）`);
  });

  // 优雅退出：SIGINT/SIGTERM 时先落盘 billing 再关闭服务
  const shutdown = (sig: string) => {
    console.log(`\n[api] 收到 ${sig}，正在优雅退出...`);
    billing.flushSync();
    server.close(() => {
      console.log("[api] 已停止");
      process.exit(0);
    });
    // 5 秒强制退出兜底
    setTimeout(() => {
      console.warn("[api] 强制退出（超时）");
      process.exit(1);
    }, 5000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[api] 启动失败:", err);
  process.exit(1);
});
