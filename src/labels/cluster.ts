import { parseAbiItem, type PublicClient, type Log } from "viem";
import type { Cluster } from "./types.js";

/**
 * 实体聚类启发式 v0：shared-funder（共享资金来源）。
 *
 * 原理：同一个出资地址（funder）向多个地址打款，这些收款地址很可能是
 * 同一实体控制的"马甲"（sybil / 女巫）。这是 bitiodine 多输入启发式在
 * EVM/账户模型下的等价物，也是最基础的实体聚类原语。
 *
 * 说明：v0 只扫 ERC20（USDC）转出，原生 ETH 的"资助"需要 trace 数据，Week 3 再补。
 */

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export interface ClusterOptions {
  /** 往前扫描多少区块 */
  windowBlocks: bigint;
  /** 最少成员数（含出资方）才判定为聚类 */
  minMembers: number;
}

const DEFAULTS: ClusterOptions = {
  windowBlocks: 2000n,
  minMembers: 3,
};

/** 找出被 funder 资助过的地址集合（候选实体聚类） */
export async function clusterByFunder(
  client: PublicClient,
  funder: `0x${string}`,
  assetAddress: `0x${string}`,
  opts?: Partial<ClusterOptions>,
): Promise<Cluster> {
  const { windowBlocks, minMembers } = { ...DEFAULTS, ...opts };
  const latest = await client.getBlockNumber();
  const fromBlock = latest > windowBlocks ? latest - windowBlocks : 0n;

  const logs = await client.getLogs({
    address: assetAddress,
    event: transferEvent,
    args: { from: funder },
    fromBlock,
    toBlock: latest,
  });

  const funded = new Set<`0x${string}`>();
  for (const log of logs) {
    const to = extractTo(log);
    if (!to) continue;
    // 排除自身与零地址，避免噪声
    if (to.toLowerCase() === funder.toLowerCase()) continue;
    if (to === "0x0000000000000000000000000000000000000000") continue;
    funded.add(to);
  }

  const members = [funder, ...funded];
  const isCluster = members.length >= minMembers;

  return {
    reason: `共享资金来源（funder ${funder} 在近 ${windowBlocks} 块内向 ${funded.size} 个地址转出）`,
    members: isCluster ? members : [],
    confidence: isCluster ? 0.4 : 0, // 启发式，低置信度，需 LLM/人工确认
  };
}

function extractTo(log: Log): `0x${string}` | null {
  const args = (
    log as Log & { args?: { to?: `0x${string}` } }
  ).args;
  return args?.to ?? null;
}
