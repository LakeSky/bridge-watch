import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.js";
import { extractCctpDeposits } from "./cctp/deposit.js";
import { trackCctpDeposit } from "./cctp/verify.js";
import { BASE_DOMAIN } from "./cctp/constants.js";
import { formatUnits } from "./telegram.js";

/**
 * CCTP 卡单追踪 CLI。
 *   npm run track -- <0x交易哈希>
 * 识别交易是否为 CCTP 跨链转账，并报告金额/目标链/nonce/是否到账。
 */
async function main(): Promise<void> {
  const txHash = process.argv[2];
  if (!txHash || !txHash.startsWith("0x")) {
    console.error("用法: npm run track -- <0x交易哈希>");
    process.exit(1);
  }

  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });

  console.log(`[track] 正在查询交易 ${txHash}...`);
  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });
  const deposits = extractCctpDeposits(receipt.logs, txHash as `0x${string}`);

  if (deposits.length === 0) {
    console.log("[track] 该交易不是 CCTP 跨链转账（未发现 DepositForBurn 事件）");
    return;
  }

  for (let i = 0; i < deposits.length; i++) {
    const d = deposits[i]!;
    console.log(`\n[track] CCTP 跨链转账 #${i + 1}:`);
    console.log(
      `  金额     : ${formatUnits(d.amount, config.assetDecimals)} ${config.assetSymbol}`,
    );
    console.log(`  发起方   : ${d.depositor}`);
    console.log(`  目标链   : ${d.destinationChain} (domain ${d.destinationDomain})`);
    console.log(`  V1 nonce : ${d.nonce.toString()}`);
    console.log(`  收款地址 : ${d.mintRecipient}`);

    console.log(`  状态     : 正在查询目标链到账状态...`);
    const result = await trackCctpDeposit(
      {
        amount: d.amount,
        depositor: d.depositor,
        mintRecipient: d.mintRecipient,
        destinationDomain: d.destinationDomain,
        destinationChain: d.destinationChain,
        nonce: d.nonce,
      },
      BASE_DOMAIN,
    );

    console.log(`  V2 nonce : ${result.v2Nonce}`);
    if (!result.destinationConfigured) {
      console.log(`  到账状态 : ⚠️  目标链 ${result.destinationChain} 未配置到账查询`);
    } else if (result.arrived) {
      console.log(`  到账状态 : ✅ 已到账（目标链 ${result.destinationChain} 已 mint）`);
    } else {
      console.log(`  到账状态 : ⏳ 尚未到账（仍在跨链中，或卡单）`);
    }
  }
}

main().catch((err) => {
  console.error("[track] 失败:", err);
  process.exit(1);
});
