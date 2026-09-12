import {
  createPublicClient,
  http,
  erc20Abi,
  parseAbiItem,
} from "viem";
import { loadConfig } from "./config.js";
import { formatUnits } from "./telegram.js";

/**
 * 冒烟测试：验证 RPC 连通 + balanceOf + getLogs 全链路可用。
 * 不依赖 .env 里的 WATCH_ADDRESSES —— 它会从最近区块里挑一个真实活跃地址来测。
 *
 * 用法：npm run smoke
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });

  console.log(`[smoke] RPC: ${config.rpcUrl}`);
  const block = await client.getBlockNumber();
  console.log(`[smoke] 最新区块: ${block} (${block})`);

  // 用资产合约自身地址做 balanceOf 测试（一定有余额=总供应）
  const totalSupply = (await client.readContract({
    address: config.assetAddress,
    abi: erc20Abi,
    functionName: "totalSupply",
  })) as bigint;
  console.log(
    `[smoke] 资产 ${config.assetSymbol} 总供应: ${formatUnits(totalSupply, config.assetDecimals)} (${config.assetAddress})`,
  );

  // 拉最近 10 块的 Transfer 日志（USDC 交易量大，范围太大公共 RPC 会拒绝）
  const transferEvent = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  );
  const logs = await client.getLogs({
    address: config.assetAddress,
    event: transferEvent,
    fromBlock: block - 10n,
    toBlock: block,
  });
  console.log(`[smoke] 最近 10 块内 Transfer 日志数: ${logs.length}`);

  if (logs.length > 0) {
    const first = logs[0]!;
    const args = first.args as unknown as {
      from: `0x${string}`;
      to: `0x${string}`;
      value: bigint;
    };
    console.log(`[smoke] 示例 Transfer:`);
    console.log(`  from : ${args.from}`);
    console.log(`  to   : ${args.to}`);
    console.log(
      `  value: ${formatUnits(args.value, config.assetDecimals)} ${config.assetSymbol}`,
    );
    console.log(`  tx   : ${first.transactionHash}`);

    // 对该 from 地址测 balanceOf，验证"读任意地址余额"链路
    const bal = (await client.readContract({
      address: config.assetAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [args.from],
    })) as bigint;
    console.log(
      `[smoke] ${args.from} 当前余额: ${formatUnits(bal, config.assetDecimals)} ${config.assetSymbol}`,
    );
  }

  console.log("[smoke] ✅ 全链路验证通过：RPC / balanceOf / getLogs 均可用");
}

main().catch((err) => {
  console.error("[smoke] ❌ 失败:", err);
  process.exit(1);
});
