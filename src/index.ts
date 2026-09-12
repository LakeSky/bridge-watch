import { loadConfig } from "./config.js";
import { TelegramNotifier } from "./telegram.js";
import { createMonitor } from "./monitor.js";

/**
 * 入口。
 * 用法：
 *   cp .env.example .env  # 填入 WATCH_ADDRESSES（可选 Telegram）
 *   npm run dev
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (config.watchAddresses.length === 0) {
    console.error(
      "[启动失败] 未配置 WATCH_ADDRESSES。请在 .env 中填入至少一个要监控的桥合约/金库/巨鲸地址（逗号分隔）。",
    );
    process.exit(1);
  }

  const notifier = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramChatId,
  );
  console.log(
    `[启动] Telegram 告警${notifier.enabled ? "已启用" : "未配置（仅控制台输出）"}`,
  );

  const monitor = createMonitor(config, notifier);

  // 优雅退出
  const shutdown = (sig: string) => {
    console.log(`\n[退出] 收到 ${sig}，停止监控`);
    monitor.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await monitor.start();
}

main().catch((err) => {
  console.error("[致命错误]", err);
  process.exit(1);
});
