/**
 * CCTP（Circle 跨链传输协议）常量。
 * 地址已通过 Base 主网 eth_getCode 验证存在。
 */

/** Base 主网 TokenMessenger（depositForBurn 的入口合约） */
export const BASE_TOKEN_MESSENGER =
  "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962" as const;

/** Base 主网 MessageTransmitter（目标链到账的记账合约） */
export const BASE_MESSAGE_TRANSMITTER =
  "0xAD09780d193884d503182aD4588450C416D6F9D4" as const;

/** Base 在 CCTP 中的源域 ID */
export const BASE_DOMAIN = 6;

/**
 * CCTP V1 域 ID → 链名。
 * 来源：Circle 文档 supported-domains。只列出确信的，其余显示 "domain N"。
 */
export const DOMAIN_NAMES: Record<number, string> = {
  0: "Ethereum",
  1: "Avalanche",
  2: "Optimism",
  3: "Arbitrum",
  6: "Base",
  7: "Polygon PoS",
};

export function domainName(domain: number): string {
  return DOMAIN_NAMES[domain] ?? `domain ${domain}`;
}
