/**
 * 标签库数据模型。
 * 这是整个项目的护城河层：地址 → 身份 + 实体聚类。
 * 参考 OLI（Open Labels Initiative）的 schema 思想，但保持极简可扩展。
 */

export type LabelCategory =
  | "token" // 代币/资产合约
  | "exchange" // 交易所（冷/热钱包）
  | "bridge" // 跨链桥
  | "protocol" // DeFi 协议 / 金库
  | "market_maker" // 做市商
  | "whale" // 巨鲸
  | "scam" // 诈骗/钓鱼地址
  | "other";

export interface Label {
  address: `0x${string}`;
  /** 人类可读名称，如 "USD Coin (USDC)" / "Binance Hot Wallet" */
  name: string;
  category: LabelCategory;
  /** 标签来源，如 "curated" / "eth-labels" / "defillama" / "llm" / "community" */
  source: string;
  /** 置信度 0–1；人工确认 = 1，LLM 预打标 = 0.6–0.9，启发式 = 0–0.6 */
  confidence: number;
  /** 来源链 ID（可选）；EVM 地址跨链可重复，标注来源链可避免误归因 */
  chainId?: number;
}

/** 实体聚类结果：一组疑似同一实体控制的地址 */
export interface Cluster {
  /** 聚类依据说明 */
  reason: string;
  /** 成员地址（含种子地址） */
  members: `0x${string}`[];
  /** 聚类置信度 0–1 */
  confidence: number;
}

/** 地址解析结果：一个地址的身份画像 */
export interface AddressProfile {
  address: `0x${string}`;
  /** 直接命中的标签（可能为 null） */
  label: Label | null;
  /** 疑似关联的地址（实体聚类） */
  cluster: Cluster | null;
}
