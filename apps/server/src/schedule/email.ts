import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ScheduleAgendaModel,
  ScheduleEmailSettingsInput,
  ScheduleEmailSettingsPublic,
  ScheduleEmailTestResult,
  SchedulePlanSummary,
  ScheduleWindow,
} from "@codefly/protocol";
import nodemailer from "nodemailer";
import { AppError, isNotFound } from "../http/errors.js";

interface EmailFile {
  version?: unknown;
  host?: unknown;
  port?: unknown;
  secure?: unknown;
  user?: unknown;
  password?: unknown;
  from?: unknown;
  to?: unknown;
  updatedAt?: unknown;
}

interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  to: string;
  updatedAt: string | null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asPort(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
    ? value
    : fallback;
}

function normalizeConfig(raw: unknown): EmailConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const file = raw as EmailFile;
  const host = asString(file.host).trim();
  const from = asString(file.from).trim();
  const to = asString(file.to).trim();
  if (host === "" || from === "" || to === "") return null;
  return {
    host,
    port: asPort(file.port, 587),
    secure: file.secure === true,
    user: asString(file.user).trim(),
    password: asString(file.password),
    from,
    to,
    updatedAt:
      typeof file.updatedAt === "string" && file.updatedAt !== ""
        ? file.updatedAt
        : null,
  };
}

/**
 * SMTP settings for the schedule assistant. The password never leaves the
 * server; the recipient is fixed to the configured mailbox so the model can
 * never turn the tool into an outbound mail relay.
 */
