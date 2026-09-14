import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http } from "viem";
import { loadConfig } from "../config.js";
import { LabelStore } from "../labels/store.js";
import { clusterByFunder } from "../labels/cluster.js";
import { explainTransaction } from "../tx/explain.js";
import { queryAlerts, getAlertStats } from "../alerts/history.js";
import { extractCctpDeposits } from "../cctp/deposit.js";
import { trackCctpDeposit } from "../cctp/verify.js";
import { BASE_DOMAIN } from "../cctp/constants.js";

/**
 * bridge-watch MCP server。
 * 让 Claude / Cursor / ChatGPT 等 AI agent 能直接调用链上情报能力。
 *
 * 工具：
 *   get_label           地址身份标签（10 万实体标签库）
 *   explain_transaction 交易解释
 *   detect_cluster      女巫/实体聚类
 *   query_alerts        查询历史告警记录
 *   alert_stats         告警统计概览
 *   track_cctp          CCTP 跨链卡单追踪
 *
 * 传输：stdio（本地 CLI）和 Streamable HTTP（远程 /mcp 端点）。
 */

/** JSON 序列化时把 bigint 转字符串，避免 JSON.stringify 抛错 */
function jsonSafe(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

/** 创建 MCP server 实例（注册所有工具） */
export function createMcpServer(): McpServer {
  const config = loadConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const labelStore = new LabelStore();

  const server = new McpServer({ name: "bridge-watch", version: "0.2.0" });

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

  server.tool(
    "query_alerts",
    "查询历史告警记录，可按地址、规则类型、严重程度、时间范围过滤",
    {
      address: z.string().optional().describe("按监控地址过滤（0x 开头）"),
      kind: z.enum(["large_outflow", "large_inflow", "balance_drain", "startup"]).optional().describe("按告警类型过滤"),
      severity: z.enum(["info", "warn", "critical"]).optional().describe("按严重程度过滤"),
      limit: z.number().int().min(1).max(100).default(20).optional().describe("返回条数（默认 20，最多 100）"),
      hours: z.number().int().min(1).max(720).optional().describe("查询最近 N 小时的告警"),
    },
    async ({ address, kind, severity, limit, hours }) => {
      const since = hours ? Date.now() - hours * 3600 * 1000 : undefined;
      const alerts = queryAlerts({
        address,
        kind,
        severity,
        since,
        limit: limit ?? 20,
      });
      return {
        content: [
          {
            type: "text",
            text: jsonSafe({ count: alerts.length, alerts }),
          },
        ],
      };
    },
  );

  server.tool(
    "alert_stats",
    "获取告警统计概览：总数、按类型/严重程度/地址分布、最新告警时间",
    {
      hours: z.number().int().min(1).max(720).optional().describe("统计最近 N 小时的告警，不填则全部"),
    },
    async ({ hours }) => {
      const since = hours ? Date.now() - hours * 3600 * 1000 : undefined;
      const stats = getAlertStats(since);
      return { content: [{ type: "text", text: jsonSafe(stats) }] };
    },
  );

  server.tool(
    "track_cctp",
    "CCTP 跨链卡单追踪：输入源链交易哈希，查询这是哪笔跨链、转了多少、目标链是哪条、是否已到账。支持 Base → Ethereum 等 CCTP 支持的链。",
    {
      txHash: z.string().describe("源链上的交易哈希（0x 开头，66 字符）"),
    },
    async ({ txHash }) => {
      const receipt = await client.getTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
      const deposits = extractCctpDeposits(
        receipt.logs,
        txHash as `0x${string}`,
      );
      if (deposits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: jsonSafe({
                isCctp: false,
                message: "该交易不是 CCTP 跨链转账（未发现 DepositForBurn 事件）",
              }),
            },
          ],
        };
      }

      const results = await Promise.all(
        deposits.map((d) =>
          trackCctpDeposit(
            {
              amount: d.amount,
              depositor: d.depositor,
              mintRecipient: d.mintRecipient,
              destinationDomain: d.destinationDomain,
              destinationChain: d.destinationChain,
              nonce: d.nonce,
            },
            BASE_DOMAIN,
          ),
        ),
      );

      return {
        content: [
          {
            type: "text",
            text: jsonSafe({ isCctp: true, deposits: results }),
          },
        ],
      };
    },
  );

  return server;
}

/** 模块级单例，供 HTTP 传输复用（避免每次请求重建 PublicClient/LabelStore） */
let mcpServerInstance: McpServer | null = null;

/** 获取 MCP server 单例（远程 HTTP 端点用） */
export function getMcpServer(): McpServer {
  if (!mcpServerInstance) {
    mcpServerInstance = createMcpServer();
  }
  return mcpServerInstance;
}

/** stdio 入口（本地 CLI 用：npm run mcp） */
async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 仅当直接运行此文件时启动 stdio（被 import 时不启动）
if (process.argv[1]?.endsWith("mcp/index.js") || process.argv[1]?.endsWith("mcp/index.ts")) {
  main().catch((err) => {
    console.error("[mcp] 启动失败:", err);
    process.exit(1);
  });
}
