import type { Label, LabelCategory } from "../types.js";

/**
 * eth-labels 导入器。
 * 数据源：https://github.com/dawsbot/eth-labels （公开地址标签数据集，~14 万条账户）
 * 原始格式：{ address, chainId, label(实体名), nameTag(描述) }
 */

const ETH_LABELS_URL =
  "https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/json/accounts.json";

interface EthLabelEntry {
  address: string;
  chainId: number;
  label: string;
  nameTag: string;
}

// 已知交易所关键词（用于粗分类，大小写不敏感）
const EXCHANGE_KEYWORDS = [
  "binance",
  "coinbase",
  "okx",
  "kraken",
  "kucoin",
  "gate",
  "bybit",
  "mexc",
  "bitfinex",
  "gemini",
  "bitget",
  "huobi",
  "crypto.com",
  "cryptocom",
  "upbit",
  "bithumb",
];

function inferCategory(label: string): LabelCategory {
  const l = label.toLowerCase();
  if (l.includes("bridge")) return "bridge";
  if (EXCHANGE_KEYWORDS.some((k) => l.includes(k))) return "exchange";
  if (l.includes("tornado") || l.includes("mixer")) return "scam";
  return "other";
}

/** 下载并转换 eth-labels 账户标签 */
export async function fetchEthLabels(
  url: string = ETH_LABELS_URL,
): Promise<Label[]> {
  const res = await fetch(url, {
    headers: { "user-agent": "bridge-watch" },
  });
  if (!res.ok) {
    throw new Error(`eth-labels 下载失败 HTTP ${res.status}`);
  }

  const entries = (await res.json()) as EthLabelEntry[];
  const labels: Label[] = [];
  for (const e of entries) {
    if (!e.address || !e.address.startsWith("0x")) continue;
    labels.push({
      address: e.address.toLowerCase() as `0x${string}`,
      // 用实体名（label）回答"这是谁"；nameTag 更具体但作为名称会淹没实体
      name: e.label || e.nameTag || "unknown",
      category: inferCategory(e.label || ""),
      source: "eth-labels",
      confidence: 0.8, // 公开社区数据集，中等信任
      chainId: e.chainId,
    });
  }
  return labels;
}
