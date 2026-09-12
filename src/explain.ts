import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.js";
import { LabelStore } from "./labels/store.js";
import { explainTransaction, formatExplanation } from "./tx/explain.js";

/**
 * 交易解释器 CLI。
 *   npm run explain -- <交易哈希>
 * 回答"这笔交易做了什么 / 我的币去哪了"。
 */
async function main(): Promise<void> {
  const txHash = process.argv[2];
  if (!txHash || !txHash.startsWith("0x")) {
    console.error("用法: npm run explain -- <0x交易哈希>");
    process.exit(1);
  }

  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const store = new LabelStore();

  console.log(`[explain] 解析交易 ${txHash} ...`);
  const explanation = await explainTransaction({
    client,
    txHash: txHash as `0x${string}`,
    assetAddress: config.assetAddress,
    assetDecimals: config.assetDecimals,
    assetSymbol: config.assetSymbol,
    labelStore: store,
  });

  console.log(formatExplanation(explanation, config.assetDecimals, config.assetSymbol));
}

main().catch((err) => {
  console.error("[explain] 失败:", err);
  process.exit(1);
});
