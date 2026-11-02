import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react";
import type {
  LlmSettingsInput,
  LlmTestInput,
  LlmTestResult,
} from "@codefly/protocol";
import { asApiError } from "../lib/api.js";
import { useAppStore } from "../lib/store.js";
import { cn } from "../lib/utils.js";
import { Button, Modal } from "./ui.js";

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

export function LlmSettingsDialog() {
  const open = useAppStore((state) => state.ui.llmSettingsOpen);
  const close = useAppStore((state) => state.closeLlmSettings);
  const current = useAppStore((state) => state.llmSettings);
  const saveLlmSettings = useAppStore((state) => state.saveLlmSettings);
  const testLlm = useAppStore((state) => state.testLlm);

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("120000");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setBaseUrl(current?.baseUrl ?? "");
    setModel(current?.model ?? "");
    setApiKey("");
    setTemperature(
      current?.temperature === null || current?.temperature === undefined
        ? ""
        : String(current.temperature),
    );
    setMaxTokens(
      current?.maxTokens === null || current?.maxTokens === undefined
        ? ""
        : String(current.maxTokens),
    );
    setSystemPrompt(current?.systemPrompt ?? "");
    setTimeoutMs(String(current?.timeoutMs ?? 120000));
    setClearApiKey(false);
    setFormError(null);
    setTestResult(null);
    setSaving(false);
    setTesting(false);
  }, [open, current?.updatedAt]);

  const parseForm = (): { settings: LlmSettingsInput; test: LlmTestInput } | null => {
    const base = baseUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(base)) {
      setFormError("Base URL 必须以 http:// 或 https:// 开头。");
      return null;
    }
    const modelValue = model.trim();
    if (modelValue === "") {
      setFormError("Model 不能为空。");
      return null;
    }

    let temperatureValue: number | null = null;
    if (temperature.trim() !== "") {
      temperatureValue = Number(temperature);
      if (
        !Number.isFinite(temperatureValue) ||
        temperatureValue < 0 ||
        temperatureValue > 2
      ) {
        setFormError("Temperature 必须在 0 到 2 之间。");
        return null;
      }
    }

    let maxTokensValue: number | null = null;
    if (maxTokens.trim() !== "") {
      maxTokensValue = Number(maxTokens);
      if (
        !Number.isInteger(maxTokensValue) ||
        maxTokensValue < 1 ||
        maxTokensValue > 131_072
      ) {
        setFormError("Max tokens 必须是 1 到 131072 之间的整数。");
        return null;
      }
    }

    const timeoutValue = Number(timeoutMs);
    if (
      !Number.isInteger(timeoutValue) ||
      timeoutValue < 1000 ||
      timeoutValue > 600_000
    ) {
      setFormError("超时必须是 1000 到 600000 毫秒之间的整数。");
      return null;
    }

    const key = apiKey.trim();
    const settings: LlmSettingsInput = {
      baseUrl: base,
      model: modelValue,
      temperature: temperatureValue,
      maxTokens: maxTokensValue,
      systemPrompt,
      timeoutMs: timeoutValue,
      ...(key !== "" ? { apiKey: key } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
    };
    const test: LlmTestInput = {
      baseUrl: base,
      model: modelValue,
      temperature: temperatureValue,
      maxTokens: maxTokensValue,
      timeoutMs: timeoutValue,
      ...(key !== "" ? { apiKey: key } : {}),
    };

    setFormError(null);
    return { settings, test };
  };

  const runTest = async (): Promise<void> => {
    const parsed = parseForm();
    if (!parsed) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testLlm(parsed.test);
      setTestResult(result);
    } catch (error) {
      setFormError(asApiError(error).message);
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    const parsed = parseForm();
    if (!parsed) return;
    setSaving(true);
    const ok = await saveLlmSettings(parsed.settings);
    setSaving(false);
    if (ok) close();
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : close}
      title="模型 API"
      description="OpenAI-compatible /chat/completions。兼容 DeepSeek、OpenAI、Ollama、vLLM、OpenRouter 等。"
      className="max-w-xl"
      footer={
        <>
          <Button variant="outline" size="sm" disabled={saving} onClick={close}>
            关闭
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={saving || testing}
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
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <span>
            当前状态：
            <span className={current?.configured ? "text-primary" : "text-warning"}>
              {current?.configured ? "已配置" : "未配置"}
            </span>
            {current?.configured ? ` · ${current.model}` : ""}
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <KeyRound className="h-3 w-3" />
            {current?.hasApiKey ? current.apiKeyHint : "无 Key"}
          </span>
        </div>

        <Field
          label="Base URL"
          hint="不含 /chat/completions 也可以"
        >
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </Field>

        <Field
          label="API Key"
          hint={current?.hasApiKey ? "留空保持不变" : "本地 Ollama 可留空"}
        >
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={clearApiKey}
            placeholder={
              current?.hasApiKey
                ? `已保存（${current.apiKeyHint ?? "••••"}），留空保持不变`
                : "sk-...（可选）"
            }
            autoComplete="off"
            spellCheck={false}
            className={cn(INPUT_CLASS, "font-mono disabled:opacity-50")}
          />
        </Field>

        {current?.hasApiKey ? (
          <label className="flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={clearApiKey}
              onChange={(event) => setClearApiKey(event.target.checked)}
              className="h-3 w-3 accent-[var(--danger)]"
            />
            清除已保存的 API Key
          </label>
        ) : null}

        <Field label="Model">
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="deepseek-chat"
            spellCheck={false}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Temperature" hint="留空用服务端默认">
            <input
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
              inputMode="decimal"
              placeholder="0.7"
              className={cn(INPUT_CLASS, "font-mono")}
            />
          </Field>
          <Field label="Max tokens" hint="留空用服务端默认">
            <input
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
              inputMode="numeric"
              placeholder="4096"
              className={cn(INPUT_CLASS, "font-mono")}
            />
          </Field>
        </div>

        <details className="rounded-lg border border-border bg-background/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-[11px] font-medium text-foreground">
            高级设置
          </summary>
          <div className="mt-3 space-y-3">
            <Field label="System prompt" hint="留空使用默认聊天提示词">
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                rows={4}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs leading-5 text-foreground placeholder:text-muted-foreground/45 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </Field>
            <Field label="请求超时（ms）">
              <input
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(event.target.value)}
                inputMode="numeric"
                className={cn(INPUT_CLASS, "font-mono")}
              />
            </Field>
          </div>
        </details>

        {formError ? (
          <div className="flex gap-2 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{formError}</span>
          </div>
        ) : null}

        {testResult ? (
          <div
            className={cn(
              "flex gap-2 rounded-lg border px-3 py-2 text-[11px] leading-5",
              testResult.ok
                ? "border-primary/25 bg-primary/5 text-primary"
                : "border-danger/25 bg-danger/5 text-danger",
            )}
          >
            {testResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">
              {testResult.ok
                ? `连接成功 · ${testResult.latencyMs} ms · ${testResult.model} · 回复：${testResult.message}`
                : testResult.message}
            </span>
          </div>
        ) : null}

        <p className="text-[10px] leading-5 text-muted-foreground/70">
          API Key 只保存在本机{" "}
          <code className="rounded bg-muted/60 px-1 font-mono text-[10px]">
            data/llm.json
          </code>{" "}
          （权限 0600），不会返回给前端，也不会传给执行 shell 的进程。
          Base URL 示例：<code className="font-mono">https://api.deepseek.com/v1</code>、{" "}
          <code className="font-mono">http://127.0.0.1:11434/v1</code>。
        </p>
      </div>
    </Modal>
  );
}