export class ScheduleEmailConfigStore {
  private config: EmailConfig | null = null;

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      this.config = normalizeConfig(JSON.parse(raw));
    } catch (error) {
      if (!isNotFound(error)) {
        console.error("[schedule] ignoring unreadable email.json", error);
      }
    }
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  getInternal(): EmailConfig {
    if (this.config === null) {
      throw new AppError(
        "EMAIL_NOT_CONFIGURED",
        "尚未配置日程邮件 SMTP，请先在「邮件设置」中填写并保存。",
        400,
      );
    }
    return { ...this.config };
  }

  getPublic(): ScheduleEmailSettingsPublic {
    const config = this.config;
    if (config === null) {
      return {
        configured: false,
        host: "",
        port: 587,
        secure: false,
        user: "",
        hasPassword: false,
        passwordHint: null,
        from: "",
        to: "",
        updatedAt: null,
      };
    }
    return {
      configured: true,
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      hasPassword: config.password !== "",
      passwordHint:
        config.password === ""
          ? null
          : `••••${config.password.slice(-4)}`,
      from: config.from,
      to: config.to,
      updatedAt: config.updatedAt,
    };
  }

  async update(input: ScheduleEmailSettingsInput): Promise<ScheduleEmailSettingsPublic> {
    const previous = this.config;
    const password =
      input.password !== undefined && input.password !== ""
        ? input.password
        : input.clearPassword === true
          ? ""
          : (previous?.password ?? "");
    const config: EmailConfig = {
      host: input.host.trim(),
      port: input.port,
      secure: input.secure,
      user: input.user.trim(),
      password,
      from: input.from.trim(),
      to: input.to.trim(),
      updatedAt: new Date().toISOString(),
    };
    if (config.host === "" || config.from === "" || config.to === "") {
      throw new AppError(
        "INVALID_EMAIL_CONFIG",
        "SMTP host、发件地址和收件地址都不能为空。",
        400,
      );
    }
    await this.persist(config);
    this.config = config;
    return this.getPublic();
  }

  /** Builds a transient config for the test button without saving it. */
  resolveForTest(input: {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    password?: string;
    clearPassword?: boolean;
    from?: string;
    to?: string;
  }): EmailConfig {
    const base = this.config;
    const host = (input.host ?? base?.host ?? "").trim();
    const from = (input.from ?? base?.from ?? "").trim();
    const to = (input.to ?? base?.to ?? "").trim();
    if (host === "" || from === "" || to === "") {
      throw new AppError(
        "INVALID_EMAIL_CONFIG",
        "请先填写 SMTP host、发件地址和收件地址。",
        400,
      );
    }
    return {
      host,
      port: input.port ?? base?.port ?? 587,
      secure: input.secure ?? base?.secure ?? false,
      user: (input.user ?? base?.user ?? "").trim(),
      password:
        input.password !== undefined && input.password !== ""
          ? input.password
          : input.clearPassword === true
            ? ""
            : (base?.password ?? ""),
      from,
      to,
      updatedAt: base?.updatedAt ?? null,
    };
  }

  private async persist(config: EmailConfig): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, ...config }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.file);
    try {
      await chmod(this.file, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function transportFor(config: EmailConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user === "" ? undefined : { user: config.user, pass: config.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export class ScheduleEmailService {
  constructor(private readonly store: ScheduleEmailConfigStore) {}

  async test(input: {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    password?: string;
    clearPassword?: boolean;
    from?: string;
    to?: string;
  }): Promise<ScheduleEmailTestResult> {
    const started = Date.now();
    const config = this.store.resolveForTest(input);
    try {
      await transportFor(config).verify();
      return {
        ok: true,
        message: "SMTP 连接成功，可以发送邮件。",
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
      };
    }
  }

  async sendPlan(input: {
    window: ScheduleWindow;
    agenda: ScheduleAgendaModel;
    summary: SchedulePlanSummary;
    png: Buffer;
    fileName: string;
    note?: string;
  }): Promise<{ to: string; messageId: string | null }> {
    const config = this.store.getInternal();
    const { window, agenda, summary } = input;
    const subject = `CodeFly 日程 · ${window.startDate} ~ ${window.endDate}`;
    const lines = [
      `未来 ${agenda.days.length} 天日程：${window.startDate} ~ ${window.endDate}（时区 ${window.timezone}）`,
      `共 ${summary.taskCount} 项任务，计划 ${summary.totalPlannedMinutes} 分钟，已完成 ${summary.doneMinutes} 分钟。`,
    ];
    for (const day of agenda.days) {
      if (day.items.length === 0) continue;
      lines.push("", `${day.weekday} ${day.date} · 计划 ${day.plannedMinutes} 分钟`);
      for (const item of day.items) {
        const mark =
          item.status === "done" ? "✓" : item.status === "skipped" ? "—" : "·";
        const suffix =
          item.kind === "fixed"
            ? `（固定${item.location.trim() === "" ? "" : ` @${item.location.trim()}`}）`
            : "";
        lines.push(`  ${mark} ${item.start}-${item.end} ${item.title}${suffix}`);
      }
    }
    if (window.unscheduled.length > 0) {
      lines.push("", "未排期任务：");
      for (const item of window.unscheduled) {
        lines.push(`- ${item.title} · 剩余 ${item.remainingMinutes} 分钟 · ${item.reason}`);
      }
    }
    if (window.warnings.length > 0) {
      lines.push("", "提醒：");
      for (const warning of window.warnings) lines.push(`- ${warning}`);
    }
    if (window.notes.trim() !== "") {
      lines.push("", "备注：", window.notes.trim());
    }
    if (input.note !== undefined && input.note.trim() !== "") {
      lines.push("", "附言：", input.note.trim());
    }
    lines.push("", "日程图片见附件。");
    const dayHtml = agenda.days
      .filter((day) => day.items.length > 0)
      .map(
        (day) => `<h3 style="margin:16px 0 4px">${escapeHtml(day.weekday)} ${escapeHtml(
          day.date,
        )}</h3><ul style="margin:0">${day.items
          .map(
            (item) =>
              `<li>${escapeHtml(item.start)}-${escapeHtml(item.end)} ${escapeHtml(
                item.title,
              )}${item.kind === "fixed" ? "（固定）" : ""}</li>`,
          )
          .join("")}</ul>`,
      )
      .join("");
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;line-height:1.6">
<h2 style="margin:0 0 8px">CodeFly 未来 ${agenda.days.length} 天日程</h2>
<p style="margin:0 0 4px;color:#6b7280">${window.startDate} ~ ${window.endDate} · ${window.timezone}</p>
<p style="margin:12px 0">共 <b>${summary.taskCount}</b> 项任务，计划 <b>${summary.totalPlannedMinutes}</b> 分钟，已完成 <b>${summary.doneMinutes}</b> 分钟。</p>
${dayHtml}
${window.unscheduled.length > 0 ? `<h3>未排期任务</h3><ul>${window.unscheduled.map((item) => `<li>${escapeHtml(item.title)} · 剩余 ${item.remainingMinutes} 分钟 · ${escapeHtml(item.reason)}</li>`).join("")}</ul>` : ""}
${window.warnings.length > 0 ? `<h3>提醒</h3><ul>${window.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
${input.note !== undefined && input.note.trim() !== "" ? `<p style="margin-top:12px"><b>附言：</b>${escapeHtml(input.note)}</p>` : ""}
<p style="margin-top:16px;color:#6b7280">日程图片见附件。</p>
</div>`;

    const result = await transportFor(config).sendMail({
      from: config.from,
      to: config.to,
      subject,
      text: lines.join("\n"),
      html,
      attachments: [
        {
          filename: input.fileName,
          content: input.png,
          contentType: "image/png",
        },
      ],
    });
    return { to: config.to, messageId: result.messageId ?? null };
  }
}
