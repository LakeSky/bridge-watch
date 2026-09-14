import { describe, it, expect } from "vitest";
import {
  detectLargeTransfers,
  detectDrain,
  dedup,
  type RuleInput,
} from "./rules.js";
import type { Alert, BalanceSnapshot, TransferEvent, WatchState } from "./types.js";

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ADDR_C = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

function makeInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    address: ADDR_A,
    transfers: [],
    history: [],
    largeOutflow: 100_000n * 10n ** 6n, // 10 万 USDC（6 位小数）
    drainPercent: 25,
    drainWindowSeconds: 600,
    now: Date.now(),
    formatAmount: (raw) => `${raw.toString()} USDC`,
    ...overrides,
  };
}

function makeTransfer(overrides: Partial<TransferEvent> = {}): TransferEvent {
  return {
    from: ADDR_A,
    to: ADDR_B,
    value: 50_000n * 10n ** 6n,
    txHash: ("0x" + "11".repeat(32)) as `0x${string}`,
    blockNumber: 1000n,
    ...overrides,
  };
}

// ============================================================
// detectLargeTransfers
// ============================================================
describe("detectLargeTransfers", () => {
  it("空转账列表返回空告警", () => {
    const input = makeInput();
    expect(detectLargeTransfers(input)).toEqual([]);
  });

  it("小额转出不触发告警", () => {
    const input = makeInput({
      transfers: [makeTransfer({ value: 1000n * 10n ** 6n })], // 1000 USDC
    });
    expect(detectLargeTransfers(input)).toEqual([]);
  });

  it("大额转出触发 large_outflow 告警（critical）", () => {
    const value = 200_000n * 10n ** 6n; // 20 万 USDC
    const input = makeInput({
      transfers: [makeTransfer({ from: ADDR_A, to: ADDR_B, value })],
    });
    const alerts = detectLargeTransfers(input);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("large_outflow");
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.address).toBe(ADDR_A);
    expect(alerts[0]!.fields["转出到"]).toBe(ADDR_B);
  });

  it("大额转入触发 large_inflow 告警（info）", () => {
    const value = 150_000n * 10n ** 6n;
    const input = makeInput({
      transfers: [makeTransfer({ from: ADDR_B, to: ADDR_A, value })],
    });
    const alerts = detectLargeTransfers(input);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("large_inflow");
    expect(alerts[0]!.severity).toBe("info");
    expect(alerts[0]!.fields["来源"]).toBe(ADDR_B);
  });

  it("等于阈值刚好触发", () => {
    const value = 100_000n * 10n ** 6n; // 恰好等于阈值
    const input = makeInput({
      transfers: [makeTransfer({ value })],
    });
    expect(detectLargeTransfers(input)).toHaveLength(1);
  });

  it("阈值 -1 不触发", () => {
    const value = 100_000n * 10n ** 6n - 1n;
    const input = makeInput({
      transfers: [makeTransfer({ value })],
    });
    expect(detectLargeTransfers(input)).toHaveLength(0);
  });

  it("多笔转账：多笔大额分别告警", () => {
    const input = makeInput({
      transfers: [
        makeTransfer({ from: ADDR_A, to: ADDR_B, value: 200_000n * 10n ** 6n }),
        makeTransfer({ from: ADDR_C, to: ADDR_A, value: 300_000n * 10n ** 6n }),
        makeTransfer({ value: 1000n * 10n ** 6n }), // 小额，忽略
      ],
    });
    const alerts = detectLargeTransfers(input);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.kind).toBe("large_outflow");
    expect(alerts[1]!.kind).toBe("large_inflow");
  });

  it("地址大小写不敏感", () => {
    const value = 200_000n * 10n ** 6n;
    // 监控地址是全小写的 ADDR_A，转账 from 是大写的
    const input = makeInput({
      address: ADDR_A.toLowerCase() as `0x${string}`,
      transfers: [
        makeTransfer({ from: ADDR_A.toUpperCase() as `0x${string}`, value }),
      ],
    });
    expect(detectLargeTransfers(input)).toHaveLength(1);
  });

  it("既不是 from 也不是 to 的转账不触发", () => {
    const input = makeInput({
      transfers: [
        makeTransfer({
          from: ADDR_B,
          to: ADDR_C,
          value: 500_000n * 10n ** 6n,
        }),
      ],
    });
    expect(detectLargeTransfers(input)).toHaveLength(0);
  });
});

