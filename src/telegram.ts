import type { Alert } from "./types.js";

const TELEGRAM_API = "https://api.telegram.org";

/**
 * Telegram 告警发送器。
 * 设计原则：告警通道永远不能把主监控流程搞崩 ——
 * 任何发送失败都降级为控制台输出，绝不向上抛异常。
 */
export class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;
  readonly enabled: boolean;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = Boolean(botToken && chatId);
  }

  async send(alert: Alert): Promise<void> {
    const text = formatAlert(alert);
    console.log(formatLogLine(alert, text));

    if (!this.enabled) return;

    try {
      const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`[telegram] 发送失败 HTTP ${res.status}: ${body}`);
      }
    } catch (err) {
      // 网络失败等：仅记录，不影响监控
      console.warn(`[telegram] 发送异常: ${(err as Error).message}`);
    }
  }
}

/** 人类可读金额（把 raw 按 decimals 转成字符串，最多 6 位小数） */
export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0");
  const trimmed = frac.replace(/0+$/, "").slice(0, 6);
  const fracPart = trimmed ? `.${trimmed}` : "";
  return `${neg ? "-" : ""}${int}${fracPart}`;
}

function formatAlert(a: Alert): string {
  const sev = { info: "ℹ️", warn: "⚠️", critical: "🚨" }[a.severity];
  const fields = Object.entries(a.fields)
    .map(([k, v]) => `<b>${escapeHtml(k)}</b>: ${escapeHtml(v)}`)
    .join("\n");
  return `${sev} <b>${escapeHtml(a.title)}</b>\n\n${fields}`;
}

function formatLogLine(a: Alert, text: string): string {
  return `[${new Date(a.ts).toISOString()}] [${a.severity.toUpperCase()}] ${a.kind} ${a.address}\n${text}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
