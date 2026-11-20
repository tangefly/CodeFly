import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Mail,
  XCircle,
} from "lucide-react";
import type { ScheduleEmailSettingsInput } from "@codefly/protocol";
import { asApiError } from "../../lib/api.js";
import { useAppStore } from "../../lib/store.js";
import { cn } from "../../lib/utils.js";
import { Button, Modal } from "../ui.js";

const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/45 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">{label}</span>
        {hint ? (
          <span className="text-[9px] text-muted-foreground/60">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function ScheduleEmailSettingsDialog() {
  const open = useAppStore((state) => state.ui.scheduleEmailSettingsOpen);
  const close = useAppStore((state) => state.closeScheduleEmailSettings);
  const current = useAppStore((state) => state.scheduleEmailSettings);
  const saveSettings = useAppStore(
    (state) => state.saveScheduleEmailSettings,
  );
  const testEmail = useAppStore((state) => state.testScheduleEmail);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    latencyMs: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setHost(current?.host ?? "");
    setPort(String(current?.port ?? 587));
    setSecure(current?.secure ?? false);
    setUser(current?.user ?? "");
    setPassword("");
    setClearPassword(false);
    setFrom(current?.from ?? "");
    setTo(current?.to ?? "");
    setFormError(null);
    setTestResult(null);
    setSaving(false);
    setTesting(false);
  }, [open, current?.updatedAt]);

  const parseForm = (): ScheduleEmailSettingsInput | null => {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
      setFormError("端口必须是 1 到 65535 之间的整数。");
      return null;
    }
    if (host.trim() === "") {
      setFormError("请填写 SMTP 主机地址。");
      return null;
    }
    if (!isEmail(from.trim()) || !isEmail(to.trim())) {
      setFormError("发件地址和收件地址必须是合法邮箱。");
      return null;
    }
    setFormError(null);
    return {
      host: host.trim(),
      port: portNumber,
      secure,
      user: user.trim(),
      from: from.trim(),
      to: to.trim(),
      ...(password !== "" ? { password } : {}),
      ...(clearPassword ? { clearPassword: true } : {}),
    };
  };

  const runTest = async (): Promise<void> => {
    const settings = parseForm();
    if (!settings) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testEmail({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        user: settings.user,
        from: settings.from,
        to: settings.to,
        ...(password !== "" ? { password } : {}),
        ...(clearPassword ? { clearPassword: true } : {}),
      });
      setTestResult(result);
    } catch (error) {
      setFormError(asApiError(error).message);
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    const settings = parseForm();
    if (!settings) return;
    setSaving(true);
    const ok = await saveSettings(settings);
    setSaving(false);
    if (ok) close();
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : close}
      title="日程邮件设置"
      description="SMTP 只用于把日程图片发到你自己的邮箱；助手不能修改收件人。"
      className="max-w-xl"
      footer={
        <>
          <Button variant="outline" size="sm" disabled={saving} onClick={close}>
            关闭
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={saving || testing || host.trim() === ""}
            onClick={() => void runTest()}
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            测试连接
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || testing}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存配置"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
          <Mail className="h-3.5 w-3.5 text-primary" />
          <span>
            当前状态：
            <span
              className={cn(
                current?.configured ? "text-primary" : "text-warning",
              )}
            >
              {current?.configured ? "已配置" : "未配置"}
            </span>
            {current?.configured ? (
              <span className="ml-2">
                收件人 <span className="font-mono text-foreground/70">{current.to}</span>
              </span>
            ) : null}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SMTP 主机" hint="例如 smtp.gmail.com">
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              className={INPUT_CLASS}
              placeholder="smtp.example.com"
              autoComplete="off"
            />
          </Field>
          <Field label="端口" hint="465 通常配合 SSL">
            <input
              value={port}
              onChange={(event) => setPort(event.target.value)}
              className={INPUT_CLASS}
              inputMode="numeric"
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={secure}
            onChange={(event) => setSecure(event.target.checked)}
          />
          使用 SSL/TLS（端口 465）；587 通常关闭并使用 STARTTLS
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="用户名" hint="可留空">
            <input
              value={user}
              onChange={(event) => setUser(event.target.value)}
              className={INPUT_CLASS}
              placeholder="you@example.com"
              autoComplete="username"
            />
          </Field>
          <Field
            label="密码 / 授权码"
            hint={current?.passwordHint ?? "保存后不再回显"}
          >
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT_CLASS}
              placeholder="留空表示保持不变"
              autoComplete="new-password"
            />
          </Field>
        </div>

        {current?.hasPassword ? (
          <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={clearPassword}
              onChange={(event) => setClearPassword(event.target.checked)}
            />
            清除已保存的密码（本地中继通常不需要认证）
          </label>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="发件地址">
            <input
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={INPUT_CLASS}
              placeholder="codefly@example.com"
              autoComplete="off"
            />
          </Field>
          <Field label="收件地址（你自己）">
            <input
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className={INPUT_CLASS}
              placeholder="you@example.com"
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background/40 px-3 py-2 text-[10px] leading-5 text-muted-foreground">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            密码保存在本机 <code className="font-mono">data/schedule/email.json</code>
            （权限 0600），不会返回前端，也不会通过模型 API 发送。建议使用邮箱的
            SMTP 授权码而不是登录密码。
          </span>
        </div>

        {formError ? (
          <p className="flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[10px] leading-5 text-danger">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {formError}
          </p>
        ) : null}
        {testResult ? (
          <p
            className={cn(
              "flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[10px] leading-5",
              testResult.ok
                ? "border-primary/30 bg-primary/5 text-primary"
                : "border-danger/30 bg-danger/5 text-danger",
            )}
          >
            {testResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            {testResult.message}（{testResult.latencyMs} ms）
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
