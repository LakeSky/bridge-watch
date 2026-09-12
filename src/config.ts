import "dotenv/config";
import { z } from "zod";

/**
 * 环境变量加载与校验。
 * 用 zod 做运行时校验：配置错误在启动时立即失败并给出明确提示，
 * 而不是运行到一半才抛莫名其妙的错误。
 */

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "必须是合法的 0x 地址");

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive().default(8453),
  RPC_URL: z.string().url().default("https://mainnet.base.org"),

  ASSET_ADDRESS: addressSchema.default(
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base USDC
  ),
  ASSET_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  ASSET_SYMBOL: z.string().default("USDC"),

  // 逗号分隔的监控地址列表；允许为空（由调用方再决定是否报错）
  WATCH_ADDRESSES: z.string().default(""),

  LARGE_OUTFLOW_USDC: z.coerce.number().positive().default(100_000),
  DRAIN_PERCENT: z.coerce.number().min(1).max(100).default(25),
  DRAIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),

  // API 服务（Week 5）
  API_KEYS: z.string().default(""),
  API_PORT: z.coerce.number().int().positive().default(4022),
  API_CREDITS: z.coerce.number().int().positive().default(1000),

  // USDC 收款（Week 9）
  PAYMENT_ADDRESS: addressSchema.default(
    "0x381cdbb664608bf7b1dd4f9403a572c1c57332c2",
  ),
  CREDIT_PER_USDC: z.coerce.number().int().positive().default(100),
});

export interface AppConfig {
  chainId: number;
  rpcUrl: string;
  assetAddress: `0x${string}`;
  assetDecimals: number;
  assetSymbol: string;
  /** 监控对象地址列表（已解析） */
  watchAddresses: `0x${string}`[];
  /** 单笔大额转出阈值（资产原始单位，bigint） */
  largeOutflow: bigint;
  drainPercent: number;
  drainWindowSeconds: number;
  pollIntervalSeconds: number;
  telegramBotToken: string;
  telegramChatId: string;
  apiKeys: string[];
  apiPort: number;
  apiCredits: number;
  paymentAddress: `0x${string}`;
  creditPerUsdc: number;
}

/** 把人类可读的 USDC 金额转成资产原始单位（bigint） */
function usdcToRaw(usdc: number, decimals: number): bigint {
  // 用字符串拼接避免浮点乘法精度问题（如 0.1*10^6 之类）
  const [intPart, fracPart = ""] = usdc.toString().split(".") as [
    string,
    string?,
  ];
  const whole = BigInt(intPart) * 10n ** BigInt(decimals);
  const frac = BigInt((fracPart + "0".repeat(decimals)).slice(0, decimals) || "0");
  return whole + frac;
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`环境变量配置错误:\n${issues}`);
  }
  const e = parsed.data;

  const watchAddresses = e.WATCH_ADDRESSES.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => addressSchema.parse(s)) as `0x${string}`[];

  return {
    chainId: e.CHAIN_ID,
    rpcUrl: e.RPC_URL,
    assetAddress: e.ASSET_ADDRESS as `0x${string}`,
    assetDecimals: e.ASSET_DECIMALS,
    assetSymbol: e.ASSET_SYMBOL,
    watchAddresses,
    largeOutflow: usdcToRaw(e.LARGE_OUTFLOW_USDC, e.ASSET_DECIMALS),
    drainPercent: e.DRAIN_PERCENT,
    drainWindowSeconds: e.DRAIN_WINDOW_SECONDS,
    pollIntervalSeconds: e.POLL_INTERVAL_SECONDS,
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChatId: e.TELEGRAM_CHAT_ID,
    apiKeys: e.API_KEYS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    apiPort: e.API_PORT,
    apiCredits: e.API_CREDITS,
    paymentAddress: e.PAYMENT_ADDRESS as `0x${string}`,
    creditPerUsdc: e.CREDIT_PER_USDC,
  };
}
