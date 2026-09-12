import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http } from "viem";
import { loadConfig } from "../config.js";
import { LabelStore } from "../labels/store.js";
import { clusterByFunder } from "../labels/cluster.js";
import { explainTransaction } from "../tx/explain.js";

/**
 * bridge-watch MCP server（stdio 传输）。
 * 让 Claude / Cursor / ChatGPT 等 AI agent 能直接调用链上情报能力。
 *
 * 工具：
 *   get_label          地址身份标签（10 万实体标签库）
 *   explain_transaction 交易解释
 *   detect_cluster     女巫/实体聚类
 */

/** JSON 序列化时把 bigint 转字符串，避免 JSON.stringify 抛错 */
function jsonSafe(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const labelStore = new LabelStore();

  const server = new McpServer({ name: "bridge-watch", version: "0.1.0" });

  server.tool(
    "get_label",
    "查询一个 EVM 地址的身份标签（10 万实体标签库：交易所/桥/协议/诈骗等），返回该地址属于哪个实体",
    { address: z.string().describe("0x 开头的地址，如 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") },
    async ({ address }) => {
      const label = labelStore.resolve(address.toLowerCase() as `0x${string}`);
      return {
        content: [
          {
            type: "text",
            text: jsonSafe({ address, label }),
          },
        ],
      };
    },
  );

  server.tool(
    "explain_transaction",
    "解释一笔交易做了什么：状态、发起方/接收方（含身份标签）、转账明细、是否疑似跨链桥操作",
    { txHash: z.string().describe("0x 开头的交易哈希") },
    async ({ txHash }) => {
      const e = await explainTransaction({
        client,
        txHash: txHash as `0x${string}`,
        assetAddress: config.assetAddress,
        assetDecimals: config.assetDecimals,
        assetSymbol: config.assetSymbol,
        labelStore,
      });
      return { content: [{ type: "text", text: jsonSafe(e) }] };
    },
  );

  server.tool(
    "detect_cluster",
    "检测一个出资方地址资助的地址集合（共享资金来源聚类），用于女巫/实体识别",
    { funder: z.string().describe("0x 开头的出资方地址") },
    async ({ funder }) => {
      const cluster = await clusterByFunder(
        client,
        funder.toLowerCase() as `0x${string}`,
        config.assetAddress,
      );
      return { content: [{ type: "text", text: jsonSafe(cluster) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[mcp] 启动失败:", err);
  process.exit(1);
});
