/**
 * 共享类型定义。
 * 金额一律用 bigint（链上原始单位）在内部传递，避免浮点精度问题；
 * 仅在展示/配置边界做人类可读单位的换算。
 */

export type AlertSeverity = "info" | "warn" | "critical";

export type AlertKind =
  | "large_outflow"
  | "large_inflow"
  | "balance_drain"
  | "startup";

export interface Alert {
  /** 触发规则种类 */
  kind: AlertKind;
  severity: AlertSeverity;
  /** 相关地址 */
  address: `0x${string}`;
  /** 人类可读标题 */
  title: string;
  /** 详情（键值对，用于格式化输出） */
  fields: Record<string, string>;
  /** 事件时间（毫秒时间戳） */
  ts: number;
}

/** 单个监控对象的运行状态（随轮询推进） */
export interface WatchState {
  address: `0x${string}`;
  /** 余额历史（用于抽干检测），按时间升序 */
  history: BalanceSnapshot[];
  /** 已处理的 Transfer 日志起始块（避免重复处理） */
  lastBlock: bigint;
  /** 规则去重：ruleKey -> 上次告警时间戳 */
  lastAlertAt: Map<string, number>;
}

export interface BalanceSnapshot {
  ts: number;
  native: bigint;
  asset: bigint;
}

/** ERC20 Transfer 事件（已归一化） */
export interface TransferEvent {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
}
