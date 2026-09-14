import {
  createPublicClient,
  http,
  erc20Abi,
  parseAbiItem,
  type PublicClient,
  type Log,
} from "viem";
import type { AppConfig } from "./config.js";
import type { Alert, TransferEvent, WatchState } from "./types.js";
import { detectLargeTransfers, detectDrain, dedup, type RuleInput } from "./rules.js";
import { TelegramNotifier, formatUnits } from "./telegram.js";
import { LabelStore } from "./labels/store.js";
import { appendAlert } from "./alerts/history.js";

/**
 * 监控主循环：轮询余额 + 拉取 Transfer 日志 → 跑规则 → 发告警。
 *
 * 采用「轮询」而非 WebSocket 订阅，原因：
 *   1. 公共 RPC 的 WS 常不稳定/限流；
 *   2. 轮询天然幂等、易恢复（崩溃后只需从 lastBlock 继续）；
 *   3. Week 1 先求稳，Week 2 可换 Moralis Streams/Alchemy Notify 做推送。
 */

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** 首轮回看多少区块（让第一次运行就能看到近期活动，便于验证） */
const BACKFILL_BLOCKS = 200n;
/** 同一地址+规则的去重冷却（毫秒） */
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

export interface Monitor {
  pollOnce: () => Promise<number>;
  start: () => Promise<void>;
  stop: () => void;
}

export function createMonitor(
  config: AppConfig,
  notifier: TelegramNotifier,
): Monitor {
  const client: PublicClient = createPublicClient({
    transport: http(config.rpcUrl),
  });

  const states = new Map<`0x${string}`, WatchState>();
  const labelStore = new LabelStore();
  let running = false;

  const formatAmount = (raw: bigint) =>
    `${formatUnits(raw, config.assetDecimals)} ${config.assetSymbol}`;

  async function pollOnce(): Promise<number> {
    const latest = await client.getBlockNumber();
    let alertCount = 0;

    for (const address of config.watchAddresses) {
      // 惰性初始化状态
      let state = states.get(address);
      if (!state) {
        state = {
          address,
          history: [],
          lastBlock:
            latest > BACKFILL_BLOCKS ? latest - BACKFILL_BLOCKS : 0n,
          lastAlertAt: new Map(),
        };
        states.set(address, state);
      }

      try {
        // 1. 拉余额（原生 + 资产）
        const [native, asset] = await Promise.all([
          client.getBalance({ address }),
          client.readContract({
            address: config.assetAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }) as Promise<bigint>,
        ]);

        const now = Date.now();
        state.history.push({ ts: now, native, asset });
        // 只保留抽干窗口内的快照，避免内存无限增长
        const cutoff = now - config.drainWindowSeconds * 1000;
        state.history = state.history.filter((h) => h.ts >= cutoff);

        // 2. 拉 Transfer 日志（from / to 两向都要）
        const transfers = await fetchTransfers(
          client,
          config.assetAddress,
          address,
          state.lastBlock,
          latest,
        );
        state.lastBlock = latest + 1n;

        // 3. 跑规则
        const input: RuleInput = {
          address,
          transfers,
          history: state.history,
          largeOutflow: config.largeOutflow,
          drainPercent: config.drainPercent,
          drainWindowSeconds: config.drainWindowSeconds,
          now,
          formatAmount,
        };
        const alerts: Alert[] = detectLargeTransfers(input);
        const drain = detectDrain(input);
        if (drain) alerts.push(drain);

        // 4. 去重 + 标签富化 + 发送 + 落盘历史
        const fresh = dedup(state, alerts, ALERT_COOLDOWN_MS);
        for (const a of fresh) {
          const enriched = enrichAlert(a, labelStore);
          await notifier.send(enriched);
          appendAlert(enriched);
          alertCount++;
        }
      } catch (err) {
        // 单个地址失败不影响其它地址；记录后继续
        console.error(`[monitor] 轮询 ${address} 失败: ${(err as Error).message}`);
      }
    }

    return alertCount;
  }

  async function start(): Promise<void> {
    running = true;
    console.log(
      `[monitor] 启动：监控 ${config.watchAddresses.length} 个地址，资产 ${config.assetSymbol}，间隔 ${config.pollIntervalSeconds}s，大额转出阈值 ${formatAmount(config.largeOutflow)}，抽干阈值 ${config.drainPercent}%`,
    );

    while (running) {
      const t0 = Date.now();
      try {
        const n = await pollOnce();
        console.log(
          `[monitor] ${new Date().toISOString()} 轮询完成，发出 ${n} 条告警`,
        );
      } catch (err) {
        console.error(`[monitor] 轮询异常: ${(err as Error).message}`);
      }
      const elapsed = Date.now() - t0;
      const wait = Math.max(1000, config.pollIntervalSeconds * 1000 - elapsed);
      await sleep(wait);
    }
  }

  function stop(): void {
    running = false;
  }

  return { pollOnce, start, stop };
}

async function fetchTransfers(
  client: PublicClient,
  assetAddress: `0x${string}`,
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TransferEvent[]> {
  const [outLogs, inLogs] = await Promise.all([
    client.getLogs({
      address: assetAddress,
      event: transferEvent,
      args: { from: address },
      fromBlock,
      toBlock,
    }),
    client.getLogs({
      address: assetAddress,
      event: transferEvent,
      args: { to: address },
      fromBlock,
      toBlock,
    }),
  ]);

  const out = outLogs.map(toTransfer);
  const inn = inLogs.map(toTransfer);
  return [...out, ...inn];
}

/**
 * viem 的通用 `Log` 类型不含 `args`（`args` 只有在 `getLogs` 传 `event` 时才被
 * 类型系统注入），这里做一次窄化转换，避免引入 `any`。
 */
/**
 * 告警富化：用标签库回答"这个地址是谁"。
 * - 监控对象自身有标签 → 附上身份；
 * - 对手方（转出到/来源）有标签 → 附上对方身份。
 * 这样告警从"某地址动了多少钱"升级为"某个已知实体动了多少钱"。
 */
function enrichAlert(alert: Alert, store: LabelStore): Alert {
  const fields = { ...alert.fields };

  const selfLabel = store.resolve(alert.address);
  if (selfLabel) {
    fields["监控对象"] = `${selfLabel.name} (${selfLabel.category})`;
  }

  const counter = fields["转出到"] ?? fields["来源"];
  if (counter && counter.startsWith("0x")) {
    const cLabel = store.resolve(counter as `0x${string}`);
    if (cLabel) {
      fields["对方身份"] = `${cLabel.name} (${cLabel.category})`;
    }
  }

  return { ...alert, fields };
}

function toTransfer(log: Log): TransferEvent {
  const args = (
    log as Log & {
      args?: { from?: `0x${string}`; to?: `0x${string}`; value?: bigint };
    }
  ).args;
  return {
    from: (args?.from ?? ZERO_ADDRESS) as `0x${string}`,
    to: (args?.to ?? ZERO_ADDRESS) as `0x${string}`,
    value: args?.value ?? 0n,
    txHash: (log.transactionHash ?? ZERO_ADDRESS) as `0x${string}`,
    blockNumber: log.blockNumber ?? 0n,
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
