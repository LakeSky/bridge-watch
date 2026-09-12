import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.js";
import { extractCctpDeposits } from "./cctp/deposit.js";
import { getDestination } from "./cctp/destinations.js";
import { formatUnits } from "./telegram.js";

/**
 * CCTP 卡单追踪 CLI（源链侧）。
 *   npm run track -- <0x交易哈希>
 * 识别交易是否为 CCTP 跨链转账，并报告金额/目标链/nonce。
 */
async function main(): Promise<void> {
  const txHash = process.argv[2];
  if (!txHash || !txHash.startsWith("0x")) {
    console.error("用法: npm run track -- <0x交易哈希>");
    process.exit(1);
  }

  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });

  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });
  const deposits = extractCctpDeposits(receipt.logs, txHash as `0x${string}`);

  if (deposits.length === 0) {
    console.log("[track] 该交易不是 CCTP 跨链转账（未发现 DepositForBurn 事件）");
    return;
  }

  for (const d of deposits) {
    console.log(`[track] 发现 CCTP 跨链转账:`);
    console.log(
      `  金额     : ${formatUnits(d.amount, config.assetDecimals)} ${config.assetSymbol}`,
    );
    console.log(`  发起方   : ${d.depositor}`);
    console.log(`  目标链   : ${d.destinationChain} (domain ${d.destinationDomain})`);
    console.log(`  nonce    : ${d.nonce}`);
    console.log(`  收款地址 : ${d.mintRecipient}`);

    // 跨链到账：已识别目标链；完整"是否到账"需解 V2 的 bytes32 nonce（Week 8）
    const dest = getDestination(d.destinationDomain);
    if (dest) {
      console.log(
        `  状态     : 源链已转出；目标链 ${dest.name} 已识别（到账验证需 V2 nonce，Week 8）`,
      );
    } else {
      console.log(
        `  状态     : 源链已转出；目标链 ${d.destinationChain} 未配置到账查询`,
      );
    }
  }
}

main().catch((err) => {
  console.error("[track] 失败:", err);
  process.exit(1);
});
