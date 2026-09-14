import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import type { Destination } from "./destinations.js";
import { BASE_DOMAIN } from "./constants.js";

/**
 * CCTP 跨链到账验证。
 *
 * 版本说明：
 *  - Base 的 TokenMessenger 是 V1，DepositForBurn 事件中的 nonce 是 uint64（按源域计数）；
 *  - 目标链（如 Ethereum）的 MessageTransmitter 是 V2，usedNonces 以 bytes32 nonce 为键。
 *
 * V1→V2 nonce 转换规则（Circle CCTP 规范）：
 *   V2_nonce = bytes32( abi.encodePacked( uint32(sourceDomain), uint64(v1_nonce) ) )
 * 即：前 4 字节 = 源域 ID（大端），中间 8 字节 = nonce（大端），后 20 字节 = 0。
 */

const MESSAGE_TRANSMITTER_V2_ABI = parseAbi([
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);

/**
 * 将 V1 的 uint64 nonce + 源域 ID 转换为 V2 的 bytes32 nonce。
 * 格式：bytes32(abi.encodePacked(uint32(sourceDomain), uint64(nonce)))
 */
export function v1NonceToV2(
  sourceDomain: number,
  v1Nonce: bigint,
): `0x${string}` {
  // 4 字节 sourceDomain（大端） + 8 字节 nonce（大端） + 20 字节 0 = 32 字节
  const domainHex = sourceDomain.toString(16).padStart(8, "0"); // 4 字节 = 8 hex chars
  const nonceHex = v1Nonce.toString(16).padStart(16, "0"); // 8 字节 = 16 hex chars
  const zeros = "0".repeat(40); // 20 字节 = 40 hex chars
  return `0x${domainHex}${nonceHex}${zeros}` as `0x${string}`;
}

/**
 * 查询某笔 CCTP 转账是否已在目标链到账。
 * @param dest 目标链配置
 * @param sourceDomain 源域 ID（如 Base = 6）
 * @param v1Nonce 源链 DepositForBurn 事件中的 uint64 nonce
 * @returns 是否已到账
 */
export async function checkCctpArrival(
  dest: Destination,
  sourceDomain: number,
  v1Nonce: bigint,
): Promise<boolean> {
  const v2Nonce = v1NonceToV2(sourceDomain, v1Nonce);
  const client: PublicClient = createPublicClient({ transport: http(dest.rpcUrl) });
  try {
    const used = await client.readContract({
      address: dest.messageTransmitter,
      abi: MESSAGE_TRANSMITTER_V2_ABI,
      functionName: "usedNonces",
      args: [v2Nonce],
    });
    return (used as bigint) !== 0n;
  } catch (err) {
    console.warn(
      `[cctp] 查询目标链 ${dest.name} 到账状态失败: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * 便捷函数：给定一笔源链的 CCTP 存款信息，查询目标链到账状态。
 * 这是 track CLI 和 API 端点的共用逻辑。
 */
export interface CctpTrackResult {
  amount: bigint;
  depositor: `0x${string}`;
  mintRecipient: `0x${string}`;
  sourceDomain: number;
  destinationDomain: number;
  destinationChain: string;
  v1Nonce: bigint;
  v2Nonce: `0x${string}`;
  /** 是否已在目标链到账 */
  arrived: boolean;
  /** 目标链是否配置了到账查询 */
  destinationConfigured: boolean;
}

export interface CctpDepositInfo {
  amount: bigint;
  depositor: `0x${string}`;
  mintRecipient: `0x${string}`;
  destinationDomain: number;
  destinationChain: string;
  nonce: bigint;
}

export async function trackCctpDeposit(
  deposit: CctpDepositInfo,
  sourceDomain: number = BASE_DOMAIN,
): Promise<CctpTrackResult> {
  const { getDestination } = await import("./destinations.js");
  const dest = getDestination(deposit.destinationDomain);
  const v2Nonce = v1NonceToV2(sourceDomain, deposit.nonce);

  let arrived = false;
  let destinationConfigured = false;

  if (dest) {
    destinationConfigured = true;
    arrived = await checkCctpArrival(dest, sourceDomain, deposit.nonce);
  }

  return {
    amount: deposit.amount,
    depositor: deposit.depositor,
    mintRecipient: deposit.mintRecipient,
    sourceDomain,
    destinationDomain: deposit.destinationDomain,
    destinationChain: deposit.destinationChain,
    v1Nonce: deposit.nonce,
    v2Nonce,
    arrived,
    destinationConfigured,
  };
}
