import { createPublicClient, http } from "viem";
import { loadConfig } from "../config.js";
import { LabelStore } from "../labels/store.js";
import { LocalBilling } from "./billing.js";
import { createApiServer } from "./server.js";
import { loadDeposits } from "../payment/deposits.js";

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
  const deposits = loadDeposits();
  const unit = 10n ** BigInt(config.assetDecimals);
  let creditedCount = 0;
  for (const d of deposits) {
    const credits = Number(
      (d.amount * BigInt(config.creditPerUsdc)) / unit,
    );
    if (credits > 0) {
      billing.credit(d.from.toLowerCase(), credits);
      creditedCount++;
    }
  }

  const app = createApiServer({
    client,
    labelStore,
    billing,
    validKeys: new Set(config.apiKeys),
    assetAddress: config.assetAddress,
    assetDecimals: config.assetDecimals,
    assetSymbol: config.assetSymbol,
  });

  app.listen(config.apiPort, () => {
    console.log(`[api] 监听 http://0.0.0.0:${config.apiPort}`);
    console.log(`[api] 端点: /healthz /v1/me /v1/label/:address /v1/explain/:txHash /v1/cluster/:funder`);
    console.log(`[api] API key ${config.apiKeys.length} 个（各 ${config.apiCredits} credits）`);
    console.log(`[api] 收款地址 ${config.paymentAddress}；已从 ${deposits.length} 笔到账充值 ${creditedCount} 个付款地址`);
  });
}

main().catch((err) => {
  console.error("[api] 启动失败:", err);
  process.exit(1);
});
