import { describe, it, expect, vi } from "vitest";
import type { Destination } from "./destinations.js";
import { v1NonceToV2, checkCctpArrival } from "./verify.js";

/**
 * v1NonceToV2 是项目里最关键、也最容易被算错的纯函数（CCTP V1→V2 nonce 转换）。
 * 这里重点覆盖边界：domain / nonce 的 0 值、最大值、以及字节布局正确性。
 */

describe("v1NonceToV2", () => {
  it("基础用例：Base 域(domain=6) + nonce=1", () => {
    // 布局：domain(4B=8hex) + nonce(8B=16hex) + 20B 零 = 32B
    expect(v1NonceToV2(6, 1n)).toBe(
      "0x0000000600000000000000010000000000000000000000000000000000000000",
    );
  });

  it("全 0：domain=0, nonce=0 → 64 个零", () => {
    expect(v1NonceToV2(0, 0n)).toBe("0x" + "0".repeat(64));
  });

  it("小 nonce 大端左补零：domain=1, nonce=255(0xff)", () => {
    expect(v1NonceToV2(1, 255n)).toBe(
      "0x0000000100000000000000ff0000000000000000000000000000000000000000",
    );
  });

  it("大 domain + 大 nonce 不溢出/不截断：domain=9999(0x270f), nonce=123456(0x1e240)", () => {
    expect(v1NonceToV2(9999, 123456n)).toBe(
      "0x0000270f000000000001e2400000000000000000000000000000000000000000",
    );
  });

  it("uint64 上限：nonce=2^64-1 仍为 16 位十六进制、不被截断", () => {
    const max = 18446744073709551615n; // 0xffffffffffffffff
    expect(max.toString(16)).toBe("ffffffffffffffff"); // 恰好 16 字符
    expect(v1NonceToV2(0, max)).toBe(
      "0x00000000ffffffffffffffff0000000000000000000000000000000000000000",
    );
  });

  it("uint32 上限：domain=4294967295(0xffffffff) 仍为 8 位十六进制", () => {
    expect((4294967295).toString(16)).toBe("ffffffff"); // 恰好 8 字符
    expect(v1NonceToV2(4294967295, 0n)).toBe(
      "0x" + "f".repeat(8) + "0".repeat(16 + 40),
    );
  });

  it("返回值是合法 0x + 64 位十六进制（32 字节）", () => {
    const out = v1NonceToV2(6, 42n);
    expect(out.startsWith("0x")).toBe(true);
    expect(out.length).toBe(2 + 64); // 0x + 64 hex
    expect(/^0x[0-9a-f]{64}$/.test(out)).toBe(true);
  });

  it("字节布局正确：前 4 字节=domain、中 8 字节=nonce、后 20 字节=0", () => {
    const out = v1NonceToV2(6, 42n).slice(2); // 去 0x
    const domainHex = out.slice(0, 8);
    const nonceHex = out.slice(8, 24);
    const zeroTail = out.slice(24);
    expect(domainHex).toBe("00000006");
    expect(nonceHex).toBe("000000000000002a"); // 42 = 0x2a
    expect(zeroTail).toBe("0".repeat(40));
  });

  it("确定性：相同输入产生相同输出", () => {
    expect(v1NonceToV2(6, 7n)).toBe(v1NonceToV2(6, 7n));
  });
});

/**
 * checkCctpArrival 依赖 viem 的 createPublicClient，这里用 vi.mock 替换掉，
 * 只验证「V2 nonce 查询 usedNonces → 是否到账」的映射逻辑。
 */
const { mockReadContract } = vi.hoisted(() => ({
  mockReadContract: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ readContract: mockReadContract })),
  };
});

const DEST = {
  domain: 0,
  name: "Ethereum",
  rpcUrl: "https://example.invalid",
  messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
} as unknown as Destination;

describe("checkCctpArrival", () => {
  it("usedNonces 返回非 0 → 已到账", async () => {
    mockReadContract.mockResolvedValue(1n);
    expect(await checkCctpArrival(DEST, 6, 1n)).toBe(true);
  });

  it("usedNonces 返回 0 → 未到账", async () => {
    mockReadContract.mockResolvedValue(0n);
    expect(await checkCctpArrival(DEST, 6, 1n)).toBe(false);
  });

  it("查询抛错 → 降级为未到账（不向上抛）", async () => {
    mockReadContract.mockRejectedValue(new Error("rpc down"));
    expect(await checkCctpArrival(DEST, 6, 1n)).toBe(false);
  });

  it("调用 readContract 时传入正确的 V2 nonce 与 messageTransmitter 地址", async () => {
    mockReadContract.mockResolvedValue(1n);
    const v2 = v1NonceToV2(6, 99n);
    await checkCctpArrival(DEST, 6, 99n);
    expect(mockReadContract).toHaveBeenCalledTimes(1);
    const call = mockReadContract.mock.calls[0]![0];
    expect(call.address).toBe(DEST.messageTransmitter);
    expect(call.functionName).toBe("usedNonces");
    expect(call.args[0]).toBe(v2);
  });
});
