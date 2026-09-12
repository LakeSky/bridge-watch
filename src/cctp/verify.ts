import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import type { Destination } from "./destinations.js";

/**
 * CCTP 跨链到账验证。
 *
 * ⚠️ 版本发现（Week 7 实测）：
 *  - Base 的 TokenMessenger 发的是 **V1** 的 DepositForBurn（nonce 为 uint64，按源域计数）；
 *  - 以太坊的 MessageTransmitter 是 **V2**，其 usedNonces 以 **bytes32 nonce**（全局唯一）为键。
 * 两者 nonce 不是简单对应（V2 的 nonce 是消息的 bytes32 标识，非 bytes32(uint64)）。
 *
 * 因此：本函数已用正确的 V2 签名 `usedNonces(bytes32) => uint256`（0=未到账），
 * 但要与 V1 存款事件对应，需解 V2 的存款事件拿到 bytes32 nonce —— 留作 Week 8。
 */

const MESSAGE_TRANSMITTER_V2_ABI = parseAbi([
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);

/** 查询某 bytes32 nonce 是否已在目标链处理（0=未到账，非 0=已到账） */
export async function checkArrivalV2(
  dest: Destination,
  nonce: `0x${string}`,
): Promise<boolean> {
  const client: PublicClient = createPublicClient({ transport: http(dest.rpcUrl) });
  const used = await client.readContract({
    address: dest.messageTransmitter,
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "usedNonces",
    args: [nonce],
  });
  return (used as bigint) !== 0n;
}
