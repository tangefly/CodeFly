import type { SearchTestResult } from "@codefly/protocol";
import type { SearchEndpoint } from "./config-store.js";

const TEST_QUERY = "CodeFly";
/** Keep the probe short even when the saved request timeout is larger. */
const TEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_CHARS = 2_000;

function redactSecret(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("[redacted]");
}

function searchHttpMessage(status: number): string {
  if (status === 400) return "搜索 API 请求参数无效（HTTP 400）";
  if (status === 401) return "搜索 API 认证失败（HTTP 401），请检查 API Key";
  if (status === 402) return "搜索 API 账户余额不足（HTTP 402）";
  if (status === 403) return "搜索 API 拒绝了该请求（HTTP 403）";
  if (status === 408) return "搜索 API 上游读取超时（HTTP 408），请稍后重试";
  if (status === 413) return "搜索 API 请求体过大（HTTP 413）";
  if (status === 429) return "搜索 API 触发限流（HTTP 429），请稍后重试";
  if (status >= 500) return `搜索 API 服务错误（HTTP ${status}），请稍后重试`;
  return `搜索 API 返回错误（HTTP ${status}）`;
}

async function readErrorDetail(
  response: Response,
  apiKey: string,
): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  const trimmed = redactSecret(text.trim(), apiKey).slice(0, MAX_ERROR_CHARS);
  if (trimmed === "") return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    const error = parsed.error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim() !== "") {
        return message.trim().slice(0, MAX_ERROR_CHARS);
      }
    }
  } catch {
    // Not an OpenAI-style error body; use the raw text.
  }
  return trimmed;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Sends one tiny query to the configured search endpoint so the settings
 * dialog can verify the URL/key without saving first.
 */
export async function testSearchConnection(
  endpoint: SearchEndpoint,
): Promise<SearchTestResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(endpoint.timeoutMs, TEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        ...(endpoint.apiKey === ""
          ? {}
          : { Authorization: `Bearer ${endpoint.apiKey}` }),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: TEST_QUERY,
        count: 1,
        need_content: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response, endpoint.apiKey);
      return {
        ok: false,
        message: `${searchHttpMessage(response.status)}${
          detail === "" ? "" : `：${detail}`
        }`,
        latencyMs: Date.now() - startedAt,
        resultCount: 0,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        ok: false,
        message: "搜索 API 返回了无法解析的 JSON。",
        latencyMs: Date.now() - startedAt,
        resultCount: 0,
      };
    }

    const results = (payload as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) {
      return {
        ok: false,
        message: "搜索 API 返回了非预期结构：缺少 results 数组。",
        latencyMs: Date.now() - startedAt,
        resultCount: 0,
      };
    }

    return {
      ok: true,
      message: `搜索连接成功，返回 ${results.length} 条结果。`,
      latencyMs: Date.now() - startedAt,
      resultCount: results.length,
    };
  } catch (error) {
    const message = isTimeoutError(error)
      ? `连接搜索 API 超时（${timeoutMs} ms）。`
      : `无法连接搜索 API：${redactSecret(
          error instanceof Error ? error.message : String(error),
          endpoint.apiKey,
        )}`;
    return {
      ok: false,
      message,
      latencyMs: Date.now() - startedAt,
      resultCount: 0,
    };
  }
}
