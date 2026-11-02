import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmSettingsInput, LlmSettingsPublic } from "@codefly/protocol";
import { AppError, isNotFound } from "../http/errors.js";
import { config as appConfig } from "../config.js";

export const DEFAULT_SYSTEM_PROMPT =
  "你是 CodeFly 的对话助手。当前为聊天模式：你不能执行命令、读写文件或调用工具，只能与用户对话。请使用与用户相同的语言回答；需要代码时使用 Markdown 代码块。";

export interface LlmInternalConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  systemPrompt: string;
  timeoutMs: number;
  updatedAt: string | null;
}

const DEFAULTS: LlmInternalConfig = {
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: null,
  maxTokens: null,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  timeoutMs: appConfig.llm.defaultTimeoutMs,
  updatedAt: null,
};

/**
 * Normalizes and validates an OpenAI-compatible base URL. Returns the URL
 * without a trailing slash; the client appends /chat/completions.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(
      "LLM_INVALID_CONFIG",
      "Base URL 必须是合法的 http(s) 地址",
      400,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      "LLM_INVALID_CONFIG",
      "Base URL 只支持 http:// 或 https://",
      400,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError(
      "LLM_INVALID_CONFIG",
      "Base URL 不能包含用户名或密码；请使用 API Key 字段",
      400,
    );
  }
  if (url.search !== "") {
    throw new AppError(
      "LLM_INVALID_CONFIG",
      "Base URL 不能包含查询参数；请只填写服务基础地址",
      400,
    );
  }
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function maskApiKey(apiKey: string): string | null {
  if (apiKey === "") return null;
  if (apiKey.length <= 8) return "••••";
  return `••••${apiKey.slice(-4)}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Persists the OpenAI-compatible provider configuration in
 * `data/llm.json`. The API key is never returned by the public view and the
 * file is written with mode 0600.
 */
export class LlmConfigStore {
  private current: LlmInternalConfig = { ...DEFAULTS };
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        console.error("[llm] ignoring unreadable llm.json");
      }
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<LlmInternalConfig>;
      let baseUrl =
        typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
      if (baseUrl !== "") {
        try {
          baseUrl = normalizeBaseUrl(baseUrl);
        } catch {
          baseUrl = "";
        }
      }

      this.current = {
        baseUrl,
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
        model: typeof parsed.model === "string" ? parsed.model.trim() : "",
        temperature: numberOrNull(parsed.temperature),
        maxTokens: numberOrNull(parsed.maxTokens),
        systemPrompt:
          typeof parsed.systemPrompt === "string"
            ? parsed.systemPrompt
            : DEFAULT_SYSTEM_PROMPT,
        timeoutMs:
          typeof parsed.timeoutMs === "number" &&
          parsed.timeoutMs >= 1000 &&
          parsed.timeoutMs <= appConfig.llm.maxTimeoutMs
            ? Math.round(parsed.timeoutMs)
            : appConfig.llm.defaultTimeoutMs,
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } catch {
      console.error("[llm] ignoring corrupt llm.json");
      return;
    }

    try {
      await chmod(this.file, 0o600);
    } catch {
      // Best effort; the file may live on a filesystem without POSIX modes.
    }
  }

  getInternal(): LlmInternalConfig {
    return { ...this.current };
  }

  getPublic(): LlmSettingsPublic {
    const config = this.current;
    return {
      configured: this.isConfigured(),
      baseUrl: config.baseUrl,
      model: config.model,
      hasApiKey: config.apiKey !== "",
      apiKeyHint: maskApiKey(config.apiKey),
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      systemPrompt: config.systemPrompt,
      timeoutMs: config.timeoutMs,
      updatedAt: config.updatedAt,
    };
  }

  isConfigured(): boolean {
    return this.current.baseUrl !== "" && this.current.model !== "";
  }

  async update(input: LlmSettingsInput): Promise<LlmSettingsPublic> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const model = input.model.trim();
    if (model === "") {
      throw new AppError("LLM_INVALID_CONFIG", "Model 不能为空", 400);
    }

    let apiKey = this.current.apiKey;
    if (input.clearApiKey === true) {
      apiKey = "";
    } else if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
      apiKey = input.apiKey.trim();
    }

    const timeoutMs =
      input.timeoutMs === undefined
        ? this.current.timeoutMs
        : Math.min(appConfig.llm.maxTimeoutMs, Math.max(1000, input.timeoutMs));

    this.current = {
      baseUrl,
      apiKey,
      model,
      temperature:
        input.temperature === undefined
          ? this.current.temperature
          : input.temperature,
      maxTokens:
        input.maxTokens === undefined ? this.current.maxTokens : input.maxTokens,
      systemPrompt:
        input.systemPrompt === undefined
          ? this.current.systemPrompt
          : input.systemPrompt,
      timeoutMs,
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
    return this.getPublic();
  }

  private persist(): Promise<void> {
    const data = JSON.stringify(this.current, null, 2);
    this.persistQueue = this.persistQueue
      .then(async () => {
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, this.file);
        try {
          await chmod(this.file, 0o600);
        } catch {
          // Best effort.
        }
      })
      .catch((error: unknown) => {
        console.error("[llm] failed to persist configuration", error);
      });
    return this.persistQueue;
  }
}
