/**
 * 钱回路端到端闭环测试（目标对齐 · 最高优先级）。
 *
 * 既有测试已分别锁死：
 *   - credit-daemon.test.ts：daemon 扫描链上到账 → 写入 credits-inbox（tick 闭环）
 *   - billing.inbox.test.ts：api 进程消费 inbox → 自动入账（幂等）
 *
 * 但**没有一个测试在 server 层把"客户视角"的闭环跑通**：
 *   全新付款地址（从未调用、未付款）
 *     → 401 未知身份（不能白嫖，也不能误判）
 *     → 模拟 daemon 把 USDC 到账入账（写 credits-inbox）
 *     → 同一地址再次调用 → 自动消费 inbox → 200 且 remaining 正确扣减（付款后真正可用！）
 *     → 额度耗尽 → 402 + 充值指引含 payTo（闭环完整，能引导下一个付费）
 *
 * 这是判断"代码全绿 ≠ 能赚钱"之后，证明【钱回路真能成立】的关键回归保护。
 * 不修改任何源码；用临时数据目录隔离，mock 访问日志避免污染真实 data/。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createApiServer } from "./server.js";
import { LocalBilling } from "./billing.js";
import { appendInbox, type CreditEntry } from "../payment/credit-inbox.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabelStore } from "../labels/store.js";

// 仅隔离：访问日志中间件写入真实 data/access.jsonl，测试里替换成 no-op
vi.mock("./accesslog.js", () => ({
  accessLog: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  accessSummary: () => ({
    logFile: "",
    sampled: 0,
    last24h: 0,
    last: null,
    topPaths: [],
    topIps: [],
  }),
}));

// 关闭 free-tier，纯净验证"纯付款"路径（避免免费额度掩盖入账逻辑）
process.env.FREE_TIER_CREDITS = "0";

const PAY_TO = "0x381cdbb664608bf7b1dd4f9403a572c1c57332c2";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// 仅用于通过地址正则；标签库无此地址，返回 null 不影响断言
const LABEL_ADDR = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const PAYER = "0x1111111111111111111111111111111111111111";
const SMALL = "0x2222222222222222222222222222222222222222";

describe("钱回路端到端：未知→付款→自动入账→可用→耗尽402", () => {
  let tmp: string;
  let billing: LocalBilling;
  let server: import("http").Server;
  let base: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "bw-ml-"));
    billing = new LocalBilling(tmp);
    const app = createApiServer({
      client: {} as never,
      labelStore: new LabelStore(),
      billing,
      validKeys: new Set<string>(),
      assetAddress: ASSET,
      assetDecimals: 6,
      assetSymbol: "USDC",
      payTo: PAY_TO,
      creditPerUsdc: 100,
    });
    await new Promise<void>((res) => {
      server = app.listen(0, res);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const auth = (addr: string) => ({
    headers: { authorization: `Bearer ${addr}` },
  });

  /** 模拟 credit-daemon：把一笔到账换算后的 credit 写入与 billing 同目录的 inbox */
  const creditViaDaemon = (key: string, credits: number, txHash: string) => {
    const entry: CreditEntry = {
      key: key.toLowerCase(),
      credits,
      txHash,
      logIndex: 0,
      ts: Date.now(),
    };
    return appendInbox([entry], join(tmp, "credits-inbox.json"));
  };

  it("① 全新付款地址（从未调用、未付款）→ 401 未知身份", async () => {
    const r = await fetch(`${base}/v1/label/${LABEL_ADDR}`, auth(PAYER));
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toMatch(/invalid or missing/i);
    // 未付款也未调用，账本不应出现该身份
    expect(billing.balance(PAYER)).toBe(0);
  });

  it("② 模拟 daemon 把 1 USDC 到账入账到该地址（写入 credits-inbox）", () => {
    const queued = creditViaDaemon(PAYER, 100, "0xpay1");
    expect(queued).toBe(1);
  });

  it("③ 同一地址再次调用 → 自动消费 inbox → 200 且 remaining=99（付款后真正可用！）", async () => {
    const r = await fetch(`${base}/v1/label/${LABEL_ADDR}`, auth(PAYER));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { remaining: number };
    expect(body.remaining).toBe(99);
    // 账本确实记下了该身份（known 路径成立）
    expect(billing.known?.(PAYER)).toBe(true);
  });

  it("④ 额度耗尽 → 402 且充值指引含 payTo / creditPerUsdc（闭环完整）", async () => {
    // 另起一个只充 1 credit 的地址，避免上面的 99 credit 干扰
    expect(creditViaDaemon(SMALL, 1, "0xpay2")).toBe(1);
    const r1 = await fetch(`${base}/v1/label/${LABEL_ADDR}`, auth(SMALL));
    expect(r1.status).toBe(200); // 用掉唯一 1 credit
    const r2 = await fetch(`${base}/v1/label/${LABEL_ADDR}`, auth(SMALL));
    expect(r2.status).toBe(402);
    const body = (await r2.json()) as {
      recharge: { payTo: string; creditPerUsdc: number };
    };
    expect(body.recharge.payTo).toBe(PAY_TO);
    expect(body.recharge.creditPerUsdc).toBe(100);
  });

  it("⑤ 幂等：同笔到账重复入账不会多给额度", async () => {
    const before = billing.balance(PAYER); // 99（③ 后），且无新到账
    const queued = creditViaDaemon(PAYER, 100, "0xpay1"); // 与 ② 同 txHash:logIndex
    expect(queued).toBe(0); // 去重，实际新增 0
    // 触发一次请求让 billing 消费（若有新内容）
    await fetch(`${base}/v1/label/${LABEL_ADDR}`, auth(PAYER));
    const after = billing.balance(PAYER);
    // 没有重复加 100；实际应比 before 少 1（本次调用又扣了 1 credit）
    expect(after).toBe(before - 1);
  });
});
