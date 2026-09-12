import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PublicClient } from "viem";
import { LabelStore } from "../labels/store.js";
import { clusterByFunder } from "../labels/cluster.js";
import { explainTransaction } from "../tx/explain.js";
import { ENDPOINT_COST, type BillingProvider } from "./billing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ApiDeps {
  client: PublicClient;
  labelStore: LabelStore;
  billing: BillingProvider;
  validKeys: Set<string>;
  assetAddress: `0x${string}`;
  assetDecimals: number;
  assetSymbol: string;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

export function createApiServer(deps: ApiDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // 健康检查（免鉴权）
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // 公开落地页（免鉴权，可被发现）
  app.get("/", (_req, res) => {
    res.type("html").send(LANDING_HTML);
  });

  // OpenAPI 规范（免鉴权，供市场/程序发现）
  app.get("/openapi.yaml", (_req, res) => {
    try {
      const yaml = readFileSync(join(__dirname, "..", "..", "openapi.yaml"), "utf-8");
      res.type("application/yaml").send(yaml);
    } catch {
      res.status(404).send("openapi.yaml not found");
    }
  });

  // x402 manifest（供 x402 Bazaar / agent 发现端点）
  app.get("/.well-known/x402", (_req, res) => {
    res.json({
      x402Version: 2,
      resource: {
        url: "https://agentsapi.top/v1/label/{address}",
        description: "链上地址身份标签查询（10 万实体标签）",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "100", // 1 credit = 0.01 USDC = 1e4 (6 decimals)，此处为占位，实际按 credit 计费
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x381cdbb664608bf7b1dd4f9403a572c1c57332c2",
          maxTimeoutSeconds: 300,
        },
      ],
    });
  });

  // 鉴权 + 计量中间件：
  //  - 身份 = API key（预置额度）或付款地址（USDC 充值额度）
  //  - 未知身份 → 401；额度不足 → 402
  const requireKey =
    (cost: number) => async (req: Request, res: Response, next: NextFunction) => {
      const auth = req.headers.authorization ?? "";
      const key = auth.startsWith("Bearer ") ? auth.slice(7).toLowerCase() : "";
      const isKnown = deps.validKeys.has(key) || deps.billing.balance(key) > 0;
      if (!key || !isKnown) {
        res.status(401).json({ error: "invalid or missing API key" });
        return;
      }
      const charged = await deps.billing.charge(key, cost);
      if (!charged.ok) {
        res.status(402).json({
          error: "Payment Required: credits exhausted",
          remaining: charged.remaining,
          hint: `send USDC to ${deps.assetSymbol} payment address to recharge`,
        });
        return;
      }
      res.locals.remaining = charged.remaining;
      next();
    };

  // 查询余额（免扣费）
  app.get("/v1/me", requireKey(0), (req, res) => {
    const key = (req.headers.authorization ?? "").slice(7);
    res.json({ apiKey: key, remaining: res.locals.remaining });
  });

  // 标签查询
  app.get("/v1/label/:address", requireKey(ENDPOINT_COST.label), (req, res) => {
    const address = (req.params.address ?? "").toLowerCase();
    if (!ADDR_RE.test(address)) {
      res.status(400).json({ error: "invalid address" });
      return;
    }
    const label = deps.labelStore.resolve(address as `0x${string}`);
    res.json({ address, label, remaining: res.locals.remaining });
  });

  // 交易解释
  app.get(
    "/v1/explain/:txHash",
    requireKey(ENDPOINT_COST.explain),
    async (req, res) => {
      const txHash = req.params.txHash ?? "";
      if (!TX_RE.test(txHash)) {
        res.status(400).json({ error: "invalid tx hash" });
        return;
      }
      try {
        const explanation = await explainTransaction({
          ...deps,
          txHash: txHash as `0x${string}`,
        });
        res.json({ explanation, remaining: res.locals.remaining });
      } catch (err) {
        res
          .status(404)
          .json({ error: "tx not found", detail: (err as Error).message });
      }
    },
  );

  // 实体聚类
  app.get(
    "/v1/cluster/:funder",
    requireKey(ENDPOINT_COST.cluster),
    async (req, res) => {
      const funder = (req.params.funder ?? "").toLowerCase();
      if (!ADDR_RE.test(funder)) {
        res.status(400).json({ error: "invalid address" });
        return;
      }
      try {
        const cluster = await clusterByFunder(
          deps.client,
          funder as `0x${string}`,
          deps.assetAddress,
        );
        res.json({ funder, cluster, remaining: res.locals.remaining });
      } catch (err) {
        res
          .status(500)
          .json({ error: "cluster failed", detail: (err as Error).message });
      }
    },
  );

  return app;
}

const LANDING_HTML = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>bridge-watch · 链上风险情报 API</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    pre { background: #f4f4f4; padding: 12px; border-radius: 8px; overflow-x: auto; }
    h1 { font-size: 1.6em; } h2 { font-size: 1.2em; margin-top: 1.6em; }
    table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
  </style>
</head>
<body>
  <h1>bridge-watch · 链上风险情报 API</h1>
  <p>给加密开发者、交易者、协议方用的链上情报服务：<strong>这个地址是谁？这笔交易做了什么？这组地址是不是同一伙人？</strong></p>

  <h2>能力</h2>
  <table>
    <tr><th>接口</th><th>作用</th><th>价格</th></tr>
    <tr><td><code>/v1/label/:address</code></td><td>地址身份标签（10 万标签库）</td><td>1 credit</td></tr>
    <tr><td><code>/v1/explain/:txHash</code></td><td>交易解释</td><td>2 credits</td></tr>
    <tr><td><code>/v1/cluster/:funder</code></td><td>实体聚类 / 女巫检测</td><td>5 credits</td></tr>
  </table>

  <h2>定价</h2>
  <p>USDC 充值，<strong>1 USDC = 100 credits</strong>（label 查询约 $0.01/次）。</p>

  <h2>快速开始</h2>
  <pre>curl -H "Authorization: Bearer &lt;你的地址或API key&gt;" \\
  https://agentsapi.top/v1/label/0x0000000000001ff3684f28c67538d4d072c22734</pre>

  <h2>付款</h2>
  <p>发送 USDC（Base 主网）到收款地址 <code>0x381cdbb664608bf7b1dd4f9403a572c1c57332c2</code>，到账后即可用你的地址调 API。</p>

  <p><a href="/openapi.yaml">OpenAPI 规范</a> · <a href="/healthz">健康检查</a></p>
</body>
</html>`;

