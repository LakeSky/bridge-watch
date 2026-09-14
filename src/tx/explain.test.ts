import { describe, it, expect, vi } from "vitest";
import type { PublicClient, Log } from "viem";
import { pad, encodeAbiParameters } from "viem";
import type { Label } from "../labels/types.js";
import type { LabelStore } from "../labels/store.js";
import type { TxExplanation } from "./explain.js";
import { explainTransaction, formatExplanation } from "./explain.js";

// 标准 ERC20 Transfer 事件签名 topic（与 explain.ts 内部常量一致）
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ASSET = "0xc0ffee254729296a45a3885639ac7e10f9d54979" as `0x${string}`;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const BRIDGE = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const TX = ("0x" + "ab".repeat(32)) as `0x${string}`; // 合法 64 hex 长度 tx hash

function makeTransferLog(
  address: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
): Log {
  return {
    address,
    topics: [
      TRANSFER_TOPIC,
      pad(from, { size: 32 }),
      pad(to, { size: 32 }),
    ] as `0x${string}`[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  } as unknown as Log;
}

/** 受控的标签库：只对桥地址返回 bridge 标签，对 A 返回 whale 标签 */
function makeLabelStore() {
  const resolve = vi.fn((addr: `0x${string}`): Label | null => {
    const a = addr.toLowerCase();
    if (a === BRIDGE.toLowerCase())
      return {
        address: BRIDGE,
        name: "Test Bridge",
        category: "bridge",
        source: "test",
        confidence: 1,
      };
    if (a === A.toLowerCase())
      return {
        address: A,
        name: "Alice",
        category: "whale",
        source: "test",
        confidence: 0.9,
      };
    return null;
  });
  return { store: { resolve } as unknown as LabelStore, resolve };
}

function makeClient(over: {
  from?: `0x${string}`;
  to?: `0x${string}` | null;
  value?: bigint;
  status?: "success" | "reverted";
  logs?: Log[];
}) {
  const getTransaction = vi.fn(async () => ({
    from: over.from ?? A,
    to: over.to ?? B,
    value: over.value ?? 0n,
  }));
  const getTransactionReceipt = vi.fn(async () => ({
    status: over.status ?? "success",
    logs: over.logs ?? [],
  }));
  return {
    client: { getTransaction, getTransactionReceipt } as unknown as PublicClient,
    getTransaction,
    getTransactionReceipt,
  };
}

const baseInput = {
  assetAddress: ASSET,
  assetDecimals: 6,
  assetSymbol: "USDC",
};

describe("explainTransaction", () => {
  it("解码单笔 USDC Transfer 日志", async () => {
    const { store } = makeLabelStore();
    const { client, getTransaction, getTransactionReceipt } = makeClient({
      logs: [makeTransferLog(ASSET, A, B, 1_000_000n)],
    });
    const ex = await explainTransaction({
      ...baseInput,
      client,
      txHash: TX,
      labelStore: store,
    });
    expect(getTransaction).toHaveBeenCalledWith({ hash: TX });
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    expect(ex.transfers).toHaveLength(1);
    // 注意：decodeEventLog 返回的地址是 EIP-55 校验和（混合大小写），与原始小写常量比较需转小写
    expect(ex.transfers[0]!.from.toLowerCase()).toBe(A);
    expect(ex.transfers[0]!.to.toLowerCase()).toBe(B);
    expect(ex.transfers[0]!.value).toBe(1_000_000n);
  });

  it("忽略非资产合约地址的日志与非 Transfer topic", async () => {
    const { store } = makeLabelStore();
    const otherAsset = "0x9999999999999999999999999999999999999999" as `0x${string}`;
    const { client } = makeClient({
      logs: [
        makeTransferLog(otherAsset, A, B, 1_000_000n), // 资产不匹配
        makeTransferLog(ASSET, A, B, 2_000_000n), // 匹配
        { address: ASSET, topics: ["0xdeadbeef"], data: "0x00" } as unknown as Log, // 非 Transfer
      ],
    });
    const ex = await explainTransaction({
      ...baseInput,
      client,
      txHash: TX,
      labelStore: store,
    });
    expect(ex.transfers).toHaveLength(1);
    expect(ex.transfers[0]!.value).toBe(2_000_000n);
  });

  it("交易接收方是 bridge 标签 → 判定桥相关", async () => {
    const { store } = makeLabelStore();
    const { client } = makeClient({ to: BRIDGE });
    const ex = await explainTransaction({
      ...baseInput,
      client,
      txHash: TX,
      labelStore: store,
    });
    expect(ex.isBridgeRelated).toBe(true);
    expect(ex.bridgeHint).not.toBeNull();
  });

  it("某笔 USDC 收款方是 bridge 标签 → 判定桥相关", async () => {
    const { store } = makeLabelStore();
    const { client } = makeClient({
      to: B,
      logs: [makeTransferLog(ASSET, A, BRIDGE, 1_000_000n)],
    });
    const ex = await explainTransaction({
      ...baseInput,
      client,
      txHash: TX,
      labelStore: store,
    });
    expect(ex.isBridgeRelated).toBe(true);
  });

  it("无桥交互时 isBridgeRelated=false 且 bridgeHint=null", async () => {
    const { store } = makeLabelStore();
    const { client } = makeClient({
      to: B,
      logs: [makeTransferLog(ASSET, A, B, 1_000_000n)],
    });
    const ex = await explainTransaction({
      ...baseInput,
      client,
      txHash: TX,
      labelStore: store,
    });
    expect(ex.isBridgeRelated).toBe(false);
    expect(ex.bridgeHint).toBeNull();
  });

  it("receipt.status 映射：success→success / reverted→failed", async () => {
    const { store } = makeLabelStore();
    const okClient = makeClient({ status: "success" }).client;
    const failClient = makeClient({ status: "reverted" }).client;
    const ok = await explainTransaction({
      ...baseInput,
      client: okClient,
      txHash: TX,
      labelStore: store,
    });
    const fail = await explainTransaction({
      ...baseInput,
      client: failClient,
      txHash: TX,
      labelStore: store,
    });
    expect(ok.status).toBe("success");
    expect(fail.status).toBe("failed");
  });

  it("解析 from / to 标签", async () => {
    const { store, resolve } = makeLabelStore();
    const { client } = makeClient({ from: A, to: B });
    const ex = await explainTransaction({
      ...baseInput,
      client,
      txHash: TX,
      labelStore: store,
    });
    expect(resolve).toHaveBeenCalledWith(A);
    expect(resolve).toHaveBeenCalledWith(B);
    expect(ex.labels.from?.name).toBe("Alice");
    expect(ex.labels.to).toBeNull(); // B 无标签
  });
});

describe("formatExplanation", () => {
  const sample: TxExplanation = {
    txHash: TX,
    status: "success",
    from: A,
    to: B,
    nativeValue: 2_000_000_000_000_000_000n, // 2 ETH
    transfers: [{ from: A, to: B, value: 5_000_000n }], // 5 USDC @6 decimals
    labels: {
      from: {
        address: A,
        name: "Alice",
        category: "whale",
        source: "test",
        confidence: 0.9,
      },
      to: null,
    },
    isBridgeRelated: true,
    bridgeHint: "检测到与桥合约交互（0x1111…）",
  };

  it("输出包含交易摘要、状态、地址、金额与桥提示", () => {
    const out = formatExplanation(sample, 6, "USDC");
    expect(out).toContain(TX);
    expect(out).toContain("✅ 成功");
    expect(out).toContain("Alice"); // from 标签名
    expect(out).toContain("2 ETH"); // formatUnits(2e18,18) = "2"
    expect(out).toContain("5 USDC"); // formatUnits(5e6,6) = "5"
    expect(out).toContain("🌉"); // 桥提示
  });

  it("无转账时显示「无」分支", () => {
    const out = formatExplanation({ ...sample, transfers: [] }, 6, "USDC");
    expect(out).toContain(`${"USDC"} 转账: 无`);
  });

  it("nativeValue=0 时不输出 ETH 行", () => {
    const out = formatExplanation({ ...sample, nativeValue: 0n }, 6, "USDC");
    expect(out).not.toContain("ETH    :");
  });
});
