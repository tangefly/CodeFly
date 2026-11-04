import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SearchSettingsInput,
  SearchSettingsPublic,
} from "@codefly/protocol";
import { AppError, isNotFound } from "../http/errors.js";
import { config as appConfig } from "../config.js";

/** Default request timeout for DeepSeek Search calls. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;

export interface SearchInternalConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  updatedAt: string | null;
}

/** Fully resolved target passed to the web_search tool and the test route. */
export interface SearchEndpoint {
  /** POST target, e.g. https://api.deepseek.com/v1/tools/search. */
  url: string;
  apiKey: string;
  timeoutMs: number;
}

const DEFAULTS: SearchInternalConfig = {
  baseUrl: "",
  apiKey: "",
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  updatedAt: null,
};

/**
 * Normalizes and validates the search service base URL. Credentials, query
 * strings and fragments are rejected so the key/query never leaks into URLs.
 */
export function normalizeSearchBaseUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(
      "SEARCH_INVALID_CONFIG",
      "搜索 API Base URL 必须是合法的 http(s) 地址",
      400,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      "SEARCH_INVALID_CONFIG",
      "搜索 API Base URL 只支持 http:// 或 https://",
      400,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError(
      "SEARCH_INVALID_CONFIG",
      "搜索 API Base URL 不能包含用户名或密码；请使用 API Key 字段",
      400,
    );
  }
  if (url.search !== "") {
    throw new AppError(
      "SEARCH_INVALID_CONFIG",
      "搜索 API Base URL 不能包含查询参数；请只填写服务基础地址",
      400,
    );
  }
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Derives the DeepSeek-compatible search endpoint from a base URL. Accepts:
 * - an origin (https://api.deepseek.com) -> /v1/tools/search
 * - a /v1 base (https://api.deepseek.com/v1) -> /v1/tools/search
 * - the full endpoint (https://host/v1/tools/search) -> unchanged
 * - a gateway prefix ending in /v1 -> <prefix>/tools/search
 */
export function searchEndpointUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/tools/search")) {
    return `${url.protocol}//${url.host}${pathname}`;
  }
  if (pathname.endsWith("/v1")) {
    return `${url.protocol}//${url.host}${pathname}/tools/search`;
  }
  return `${url.protocol}//${url.host}${pathname}/v1/tools/search`;
}

function maskApiKey(apiKey: string): string | null {
  if (apiKey === "") return null;
  if (apiKey.length <= 8) return "••••";
  return `••••${apiKey.slice(-4)}`;
}

/**
 * Persists the web search provider configuration in `data/search.json`,
 * independently of the model provider in `data/llm.json`. The API key is
 * never returned by the public view and the file is written with mode 0600.
 */
export class SearchConfigStore {
  private current: SearchInternalConfig = { ...DEFAULTS };
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        console.error("[search] ignoring unreadable search.json");
      }
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<SearchInternalConfig>;
      let baseUrl =
        typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
      if (baseUrl !== "") {
        try {
          baseUrl = normalizeSearchBaseUrl(baseUrl);
        } catch {
          baseUrl = "";
        }
      }

      this.current = {
        baseUrl,
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
        timeoutMs:
          typeof parsed.timeoutMs === "number" &&
          parsed.timeoutMs >= 1000 &&
          parsed.timeoutMs <= appConfig.llm.maxTimeoutMs
            ? Math.round(parsed.timeoutMs)
            : DEFAULT_SEARCH_TIMEOUT_MS,
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } catch {
      console.error("[search] ignoring corrupt search.json");
      return;
    }

    try {
      await chmod(this.file, 0o600);
    } catch {
      // Best effort; the file may live on a filesystem without POSIX modes.
    }
  }

  getInternal(): SearchInternalConfig {
    return { ...this.current };
  }

  getPublic(): SearchSettingsPublic {
    const config = this.current;
    return {
      configured: this.isConfigured(),
      baseUrl: config.baseUrl,
      endpoint: config.baseUrl === "" ? null : searchEndpointUrl(config.baseUrl),
      hasApiKey: config.apiKey !== "",
      apiKeyHint: maskApiKey(config.apiKey),
      timeoutMs: config.timeoutMs,
      updatedAt: config.updatedAt,
    };
  }

  isConfigured(): boolean {
    return this.current.baseUrl !== "";
  }

  /** Target for web_search, or null when no search API is configured. */
  getEndpoint(): SearchEndpoint | null {
    if (!this.isConfigured()) return null;
    return {
      url: searchEndpointUrl(this.current.baseUrl),
      apiKey: this.current.apiKey,
      timeoutMs: this.current.timeoutMs,
    };
  }

  async update(input: SearchSettingsInput): Promise<SearchSettingsPublic> {
    const baseUrl =
      input.baseUrl.trim() === ""
        ? ""
        : normalizeSearchBaseUrl(input.baseUrl);

    let apiKey = this.current.apiKey;
    if (input.clearApiKey === true) {
      apiKey = "";
    } else if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
      apiKey = input.apiKey.trim();
    }

    const timeoutMs =
      input.timeoutMs === undefined
        ? this.current.timeoutMs
        : Math.min(
            appConfig.llm.maxTimeoutMs,
            Math.max(1000, Math.round(input.timeoutMs)),
          );

    // Disabling search should not leave a stale key on disk.
    if (baseUrl === "") apiKey = "";

    this.current = {
      baseUrl,
      apiKey,
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
        console.error("[search] failed to persist configuration", error);
      });
    return this.persistQueue;
  }
}
