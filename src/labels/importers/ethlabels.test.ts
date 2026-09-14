import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchEthLabels } from "./ethlabels.js";

// eth-labels 导入器此前零测试覆盖。
// 本测试通过 mock 全局 fetch 驱动 fetchEthLabels，验证：
//  - inferCategory 分类（bridge / exchange / scam / other）
//  - 地址小写归一 + 0x 前缀过滤（非法地址被跳过）
//  - name 回退（label → nameTag → "unknown"）
//  - 固定元数据（source="eth-labels" / confidence=0.8 / chainId 透传）
//  - 下载失败抛错
// 不修改任何源码，不污染真实网络。

interface EthLabelEntry {
  address: string;
  chainId: number;
  label: string;
  nameTag: string;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setResponse(entries: unknown[], ok = true): void {
  fetchMock.mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => entries,
  } as never);
}

describe("fetchEthLabels · 分类与归一", () => {
  it("空数组返回空数组", async () => {
    setResponse([]);
    const labels = await fetchEthLabels();
    expect(labels).toEqual([]);
  });

  it("交易所标签归类为 exchange，并携带固定元数据", async () => {
    setResponse([
      { address: "0xAbC1230000000000000000000000000000000001", chainId: 1, label: "Binance Hot Wallet", nameTag: "binance" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels).toHaveLength(1);
    const l = labels[0]!;
    expect(l.category).toBe("exchange");
    expect(l.name).toBe("Binance Hot Wallet");
    expect(l.source).toBe("eth-labels");
    expect(l.confidence).toBe(0.8);
    expect(l.chainId).toBe(1);
  });

  it("跨链桥标签归类为 bridge（优先级高于其他关键词）", async () => {
    setResponse([
      { address: "0x1111111111111111111111111111111111111111", chainId: 10, label: "Arbitrum Bridge", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels[0]!.category).toBe("bridge");
  });

  it("tornado/mixer 关键词归类为 scam", async () => {
    setResponse([
      { address: "0x2222222222222222222222222222222222222222", chainId: 1, label: "Tornado Cash Proxy", nameTag: "" },
      { address: "0x3333333333333333333333333333333333333333", chainId: 1, label: "Unknown Mixer v2", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels.map((l) => l.category)).toEqual(["scam", "scam"]);
  });

  it("无关键词的协议/路由归类为 other", async () => {
    setResponse([
      { address: "0x4444444444444444444444444444444444444444", chainId: 1, label: "Uniswap V3: Router", nameTag: "" },
      { address: "0x5555555555555555555555555555555555555555", chainId: 1, label: "Wrapped Ether (WETH)", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels.map((l) => l.category)).toEqual(["other", "other"]);
  });

  it("交易所关键词大小写不敏感（COINBASE / Kraken）", async () => {
    setResponse([
      { address: "0x6666666666666666666666666666666666666666", chainId: 1, label: "COINBASE 14", nameTag: "" },
      { address: "0x7777777777777777777777777777777777777777", chainId: 1, label: "Kraken Deposit", nameTag: "" },
      { address: "0x8888888888888888888888888888888888888888", chainId: 1, label: "OKX CeFi", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels.every((l) => l.category === "exchange")).toBe(true);
  });
});

describe("fetchEthLabels · 地址归一与过滤", () => {
  it("地址统一小写归一", async () => {
    setResponse([
      { address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01", chainId: 1, label: "Binance", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels[0]!.address).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("非 0x 地址被跳过", async () => {
    setResponse([
      { address: "notanaddress", chainId: 1, label: "Binance", nameTag: "" },
      { address: "0x9999999999999999999999999999999999999999", chainId: 1, label: "Kraken", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]!.address).toBe("0x9999999999999999999999999999999999999999");
  });

  it("空地址被跳过", async () => {
    setResponse([
      { address: "", chainId: 1, label: "Binance", nameTag: "" },
      { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", chainId: 1, label: "Kraken", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels).toHaveLength(1);
  });

  it("混合合法/非法时只保留合法项且数量正确", async () => {
    setResponse([
      { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", chainId: 1, label: "Kraken", nameTag: "" },
      { address: "bad", chainId: 1, label: "Binance", nameTag: "" },
      { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", chainId: 1, label: "Coinbase", nameTag: "" },
      { address: "", chainId: 1, label: "Gate", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels).toHaveLength(2);
    expect(labels.map((l) => l.address)).toEqual([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });
});

describe("fetchEthLabels · name 回退", () => {
  it("label 为空时回退到 nameTag", async () => {
    setResponse([
      { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", chainId: 1, label: "", nameTag: "Kraken deposit address" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels[0]!.name).toBe("Kraken deposit address");
  });

  it("label 与 nameTag 都为空时回退到 unknown", async () => {
    setResponse([
      { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", chainId: 1, label: "", nameTag: "" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels[0]!.name).toBe("unknown");
  });

  it("label 为空时分类按空字符串走 other 分支（已知行为，锁定基线）", async () => {
    // inferCategory 仅看 label 字段，nameTag 含交易所词也不影响分类。
    setResponse([
      { address: "0xcccccccccccccccccccccccccccccccccccccccc", chainId: 1, label: "", nameTag: "Binance cold wallet" },
    ]);
    const labels = await fetchEthLabels();
    expect(labels[0]!.category).toBe("other");
    expect(labels[0]!.name).toBe("Binance cold wallet");
  });
});

describe("fetchEthLabels · 错误处理", () => {
  it("下载返回非 2xx 时抛错", async () => {
    setResponse([], false);
    await expect(fetchEthLabels()).rejects.toThrow(/eth-labels 下载失败/);
  });

  it("调用时带上 bridge-watch user-agent", async () => {
    setResponse([]);
    await fetchEthLabels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(typeof url).toBe("string");
    expect((init as { headers?: Record<string, string> }).headers?.["user-agent"]).toBe("bridge-watch");
  });
});
