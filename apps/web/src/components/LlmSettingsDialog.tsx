import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  REASONING_EFFORTS,
  type LlmProfilePublic,
  type LlmSettingsInput,
  type LlmTestInput,
  type LlmTestResult,
  type ReasoningEffort,
} from "@codefly/protocol";
import { asApiError } from "../lib/api.js";
import {
  CUSTOM_PROVIDER_ID,
  LLM_PROVIDERS,
  findProvider,
  findProviderByBaseUrl,
} from "../lib/llm-providers.js";
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

function Select({
  value,
  onChange,
  ariaLabel,
  className,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        className={cn(INPUT_CLASS, "appearance-none pr-8", className)}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
    </div>
  );
}

/** Mirrors the server's URL normalization so profile matching agrees. */
function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function LlmSettingsDialog() {
  const open = useAppStore((state) => state.ui.llmSettingsOpen);
  const close = useAppStore((state) => state.closeLlmSettings);
  const current = useAppStore((state) => state.llmSettings);
  const saveLlmSettings = useAppStore((state) => state.saveLlmSettings);
  const activateLlmProfile = useAppStore((state) => state.activateLlmProfile);
  const deleteLlmProfile = useAppStore((state) => state.deleteLlmProfile);
  const testLlm = useAppStore((state) => state.testLlm);

  const [view, setView] = useState<"list" | "form">("list");
  const [providerId, setProviderId] = useState(CUSTOM_PROVIDER_ID);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("120000");
  const [thinking, setThinking] = useState(true);
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("high");
  const [clearApiKey, setClearApiKey] = useState(false);
  /** Profile the form was pre-filled from, used for API-key inheritance. */
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setView("list");
    setPendingDeleteId(null);
    setActivatingId(null);
    setDeletingId(null);
    setSaving(false);
    setTesting(false);
    setFormError(null);
    setTestResult(null);
  }, [open]);

  const profiles = current?.profiles ?? [];
  const pendingDelete =
    profiles.find((profile) => profile.id === pendingDeleteId) ?? null;
  const provider = findProvider(providerId);
  const modelOptions = provider
    ? model !== "" && !provider.models.includes(model)
      ? [model, ...provider.models]
      : provider.models
    : [];

  // The server inherits an omitted API key from the matching saved profile,
  // then from the profile this form was opened from, then from the active
  // config. Mirrored here so the key hint matches what saving will do.
  const normalizedBaseUrl = normalizeUrl(baseUrl);
  const selectedProfile =
    profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const matchedProfile = profiles.find(
    (profile) =>
      normalizeUrl(profile.baseUrl) === normalizedBaseUrl &&
      profile.model === model.trim(),
  );
  const sameProviderProfile =
    selectedProfile !== null &&
    normalizeUrl(selectedProfile.baseUrl) === normalizedBaseUrl
      ? selectedProfile
      : null;
  const activeSource =
    current !== null &&
    normalizedBaseUrl !== "" &&
    normalizeUrl(current.baseUrl) === normalizedBaseUrl
      ? current
      : null;
  const keySource = matchedProfile ?? sameProviderProfile ?? activeSource;
  const hasSavedKey = keySource?.hasApiKey ?? false;
  const savedKeyHint = keySource?.apiKeyHint ?? null;

  const beginConfigure = (): void => {
    const savedBaseUrl = current?.baseUrl ?? "";
    setProviderId(
      findProviderByBaseUrl(savedBaseUrl)?.id ?? CUSTOM_PROVIDER_ID,
    );
    setBaseUrl(savedBaseUrl);
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
    setThinking(current?.thinking ?? true);
    setReasoningEffort(current?.reasoningEffort ?? "high");
    setClearApiKey(false);
    setSelectedProfileId(current?.activeProfileId ?? "");
    setFormError(null);
    setTestResult(null);
    setSaving(false);
    setTesting(false);
    setPendingDeleteId(null);
    setView("form");
  };

  const selectProvider = (id: string): void => {
    setProviderId(id);
    setFormError(null);
    setTestResult(null);
    const next = findProvider(id);
    if (!next) {
      // 自定义：清空后手动填写 URL 与模型名。
      setBaseUrl("");
      setModel("");
      setSelectedProfileId("");
      return;
    }
    const nextModel = next.models.includes(model)
      ? model
      : (next.models[0] ?? "");
    setBaseUrl(next.baseUrl);
    setModel(nextModel);
    const saved = profiles.find(
      (profile) =>
        normalizeUrl(profile.baseUrl) === normalizeUrl(next.baseUrl) &&
        profile.model === nextModel,
    );
    setSelectedProfileId(saved?.id ?? "");
  };

  const changeModel = (value: string): void => {
    setModel(value);
    setFormError(null);
    setTestResult(null);
  };

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
      timeoutValue < 0 ||
      timeoutValue > 600_000
    ) {
      setFormError("超时必须是 0 到 600000 毫秒之间的整数（0 表示不限制）。");
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
      thinking,
      reasoningEffort,
      ...(selectedProfileId !== "" ? { profileId: selectedProfileId } : {}),
      ...(key !== "" ? { apiKey: key } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
    };
    const test: LlmTestInput = {
      baseUrl: base,
      model: modelValue,
      temperature: temperatureValue,
      maxTokens: maxTokensValue,
      timeoutMs: timeoutValue,
      ...(selectedProfileId !== "" ? { profileId: selectedProfileId } : {}),
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
    if (ok) setView("list");
  };

  const activate = async (profile: LlmProfilePublic): Promise<void> => {
    if (profile.active || activatingId !== null || deletingId !== null) return;
    setActivatingId(profile.id);
    setPendingDeleteId(null);
    await activateLlmProfile(profile.id);
    setActivatingId(null);
  };

  const remove = async (profile: LlmProfilePublic): Promise<void> => {
    if (deletingId !== null) return;
    setDeletingId(profile.id);
    await deleteLlmProfile(profile.id);
    setDeletingId(null);
    setPendingDeleteId(null);
  };

  const deleteHint = (profile: LlmProfilePublic): string => {
    if (profile.active) {
      return profiles.length > 1
        ? "删除后将自动切换到其他配置。"
        : "删除后将需要重新配置模型。";
    }
    return "API Key 会一并删除。";
  };

  const listFooter = (
    <>
      <Button variant="outline" size="sm" onClick={close}>
        关闭
      </Button>
      <Button variant="primary" size="sm" onClick={beginConfigure}>
        <Plus className="h-3.5 w-3.5" />
        配置模型
      </Button>
    </>
  );

  const formFooter = (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={saving}
        onClick={() => setView("list")}
      >
        返回
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
  );

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : close}
      title={view === "list" ? "模型 API" : "配置模型"}
      description={
        view === "list"
          ? "点击标签切换正在使用的模型；每个配置独立保存 API Key。"
          : "OpenAI-compatible /chat/completions。兼容 DeepSeek、OpenAI、Ollama、vLLM、OpenRouter 等。"
      }
      className="max-w-xl"
      footer={view === "list" ? listFooter : formFooter}
    >
      {view === "list" ? (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-foreground">
              已保存配置
            </span>
            <span className="text-[9px] text-muted-foreground/60">
              {profiles.length > 0
                ? `共 ${profiles.length} 个，点击标签即可切换`
                : "还没有配置模型"}
            </span>
          </div>

          {profiles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/10 px-4 py-10 text-center">
              <Sparkles className="mx-auto h-5 w-5 text-muted-foreground/50" />
              <p className="mt-2 text-xs font-medium text-foreground">
                还没有配置模型
              </p>
              <p className="mt-1 text-[10px] leading-5 text-muted-foreground/70">
                点击下方「配置模型」添加一个 OpenAI-compatible 模型，
                之后即可在对话、Code 与论文助手中使用。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {profiles.map((profile) => {
                const highlighted = pendingDeleteId === profile.id;
                return (
                  <div
                    key={profile.id}
                    className={cn(
                      "flex items-center gap-1.5 rounded-xl border px-2.5 py-2 transition-colors",
                      profile.active
                        ? "border-primary/45 bg-primary/10"
                        : "border-border bg-background/40 hover:border-primary/30 hover:bg-muted/20",
                      highlighted && "border-danger/45 bg-danger/5",
                    )}
                  >
                    <button
                      type="button"
                      disabled={
                        profile.active ||
                        activatingId !== null ||
                        deletingId !== null
                      }
                      onClick={() => void activate(profile)}
                      aria-label={
                        profile.active
                          ? `${profile.model}（正在使用）`
                          : `切换到 ${profile.model}`
                      }
                      className="min-w-0 flex-1 text-left disabled:cursor-default"
                    >
                      <span className="flex items-center gap-1.5">
                        {activatingId === profile.id ? (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                        ) : null}
                        <span className="truncate font-mono text-xs font-medium text-foreground">
                          {profile.model}
                        </span>
                        {profile.active ? (
                          <span className="shrink-0 rounded-full border border-primary/30 bg-primary/15 px-1.5 py-px text-[9px] font-medium text-primary">
                            正在使用
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 text-[9px] text-muted-foreground/75">
                        <span className="truncate">
                          {hostLabel(profile.baseUrl)}
                        </span>
                        {profile.hasApiKey ? (
                          <>
                            <span className="shrink-0">·</span>
                            <KeyRound className="h-2.5 w-2.5 shrink-0" />
                            <span className="shrink-0 font-mono">
                              {profile.apiKeyHint}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="shrink-0">·</span>
                            <span className="shrink-0">无 Key</span>
                          </>
                        )}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground/55 hover:bg-danger/10 hover:text-danger"
                      aria-label={`删除 ${profile.model} 配置`}
                      disabled={deletingId !== null}
                      onClick={() =>
                        setPendingDeleteId(
                          pendingDeleteId === profile.id ? null : profile.id,
                        )
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {pendingDelete ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] text-danger">
              <Trash2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                删除「{pendingDelete.model}」？{deleteHint(pendingDelete)}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={deletingId !== null}
                  onClick={() => setPendingDeleteId(null)}
                >
                  取消
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={deletingId !== null}
                  onClick={() => void remove(pendingDelete)}
                >
                  {deletingId === pendingDelete.id ? "删除中…" : "删除"}
                </Button>
              </span>
            </div>
          ) : null}

          <p className="text-[10px] leading-5 text-muted-foreground/70">
            API Key 只保存在本机{" "}
            <code className="rounded bg-muted/60 px-1 font-mono text-[10px]">
              data/llm.json
            </code>{" "}
            （权限 0600），不会返回给前端，也不会传给执行 shell 的进程。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              当前正在使用的配置已自动填入。修改模型名后保存会新增一个配置，原配置仍会保留。
            </span>
          </div>

          <Field label="厂商" hint="选择后自动填充 URL 与模型">
            <Select
              value={providerId}
              onChange={selectProvider}
              ariaLabel="模型厂商"
            >
              {LLM_PROVIDERS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value={CUSTOM_PROVIDER_ID}>其他（自定义）</option>
            </Select>
          </Field>
          {provider?.note ? (
            <p className="-mt-1.5 text-[10px] leading-4 text-muted-foreground/70">
              {provider.note}
            </p>
          ) : null}

          <Field
            label="Base URL"
            hint={
              provider ? "已自动填充，可改为代理地址" : "需为 OpenAI-compatible 地址"
            }
          >
            <input
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setFormError(null);
                setTestResult(null);
              }}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              className={cn(INPUT_CLASS, "font-mono")}
            />
          </Field>

          <Field
            label="API Key"
            hint={hasSavedKey ? "留空保持不变" : "本地 Ollama 可留空"}
          >
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={clearApiKey}
              placeholder={
                hasSavedKey
                  ? `已保存（${savedKeyHint ?? "••••"}），留空保持不变`
                  : "sk-...（可选）"
              }
              autoComplete="off"
              spellCheck={false}
              className={cn(INPUT_CLASS, "font-mono disabled:opacity-50")}
            />
          </Field>

          {hasSavedKey ? (
            <label className="flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(event) => setClearApiKey(event.target.checked)}
                className="h-3 w-3 accent-[var(--danger)]"
              />
              清除该配置已保存的 API Key
            </label>
          ) : null}

          <Field
            label="Model"
            hint={provider ? "从厂商模型列表选择" : "手动填写模型名"}
          >
            {provider ? (
              <Select
                value={model}
                onChange={changeModel}
                ariaLabel="模型"
                className="font-mono"
              >
                {modelOptions.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </Select>
            ) : (
              <input
                value={model}
                onChange={(event) => changeModel(event.target.value)}
                placeholder="deepseek-chat / your-model-name"
                spellCheck={false}
                className={cn(INPUT_CLASS, "font-mono")}
              />
            )}
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
            <Field label="Max tokens" hint="含思考 token；留空用服务端默认">
              <input
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
                inputMode="numeric"
                placeholder="4096"
                className={cn(INPUT_CLASS, "font-mono")}
              />
            </Field>
          </div>

          <div className="rounded-lg border border-border bg-background/40 px-3 py-2.5">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span className="block text-[11px] font-medium text-foreground">
                  思考模式
                </span>
                <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground/70">
                  DeepSeek V4 默认开启，思考内容显示在回复上方；思考 token
                  计入输出。
                </span>
              </span>
              <input
                type="checkbox"
                checked={thinking}
                onChange={(event) => setThinking(event.target.checked)}
                className="h-4 w-4 shrink-0 accent-[var(--primary)]"
              />
            </label>
            {thinking ? (
              <div className="mt-3">
                <Field label="思考强度" hint="low / high / max">
                  <Select
                    value={reasoningEffort}
                    onChange={(value) =>
                      setReasoningEffort(value as ReasoningEffort)
                    }
                    ariaLabel="思考强度"
                  >
                    {REASONING_EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : null}
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
              <Field
                label="无输出超时（ms）"
                hint="只要模型还在持续输出（含思考）就不会超时；0 表示不限制"
              >
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
            列表中没有的模型请选「其他（自定义）」后手动填写。
          </p>
        </div>
      )}
    </Modal>
  );
}
