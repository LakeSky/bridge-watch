import type {
  Alert,
  BalanceSnapshot,
  TransferEvent,
  WatchState,
} from "./types.js";

/**
 * 检测规则（纯函数，无副作用，便于单测）。
 * Week 1 实现三个最核心的"桥风险"信号：
 *   1. large_outflow  —— 单笔大额转出（疑似资金外流/被盗）
 *   2. large_inflow   —— 单笔大额转入（信息性，观察资金动向）
 *   3. balance_drain  —— 窗口内余额显著下降（疑似抽干）
 *
 * 后续（Week 2+）可扩展：rug/撤池、钓鱼域名（chainpatrol 思路）、
 * finality 延迟、合约升级等，均在此文件追加纯函数。
 */

export interface RuleInput {
  address: `0x${string}`;
  transfers: TransferEvent[];
  history: BalanceSnapshot[];
  largeOutflow: bigint;
  drainPercent: number;
  drainWindowSeconds: number;
  now: number;
  /** 把资产原始单位格式化为人类可读字符串（如 "1,234.56 USDC"） */
  formatAmount: (raw: bigint) => string;
}

/** 大额转账检测：from/to 命中监控地址且金额 ≥ 阈值 */
export function detectLargeTransfers(input: RuleInput): Alert[] {
  const alerts: Alert[] = [];
  for (const t of input.transfers) {
    if (t.value < input.largeOutflow) continue;
    if (t.from.toLowerCase() === input.address.toLowerCase()) {
      alerts.push({
        kind: "large_outflow",
        severity: "critical",
        address: input.address,
        title: "大额转出告警",
        fields: {
          金额: input.formatAmount(t.value),
          转出到: t.to,
          交易: t.txHash,
          区块: t.blockNumber.toString(),
        },
        ts: input.now,
      });
    } else if (t.to.toLowerCase() === input.address.toLowerCase()) {
      alerts.push({
        kind: "large_inflow",
        severity: "info",
        address: input.address,
        title: "大额转入提示",
        fields: {
          金额: input.formatAmount(t.value),
          来源: t.from,
          交易: t.txHash,
          区块: t.blockNumber.toString(),
        },
        ts: input.now,
      });
    }
  }
  return alerts;
}

/** 抽干检测：窗口内余额从峰值下降超过 drainPercent */
export function detectDrain(input: RuleInput): Alert | null {
  if (input.history.length < 2) return null;

  const windowStart = input.now - input.drainWindowSeconds * 1000;
  const inWindow = input.history.filter((h) => h.ts >= windowStart);
  if (inWindow.length < 2) return null;

  // 用窗口内峰值做基准（避免把"正常波动"误判为抽干）
  const peak = inWindow.reduce((max, h) => (h.asset > max ? h.asset : max), 0n);
  const current = inWindow[inWindow.length - 1]!.asset;
  if (peak <= 0n) return null;

  const dropped = peak - current;
  const pct = Number((dropped * 10000n) / peak) / 100; // 精确到 0.01%
  if (pct < input.drainPercent) return null;

  return {
    kind: "balance_drain",
    severity: "critical",
    address: input.address,
    title: "疑似资金抽干告警",
    fields: {
      峰值余额: input.formatAmount(peak),
      当前余额: input.formatAmount(current),
      下降比例: `${pct.toFixed(2)}%`,
      窗口秒数: input.drainWindowSeconds.toString(),
    },
    ts: input.now,
  };
}

/** 告警去重：同一地址 + 同一规则在冷却期内只发一次
 *  @param now 可选的当前时间戳，用于测试注入；默认 Date.now()
 */
export function dedup(
  state: WatchState,
  alerts: Alert[],
  cooldownMs: number,
  now?: number,
): Alert[] {
  const t = now ?? Date.now();
  return alerts.filter((a) => {
    const key = `${a.address}:${a.kind}`;
    const last = state.lastAlertAt.get(key) ?? 0;
    if (t - last < cooldownMs) return false;
    state.lastAlertAt.set(key, t);
    return true;
  });
}
