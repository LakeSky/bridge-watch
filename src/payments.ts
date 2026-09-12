import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.js";
import {
  scanDeposits,
  loadDeposits,
  mergeDeposits,
  saveDeposits,
} from "./payment/deposits.js";
import { formatUnits } from "./telegram.js";

/**
 * USDC 到账扫描 CLI。
 *   npm run payments
 * 扫描收款地址的 USDC 到账 → 持久化去重 → 打印各付款地址的 credit 汇总。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });

  console.log(`[payments] 扫描收款地址 ${config.paymentAddress} 的 USDC 到账 ...`);
  const incoming = await scanDeposits(
    client,
    config.paymentAddress,
    config.assetAddress,
  );
  const existing = loadDeposits();
  const { all, added } = mergeDeposits(existing, incoming);

  if (added.length > 0) {
    saveDeposits(all);
    console.log(`[payments] 新增 ${added.length} 笔到账，累计 ${all.length} 笔`);
  } else {
    console.log(`[payments] 无新到账，累计 ${all.length} 笔`);
  }

  const unit = 10n ** BigInt(config.assetDecimals);
  const creditByAddr = new Map<string, { usdc: bigint; credits: number }>();
  for (const d of all) {
    const key = d.from.toLowerCase();
    const cur = creditByAddr.get(key) ?? { usdc: 0n, credits: 0 };
    cur.usdc += d.amount;
    cur.credits = Number((cur.usdc * BigInt(config.creditPerUsdc)) / unit);
    creditByAddr.set(key, cur);
  }

  if (creditByAddr.size > 0) {
    console.log(
      `[payments] 付款地址明细（1 USDC = ${config.creditPerUsdc} credits）:`,
    );
    for (const [addr, v] of creditByAddr) {
      console.log(
        `  ${addr}: ${formatUnits(v.usdc, config.assetDecimals)} ${config.assetSymbol} -> ${v.credits} credits`,
      );
    }
  } else {
    console.log(`[payments] 暂无付款记录（历史余额可能早于扫描窗口）`);
  }

  if (added.length > 0) {
    console.log(`[payments] ⚠️ 新增到账需重启 API 服务才会计入可用额度`);
  }
}

main().catch((err) => {
  console.error("[payments] 失败:", err);
  process.exit(1);
});