// ============================================================
// detectDrain
// ============================================================
describe("detectDrain", () => {
  const NOW = 1_700_000_000_000;
  const WINDOW_MS = 600 * 1000; // 10 分钟

  function makeHistory(
    points: Array<{ offsetSec: number; asset: bigint }>,
  ): BalanceSnapshot[] {
    return points.map((p) => ({
      ts: NOW - p.offsetSec * 1000,
      native: 0n,
      asset: p.asset,
    }));
  }

  function drainInput(history: BalanceSnapshot[]): RuleInput {
    return makeInput({
      history,
      now: NOW,
      drainWindowSeconds: 600,
      drainPercent: 25,
    });
  }

  it("历史记录不足 2 条返回 null", () => {
    expect(detectDrain(drainInput([]))).toBeNull();
    expect(
      detectDrain(
        drainInput(makeHistory([{ offsetSec: 0, asset: 1000n }])),
      ),
    ).toBeNull();
  });

  it("余额稳定不触发抽干", () => {
    const history = makeHistory([
      { offsetSec: 600, asset: 1_000_000n },
      { offsetSec: 0, asset: 950_000n }, // 只降了 5%
    ]);
    expect(detectDrain(drainInput(history))).toBeNull();
  });

  it("余额下降超阈值触发 balance_drain 告警", () => {
    const history = makeHistory([
      { offsetSec: 300, asset: 1_000_000n }, // 峰值
      { offsetSec: 0, asset: 600_000n }, // 降了 40%
    ]);
    const alert = detectDrain(drainInput(history));
    expect(alert).not.toBeNull();
    expect(alert!.kind).toBe("balance_drain");
    expect(alert!.severity).toBe("critical");
    expect(alert!.fields["峰值余额"]).toContain("1000000");
    expect(alert!.fields["当前余额"]).toContain("600000");
    expect(alert!.fields["下降比例"]).toBe("40.00%");
  });

  it("用窗口内峰值做基准，而非窗口起点", () => {
    // 窗口起点余额低 → 中间冲高 → 回落（从峰值降了 30%）
    const history = makeHistory([
      { offsetSec: 599, asset: 500_000n }, // 窗口起点，低
      { offsetSec: 300, asset: 1_000_000n }, // 峰值
      { offsetSec: 0, asset: 700_000n }, // 当前，从峰值降 30%
    ]);
    const alert = detectDrain(drainInput(history));
    expect(alert).not.toBeNull();
    expect(alert!.fields["下降比例"]).toBe("30.00%");
  });

  it("窗口外的数据不参与计算", () => {
    // 601 秒前的数据在窗口外，即使是更高的峰值也不计入
    const history = makeHistory([
      { offsetSec: 601, asset: 2_000_000n }, // 窗口外，忽略
      { offsetSec: 300, asset: 1_000_000n }, // 窗口内峰值
      { offsetSec: 0, asset: 800_000n }, // 从峰值降 20%，未到 25% 阈值
    ]);
    expect(detectDrain(drainInput(history))).toBeNull();
  });

  it("余额上升不触发（峰值 = 当前）", () => {
    const history = makeHistory([
      { offsetSec: 300, asset: 500_000n },
      { offsetSec: 0, asset: 1_000_000n },
    ]);
    expect(detectDrain(drainInput(history))).toBeNull();
  });

  it("峰值为 0 时不触发（防除零）", () => {
    const history = makeHistory([
      { offsetSec: 300, asset: 0n },
      { offsetSec: 0, asset: 0n },
    ]);
    expect(detectDrain(drainInput(history))).toBeNull();
  });

  it("刚好等于阈值百分比时触发", () => {
    // 从 1,000,000 降到 750,000 = 正好 25%
    const history = makeHistory([
      { offsetSec: 300, asset: 1_000_000n },
      { offsetSec: 0, asset: 750_000n },
    ]);
    const alert = detectDrain(drainInput(history));
    expect(alert).not.toBeNull();
    expect(alert!.fields["下降比例"]).toBe("25.00%");
  });

  it("窗口内只有 1 条有效数据返回 null", () => {
    // 两条历史，但一条在窗口外，窗口内只有 1 条
    const history = makeHistory([
      { offsetSec: 700, asset: 1_000_000n }, // 窗口外
      { offsetSec: 0, asset: 500_000n }, // 窗口内唯一一条
    ]);
    expect(detectDrain(drainInput(history))).toBeNull();
  });
});

