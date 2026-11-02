import type { ChatUsage } from "@codefly/protocol";
import type { LlmInternalConfig } from "./config-store.js";

export interface LlmRequestToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LlmRequestToolCall[];
  tool_call_id?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamChatOptions {
  tools?: LlmToolDefinition[];
  toolChoice?: "auto" | "none";
}

export interface LlmStreamResult {
  content: string;
  finishReason: string | null;
  usage?: ChatUsage;
  toolCalls: LlmToolCall[];
}

export interface LlmCompleteResult {
  content: string;
  latencyMs: number;
  model: string;
  usage?: ChatUsage;
}

export class LlmError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface LlmClientLike {
  streamChat(
    config: LlmInternalConfig,
    messages: LlmChatMessage[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
    options?: StreamChatOptions,
  ): Promise<LlmStreamResult>;

  complete(
    config: LlmInternalConfig,
    messages: LlmChatMessage[],
    signal: AbortSignal,
    maxTokens?: number,
  ): Promise<LlmCompleteResult>;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChoice {
  delta?: { content?: unknown; tool_calls?: OpenAiToolCallDelta[] };
  message?: {
    content?: unknown;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  error?: unknown;
  model?: unknown;
}

/** Appends /chat/completions unless the configured URL already names it. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

function extractContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

function extractDeltaContent(choice: OpenAiChoice | undefined): string {
  if (!choice) return "";
  return extractContent(choice.delta?.content ?? choice.message?.content);
}

function responseToolCalls(choice: OpenAiChoice | undefined): LlmToolCall[] {
  const calls = choice?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((call, index) => ({
    id: typeof call.id === "string" && call.id !== "" ? call.id : `call_${index}`,
    name: typeof call.function?.name === "string" ? call.function.name : "",
    arguments:
      typeof call.function?.arguments === "string" ? call.function.arguments : "",
  }));
}

function extractFinishReason(choice: OpenAiChoice | undefined): string | null {
  return typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
}

function mapUsage(value: OpenAiResponse["usage"]): ChatUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage: ChatUsage = {};
  if (typeof value.prompt_tokens === "number") usage.promptTokens = value.prompt_tokens;
  if (typeof value.completion_tokens === "number") {
    usage.completionTokens = value.completion_tokens;
  }
  if (typeof value.total_tokens === "number") usage.totalTokens = value.total_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function formatUpstreamError(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `模型 API 认证失败（HTTP ${status}），请检查 API Key。`;
  }
  if (status === 404) {
    return "模型 API 接口不存在（HTTP 404），请检查 Base URL。";
  }
  if (status === 429) {
    return "模型 API 请求过于频繁或额度不足（HTTP 429）。";
  }
  if (status >= 500) {
    return `模型 API 服务错误（HTTP ${status}）。`;
  }
  return `模型 API 返回错误（HTTP ${status}）。`;
}

async function readLimited(response: Response, limit = 4000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // The error body is best-effort.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, limit);
}

function headersFor(config: LlmInternalConfig, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream, application/json" : "application/json",
  };
  if (config.apiKey !== "") headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

function bodyFor(
  config: LlmInternalConfig,
  messages: LlmChatMessage[],
  stream: boolean,
  maxTokensOverride?: number,
  options?: StreamChatOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
  };
  if (config.temperature !== null) body.temperature = config.temperature;
  const maxTokens = maxTokensOverride ?? config.maxTokens;
  if (maxTokens !== null) body.max_tokens = maxTokens;
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
  }
  return body;
}

async function postChat(
  config: LlmInternalConfig,
  body: Record<string, unknown>,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) {
    throw new LlmError("LLM_ABORTED", "LLM 请求已取消", 499);
  }

  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: headersFor(config, stream),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new LlmError("LLM_ABORTED", "LLM 请求已取消", 499);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new LlmError(
      "LLM_NETWORK_ERROR",
      `无法连接模型 API：${redactSecret(message, config.apiKey)}`,
      502,
    );
  }

  if (!response.ok) {
    const detail = await readLimited(response);
    const message = redactSecret(detail.trim(), config.apiKey).slice(0, 2000);
    throw new LlmError(
      "LLM_HTTP_ERROR",
      `${statusMessage(response.status)}${message ? `\n\n${message}` : ""}`,
      502,
    );
  }

  return response;
}

/**
 * Minimal OpenAI-compatible client: POST /chat/completions with
 * `stream: true`, parsing SSE data lines into text deltas.
 */
export class LlmClient implements LlmClientLike {
  async streamChat(
    config: LlmInternalConfig,
    messages: LlmChatMessage[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
    options?: StreamChatOptions,
  ): Promise<LlmStreamResult> {
    const response = await postChat(
      config,
      bodyFor(config, messages, true, undefined, options),
      true,
      signal,
    );

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && !contentType.includes("event-stream")) {
      const json = (await response.json()) as OpenAiResponse;
      this.throwIfUpstreamError(json, config);
      const choice = json.choices?.[0];
      const content = extractDeltaContent(choice);
      if (content) onDelta(content);
      return {
        content,
        finishReason: extractFinishReason(choice),
        usage: mapUsage(json.usage),
        toolCalls: responseToolCalls(choice),
      };
    }

    if (!response.body) {
      throw new LlmError("LLM_STREAM_ERROR", "模型 API 响应没有 body", 502);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    let usage: ChatUsage | undefined;
    let doneSeen = false;
    const toolCallsByIndex = new Map<number, LlmToolCall>();

    const consumeToolDeltas = (deltas: OpenAiToolCallDelta[] | undefined): void => {
      if (!Array.isArray(deltas)) return;
      for (const part of deltas) {
        const index = typeof part.index === "number" ? part.index : 0;
        const existing = toolCallsByIndex.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (typeof part.id === "string" && part.id !== "") existing.id = part.id;
        const fn = part.function;
        if (fn) {
          if (typeof fn.name === "string" && fn.name !== "") existing.name = fn.name;
          if (typeof fn.arguments === "string") existing.arguments += fn.arguments;
        }
        toolCallsByIndex.set(index, existing);
      }
    };

    const collectToolCalls = (): LlmToolCall[] =>
      [...toolCallsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          id: call.id !== "" ? call.id : `call_${index}`,
          name: call.name,
          arguments: call.arguments,
        }));

    const processLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "" || line.startsWith(":")) return;
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "") return;
      if (payload === "[DONE]") {
        doneSeen = true;
        return;
      }

      let json: OpenAiResponse;
      try {
        json = JSON.parse(payload) as OpenAiResponse;
      } catch {
        // Ignore malformed SSE data rather than aborting the whole stream.
        return;
      }

      this.throwIfUpstreamError(json, config);
      const choice = json.choices?.[0];
      const reason = extractFinishReason(choice);
      if (reason !== null) finishReason = reason;
      consumeToolDeltas(choice?.delta?.tool_calls);
      const delta = extractDeltaContent(choice);
      if (delta !== "") {
        content += delta;
        onDelta(delta);
      }
      const chunkUsage = mapUsage(json.usage);
      if (chunkUsage) usage = chunkUsage;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          processLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer !== "") processLine(buffer);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (signal.aborted && !doneSeen) {
        throw new LlmError("LLM_ABORTED", "LLM 请求已取消", 499);
      }
      if (signal.aborted) {
        return {
          content,
          finishReason,
          usage,
          toolCalls: collectToolCalls(),
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmError(
        "LLM_STREAM_ERROR",
        `模型响应流中断：${redactSecret(message, config.apiKey)}`,
        502,
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const toolCalls = collectToolCalls();
    if (
      content === "" &&
      toolCalls.length === 0 &&
      finishReason === null &&
      !doneSeen
    ) {
      throw new LlmError("LLM_EMPTY_RESPONSE", "模型返回了空响应", 502);
    }

    return { content, finishReason, usage, toolCalls };
  }

  async complete(
    config: LlmInternalConfig,
    messages: LlmChatMessage[],
    signal: AbortSignal,
    maxTokens = 32,
  ): Promise<LlmCompleteResult> {
    const startedAt = Date.now();
    const response = await postChat(
      config,
      bodyFor(config, messages, false, maxTokens),
      false,
      signal,
    );
    let json: OpenAiResponse;
    try {
      json = (await response.json()) as OpenAiResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmError(
        "LLM_STREAM_ERROR",
        `无法解析模型响应：${redactSecret(message, config.apiKey)}`,
        502,
      );
    }

    this.throwIfUpstreamError(json, config);
    const choice = json.choices?.[0];
    return {
      content: extractDeltaContent(choice),
      latencyMs: Date.now() - startedAt,
      model:
        typeof json.model === "string" && json.model !== ""
          ? json.model
          : config.model,
      usage: mapUsage(json.usage),
    };
  }

  private throwIfUpstreamError(json: OpenAiResponse, config: LlmInternalConfig): void {
    if (json.error === undefined) return;
    const message = redactSecret(formatUpstreamError(json.error), config.apiKey);
    throw new LlmError("LLM_UPSTREAM_ERROR", `模型 API 错误：${message}`, 502);
  }
}
