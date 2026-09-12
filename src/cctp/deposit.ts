import { decodeEventLog, parseAbiItem, type Log } from "viem";
import { BASE_TOKEN_MESSENGER, domainName } from "./constants.js";

/**
 * CCTP 存款识别（源链侧）。
 * 回答：这笔交易是不是 CCTP 跨链转账？转了多少、去哪条链、nonce 多少。
 *
 * 完整"是否到账"需要跨链查 MessageTransmitter.usedNonces，Week 7 补。
 */

const depositForBurnEvent = parseAbiItem(
  "event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)",
);

export interface CctpDeposit {
  nonce: bigint;
  burnToken: `0x${string}`;
  amount: bigint;
  depositor: `0x${string}`;
  mintRecipient: `0x${string}`;
  destinationDomain: number;
  /** 目标链名称 */
  destinationChain: string;
  txHash: `0x${string}`;
}

/** 从交易日志中提取 CCTP 存款事件（可能有多笔） */
export function extractCctpDeposits(
  logs: Log[],
  txHash: `0x${string}`,
): CctpDeposit[] {
  const deposits: CctpDeposit[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== BASE_TOKEN_MESSENGER.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: [depositForBurnEvent],
        data: log.data,
        topics: log.topics,
      });
      const args = decoded.args as {
        nonce: bigint;
        burnToken: `0x${string}`;
        amount: bigint;
        depositor: `0x${string}`;
        mintRecipient: `0x${string}`;
        destinationDomain: number;
      };
      deposits.push({
        nonce: args.nonce,
        burnToken: args.burnToken,
        amount: args.amount,
        depositor: args.depositor,
        mintRecipient: args.mintRecipient,
        destinationDomain: args.destinationDomain,
        destinationChain: domainName(args.destinationDomain),
        txHash,
      });
    } catch {
      // 该 TokenMessenger 日志不是 DepositForBurn（可能是其他事件），跳过
    }
  }
  return deposits;
}