// ============================================================
// dedup
// ============================================================
describe("dedup", () => {
  function makeState(): WatchState {
    return {
      address: ADDR_A,
      history: [],
      lastBlock: 0n,
      lastAlertAt: new Map(),
    };
  }

  function makeAlert(kind: Alert["kind"], ts: number): Alert {
    return {
      kind,
      severity: "critical",
      address: ADDR_A,
      title: "test",
      fields: {},
      ts,
    };
  }

  it("空告警列表返回空", () => {
    const state = makeState();
    expect(dedup(state, [], 60_000, 1_700_000_000_000)).toEqual([]);
  });

  it("首次告警全部通过", () => {
    const state = makeState();
    const now = 1_700_000_000_000;
    const alerts = [
      makeAlert("large_outflow", now),
      makeAlert("balance_drain", now),
    ];
    const result = dedup(state, alerts, 60_000, now);
    expect(result).toHaveLength(2);
  });

  it("冷却期内同规则告警被过滤", () => {
    const state = makeState();
    const now = 1_700_000_000_000;
    const alerts = [makeAlert("large_outflow", now)];

    // 第一次：通过
    const first = dedup(state, alerts, 60_000, now);
    expect(first).toHaveLength(1);

    // 30 秒后，同样规则：被过滤
    const second = dedup(state, [makeAlert("large_outflow", now + 30_000)], 60_000, now + 30_000);
    expect(second).toHaveLength(0);
  });

  it("冷却期过后重新放行", () => {
    const state = makeState();
    const now = 1_700_000_000_000;
    const cooldown = 60_000; // 60 秒

    dedup(state, [makeAlert("large_outflow", now)], cooldown, now);

    // 61 秒后，超过冷却期：放行
    const later = dedup(
      state,
      [makeAlert("large_outflow", now + cooldown + 1000)],
      cooldown,
      now + cooldown + 1000,
    );
    expect(later).toHaveLength(1);
  });

  it("不同规则互不影响", () => {
    const state = makeState();
    const now = 1_700_000_000_000;
    const cooldown = 60_000;

    // 先触发 large_outflow
    dedup(state, [makeAlert("large_outflow", now)], cooldown, now);

    // 紧接着 large_inflow 仍可触发（不同规则）
    const inflow = dedup(state, [makeAlert("large_inflow", now + 1000)], cooldown, now + 1000);
    expect(inflow).toHaveLength(1);
  });

  it("去重 key 基于 address + kind", () => {
    const now = 1_700_000_000_000;
    const cooldown = 60_000;

    // 两个不同地址的同类型告警，应独立去重
    const alertA: Alert = {
      ...makeAlert("large_outflow", now),
      address: ADDR_A,
    };
    const alertB: Alert = {
      ...makeAlert("large_outflow", now),
      address: ADDR_B,
    };

    const stateA = makeState();
    stateA.address = ADDR_A;
    const stateB = makeState();
    stateB.address = ADDR_B;

    dedup(stateA, [alertA], cooldown, now);
    // B 的状态不受 A 影响
    const resultB = dedup(stateB, [alertB], cooldown, now);
    expect(resultB).toHaveLength(1);
  });
});
