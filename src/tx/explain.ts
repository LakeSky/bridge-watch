import {
  decodeEventLog,
  parseAbiItem,
  type PublicClient,
} from "viem";
import { formatUnits } from "../telegram.js";
import { LabelStore } from "../labels/store.js";
import type { Label } from "../labels/types.js";

/**
 * 交易解释器：回答"这笔交易做了什么 / 我的币去哪了"。
 * 这是"卡单追踪"的第一步——先把单笔交易讲清楚，再（Week 5+）做跨链 deposit→withdraw 匹配。
 */

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface DecodedTransfer {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
}

export interface TxExplanation {
  txHash: `0x${string}`;
  status: "success" | "failed" | "unknown";
  from: `0x${string}`;
  to: `0x${string}` | null;
  nativeValue: bigint;
  transfers: DecodedTransfer[];
  /** 涉及地址的标签命中（from / to） */
  labels: { from: Label | null; to: Label | null };
  /** 是否疑似跨链桥操作 */
  isBridgeRelated: boolean;
  bridgeHint: string | null;
}

export interface ExplainInput {
  client: PublicClient;
  txHash: `0x${string}`;
  assetAddress: `0x${string}`;
  assetDecimals: number;
  assetSymbol: string;
  labelStore: LabelStore;
}

export async function explainTransaction(
  input: ExplainInput,
): Promise<TxExplanation> {
  const { client, txHash, assetAddress } = input;

  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash }),
    client.getTransactionReceipt({ hash: txHash }),
  ]);

  // 1. 解码 USDC Transfer 日志
  const transfers: DecodedTransfer[] = [];
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === assetAddress.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC
    ) {
      const decoded = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics,
      });
      const args = decoded.args as {
        from: `0x${string}`;
        to: `0x${string}`;
        value: bigint;
      };
      transfers.push({ from: args.from, to: args.to, value: args.value });
    }
  }

  // 2. 状态
  const status =
    receipt.status === "success"
      ? "success"
      : receipt.status === "reverted"
        ? "failed"
        : "unknown";

  // 3. 身份标注
  const fromLabel = input.labelStore.resolve(tx.from);
  const toLabel = tx.to ? input.labelStore.resolve(tx.to) : null;

  // 4. 桥识别：交易接收方 或 任一 USDC 收款方 被标记为 bridge
  const bridgeAddresses = new Set<`0x${string}`>();
  const checkBridge = (addr: `0x${string}`) => {
    const l = input.labelStore.resolve(addr);
    if (l?.category === "bridge") bridgeAddresses.add(addr);
  };
  if (tx.to) checkBridge(tx.to);
  for (const t of transfers) checkBridge(t.to);

  const isBridgeRelated = bridgeAddresses.size > 0;
  const bridgeHint = isBridgeRelated
    ? `检测到与桥合约交互（${[...bridgeAddresses].join(", ")}），疑似跨链转账：源链已转出，目标链到账需另行查询`
    : null;

  return {
    txHash,
    status,
    from: tx.from,
    to: tx.to,
    nativeValue: tx.value,
    transfers,
    labels: { from: fromLabel, to: toLabel },
    isBridgeRelated,
    bridgeHint,
  };
}

/** 把解释结果格式化为人类可读文本 */
export function formatExplanation(
  e: TxExplanation,
  decimals: number,
  symbol: string,
): string {
  const lines: string[] = [];
  lines.push(`交易   : ${e.txHash}`);
  lines.push(
    `状态   : ${e.status === "success" ? "✅ 成功" : e.status === "failed" ? "❌ 失败" : "❓ 未知"}`,
  );

  const fromName = e.labels.from ? ` (${e.labels.from.name})` : "";
  const toName = e.labels.to ? ` (${e.labels.to.name})` : "";
  lines.push(`发起方 : ${e.from}${fromName}`);
  lines.push(`接收方 : ${e.to ?? "（合约创建）"}${toName}`);

  if (e.nativeValue > 0n) {
    lines.push(`ETH    : ${formatUnits(e.nativeValue, 18)} ETH`);
  }

  if (e.transfers.length > 0) {
    lines.push(`${symbol} 转账 (${e.transfers.length} 笔):`);
    for (const t of e.transfers) {
      lines.push(
        `  ${t.from} → ${t.to} : ${formatUnits(t.value, decimals)} ${symbol}`,
      );
    }
  } else {
    lines.push(`${symbol} 转账: 无`);
  }

  if (e.isBridgeRelated) {
    lines.push(`判定   : 🌉 ${e.bridgeHint}`);
  }

  return lines.join("\n");
}
