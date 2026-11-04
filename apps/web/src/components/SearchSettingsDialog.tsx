import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Globe,
  KeyRound,
  Loader2,
  Search,
  XCircle,
} from "lucide-react";
import type {
  SearchSettingsInput,
  SearchTestInput,
  SearchTestResult,
} from "@codefly/protocol";
import { asApiError } from "../lib/api.js";
import { useAppStore } from "../lib/store.js";
import { cn } from "../lib/utils.js";
import { Button, Modal } from "./ui.js";

const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/45 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20";

const DEEPSEEK_SEARCH_BASE_URL = "https://api.deepseek.com/v1";

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

/** Mirrors the server's endpoint derivation for a live preview. */
function previewEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/tools/search")) {
    return `${url.protocol}//${url.host}${pathname}`;
  }
  if (pathname.endsWith("/v1")) {
    return `${url.protocol}//${url.host}${pathname}/tools/search`;
  }
  return `${url.protocol}//${url.host}${pathname}/v1/tools/search`;
}

export function SearchSettingsDialog() {
  const open = useAppStore((state) => state.ui.searchSettingsOpen);
  const close = useAppStore((state) => state.closeSearchSettings);
  const current = useAppStore((state) => state.searchSettings);
  const saveSearchSettings = useAppStore((state) => state.saveSearchSettings);
  const testSearch = useAppStore((state) => state.testSearch);

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("60000");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SearchTestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setBaseUrl(current?.baseUrl ?? "");
    setApiKey("");
    setTimeoutMs(String(current?.timeoutMs ?? 60_000));
    setClearApiKey(false);
    setFormError(null);
    setTestResult(null);
    setSaving(false);
    setTesting(false);
  }, [open, current?.updatedAt]);

  const endpointPreview = previewEndpoint(baseUrl);

  const parseForm = (): {
    settings: SearchSettingsInput;
    test: SearchTestInput;
  } | null => {
    const base = baseUrl.trim();
    if (base !== "") {
      if (!/^https?:\/\/\S+$/i.test(base)) {
        setFormError("Base URL 必须以 http:// 或 https:// 开头。");
        return null;
      }
      try {
        const parsed = new URL(base);
        if (parsed.username !== "" || parsed.password !== "") {
          setFormError("Base URL 不能包含用户名或密码，请使用 API Key 字段。");
          return null;
        }
        if (parsed.search !== "") {
          setFormError("Base URL 不能包含查询参数，请只填写服务基础地址。");
          return null;
        }
      } catch {
        setFormError("Base URL 不是合法地址。");
        return null;
      }
    }

    const timeout = Number(timeoutMs);
    if (
      !Number.isInteger(timeout) ||
      timeout < 1000 ||
      timeout > 600_000
    ) {
      setFormError("超时必须是 1000 到 600000 毫秒之间的整数。");
      return null;
    }

    const key = apiKey.trim();
    const settings: SearchSettingsInput = {
      baseUrl: base,
      timeoutMs: timeout,
      ...(key !== "" ? { apiKey: key } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
    };
    const test: SearchTestInput = {
      baseUrl: base,
      timeoutMs: timeout,
      ...(key !== "" ? { apiKey: key } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
    };

    setFormError(null);
    return { settings, test };
  };

  const runTest = async (): Promise<void> => {
    const parsed = parseForm();
    if (!parsed) return;
    if (parsed.test.baseUrl === "") {
      setFormError("请先填写 Base URL 再测试。");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testSearch(parsed.test);
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
    const ok = await saveSearchSettings(parsed.settings);
    setSaving(false);
    if (ok) close();
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : close}
      title="搜索 API"
      description="独立于模型 API 的联网搜索配置。仅 web_search 使用，不影响聊天与 Agent 的模型请求。"
      className="max-w-xl"
      footer={
        <>
          <Button variant="outline" size="sm" disabled={saving} onClick={close}>
            关闭
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={saving || testing || baseUrl.trim() === ""}
            onClick={() => void runTest()}
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            测试搜索
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
          <Search className="h-3.5 w-3.5 text-primary" />
          <span>
            当前状态：
            <span
              className={cn(
                current?.configured ? "text-primary" : "text-warning",
              )}
            >
              {current?.configured ? "已配置" : "未配置"}
            </span>
            {current?.configured ? " · web_search 可用" : " · web_search 隐藏"}
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <KeyRound className="h-3 w-3" />
            {current?.hasApiKey ? current.apiKeyHint : "无 Key"}
          </span>
        </div>

        <Field
          label="Base URL"
          hint="DeepSeek Search 兼容，自动拼接 /v1/tools/search"
        >
          <input
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setFormError(null);
              setTestResult(null);
            }}
            placeholder={DEEPSEEK_SEARCH_BASE_URL}
            spellCheck={false}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </Field>
        <div className="-mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setBaseUrl(DEEPSEEK_SEARCH_BASE_URL);
              setFormError(null);
              setTestResult(null);
            }}
            className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
          >
            <Globe className="h-3 w-3" />
            填入 DeepSeek 默认地址
          </button>
          <span className="max-w-[70%] truncate font-mono text-[9px] text-muted-foreground/60">
            {endpointPreview === "" ? "预览：—" : `预览：${endpointPreview}`}
          </span>
        </div>

        <Field
          label="API Key"
          hint={current?.hasApiKey ? "留空保持不变" : "DeepSeek Search 需要 Key"}
        >
          <input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setFormError(null);
              setTestResult(null);
            }}
            disabled={clearApiKey}
            placeholder={
              current?.hasApiKey
                ? `已保存（${current.apiKeyHint ?? "••••"}），留空保持不变`
                : "sk-..."
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
              onChange={(event) => {
                setClearApiKey(event.target.checked);
                setTestResult(null);
              }}
              className="h-3 w-3 accent-[var(--danger)]"
            />
            清除已保存的搜索 API Key
          </label>
        ) : null}

        <Field label="请求超时（ms）" hint="单次 web_search 的等待上限">
          <input
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(event.target.value)}
            inputMode="numeric"
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </Field>

        <div className="rounded-lg border border-border bg-background/40 px-3 py-2 text-[10px] leading-5 text-muted-foreground/75">
          搜索服务需兼容 DeepSeek Search 的{" "}
          <code className="rounded bg-muted/60 px-1 font-mono text-[9px]">
            POST /v1/tools/search
          </code>{" "}
          请求与响应格式。Base URL 留空并保存会清除配置，web_search
          将不会再出现在 Agent 工具列表中。
        </div>

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
              {testResult.message} · {testResult.latencyMs} ms
            </span>
          </div>
        ) : null}

        <p className="text-[10px] leading-5 text-muted-foreground/70">
          搜索 API Key 单独保存在本机{" "}
          <code className="rounded bg-muted/60 px-1 font-mono text-[10px]">
            data/search.json
          </code>{" "}
          （权限 0600），与模型配置互不复用；不会返回给前端，也不会传给执行 shell
          的进程。启用后，搜索词与可选的网页正文会发送到这里的搜索服务。
        </p>
      </div>
    </Modal>
  );
}
