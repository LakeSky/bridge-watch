/**
 * CCTP 目标链配置：域 ID → 目标链 RPC + MessageTransmitter 地址。
 * 目前只填了已验证的 Ethereum（domain 0）；其他链可按下表追加（地址需先用 eth_getCode 验证）。
 */

export interface Destination {
  domain: number;
  name: string;
  rpcUrl: string;
  messageTransmitter: `0x${string}`;
}

export const DESTINATIONS: Record<number, Destination> = {
  0: {
    domain: 0,
    name: "Ethereum",
    rpcUrl: "https://ethereum.publicnode.com",
    messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
  },
};

export function getDestination(domain: number): Destination | null {
  return DESTINATIONS[domain] ?? null;
}
