import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  REASONING_EFFORTS,
  type LlmSettingsInput,
  type LlmSettingsPublic,
  type ReasoningEffort,
} from "@codefly/protocol";
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
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  updatedAt: string | null;
}

/**
 * One saved model configuration. The active configuration is always backed by
 * one of these records, so configuring another model never discards the
 * previous one.
 */
export interface LlmProfileRecord {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  systemPrompt: string;
  timeoutMs: number;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  createdAt: string;
  updatedAt: string;
}

/** On-disk layout of `data/llm.json` (version 2). */
interface PersistedLlmConfig {
  version: 2;
  activeId: string | null;
  profiles: LlmProfileRecord[];
}

const DEFAULTS: LlmInternalConfig = {
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: null,
  maxTokens: null,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  timeoutMs: appConfig.llm.defaultTimeoutMs,
  thinking: true,
  reasoningEffort: "high",
  updatedAt: null,
};

/** DeepSeek retired these aliases in favor of the V4 family. */
const LEGACY_DEEPSEEK_MODELS: Record<string, string> = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
};

function isDeepSeekHost(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "deepseek.com" || hostname.endsWith(".deepseek.com");
  } catch {
    return false;
  }
}

function migrateModel(baseUrl: string, model: string): string {
  if (!isDeepSeekHost(baseUrl)) return model;
  return LEGACY_DEEPSEEK_MODELS[model] ?? model;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : "high";
}

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

/** Lenient variant used while loading a file we cannot reject. */
function sanitizeBaseUrl(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") return "";
  try {
    return normalizeBaseUrl(trimmed);
  } catch {
    return "";
  }
}

function maskApiKey(apiKey: string): string | null {
  if (apiKey === "") return null;
  if (apiKey.length <= 8) return "••••";
  return `••••${apiKey.slice(-4)}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Timeout accepted from disk: any non-negative value up to the ceiling. */
function sanitizeTimeoutMs(value: unknown): number {
  return typeof value === "number" &&
    value >= 0 &&
    value <= appConfig.llm.maxTimeoutMs
    ? Math.round(value)
    : appConfig.llm.defaultTimeoutMs;
}

/** Timeout accepted from an update: 0 means unlimited, otherwise >= 1s. */
function resolveTimeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value === 0) return 0;
  return Math.min(appConfig.llm.maxTimeoutMs, Math.max(1000, value));
}

function profileToInternal(profile: LlmProfileRecord): LlmInternalConfig {
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    systemPrompt: profile.systemPrompt,
    timeoutMs: profile.timeoutMs,
    thinking: profile.thinking,
    reasoningEffort: profile.reasoningEffort,
    updatedAt: profile.updatedAt,
  };
}

function sanitizeProfile(value: unknown): LlmProfileRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const parsed = value as Record<string, unknown>;
  const baseUrl = sanitizeBaseUrl(parsed.baseUrl);
  const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  if (baseUrl === "" || model === "") return null;

  const now = new Date().toISOString();
  const id =
    typeof parsed.id === "string" && parsed.id.trim() !== ""
      ? parsed.id.trim()
      : randomUUID();
  const createdAt =
    typeof parsed.createdAt === "string" ? parsed.createdAt : now;

  return {
    id,
    baseUrl,
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    model,
    temperature: numberOrNull(parsed.temperature),
    maxTokens: numberOrNull(parsed.maxTokens),
    systemPrompt:
      typeof parsed.systemPrompt === "string"
        ? parsed.systemPrompt
        : DEFAULT_SYSTEM_PROMPT,
    timeoutMs: sanitizeTimeoutMs(parsed.timeoutMs),
    thinking: parsed.thinking !== false,
    reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort),
    createdAt,
    updatedAt:
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : createdAt,
  };
}

/**
 * Persists OpenAI-compatible provider configurations in `data/llm.json`.
 * Every save stores the settings as a reusable profile and activates it, so
 * previously configured models stay available. The API key is never returned
 * by the public view and the file is written with mode 0600.
 */
export class LlmConfigStore {
  private current: LlmInternalConfig = { ...DEFAULTS };
  private profiles: LlmProfileRecord[] = [];
  private activeId: string | null = null;
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

    let shouldPersist = false;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed.profiles)) {
        shouldPersist = this.loadProfiles(parsed);
      } else {
        // Legacy single-config layout: fold it into a profile and rewrite.
        shouldPersist = this.loadLegacy(parsed as Partial<LlmInternalConfig>);
      }
    } catch {
      console.error("[llm] ignoring corrupt llm.json");
      return;
    }

    // Never rewrite the file to an empty profile list: that would discard a
    // configuration we merely failed to parse.
    if (shouldPersist && this.profiles.length > 0) {
      await this.persist();
    }

    try {
      await chmod(this.file, 0o600);
    } catch {
      // Best effort; the file may live on a filesystem without POSIX modes.
    }
  }

  /** Loads the versioned layout. Returns true when the file needs rewriting. */
  private loadProfiles(parsed: Record<string, unknown>): boolean {
    let changed = parsed.version !== 2;
    const profiles: LlmProfileRecord[] = [];
    const seenIds = new Set<string>();

    for (const entry of parsed.profiles as unknown[]) {
      const profile = sanitizeProfile(entry);
      if (profile === null) continue;
      if (seenIds.has(profile.id)) {
        profile.id = randomUUID();
        changed = true;
      }
      seenIds.add(profile.id);

      const migrated = migrateModel(profile.baseUrl, profile.model);
      if (migrated !== profile.model) {
        profile.model = migrated;
        changed = true;
      }

      // Keep the most recently used profile when the same model was saved
      // twice by an older/hand-edited file.
      const duplicateIndex = profiles.findIndex(
        (candidate) =>
          candidate.baseUrl === profile.baseUrl &&
          candidate.model === profile.model,
      );
      if (duplicateIndex >= 0) {
        changed = true;
        if (
          profile.updatedAt > profiles[duplicateIndex]!.updatedAt ||
          parsed.activeId === profile.id
        ) {
          profiles[duplicateIndex] = profile;
        }
        continue;
      }
      profiles.push(profile);
    }

    this.profiles = profiles;
    const requestedId =
      typeof parsed.activeId === "string" ? parsed.activeId : null;
    const active =
      profiles.find((profile) => profile.id === requestedId) ??
      profiles[0] ??
      null;
    this.activeId = active?.id ?? null;
    this.current = active ? profileToInternal(active) : { ...DEFAULTS };
    return changed;
  }

  /** Folds a legacy flat config into a profile. Returns true on success. */
  private loadLegacy(parsed: Partial<LlmInternalConfig>): boolean {
    const baseUrl = sanitizeBaseUrl(parsed.baseUrl);
    const rawModel =
      typeof parsed.model === "string" ? parsed.model.trim() : "";
    if (baseUrl === "" || rawModel === "") {
      this.profiles = [];
      this.activeId = null;
      this.current = { ...DEFAULTS };
      return false;
    }

    const now = new Date().toISOString();
    const updatedAt =
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : now;
    const profile: LlmProfileRecord = {
      id: randomUUID(),
      baseUrl,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: migrateModel(baseUrl, rawModel),
      temperature: numberOrNull(parsed.temperature),
      maxTokens: numberOrNull(parsed.maxTokens),
      systemPrompt:
        typeof parsed.systemPrompt === "string"
          ? parsed.systemPrompt
          : DEFAULT_SYSTEM_PROMPT,
      timeoutMs: sanitizeTimeoutMs(parsed.timeoutMs),
      thinking: parsed.thinking !== false,
      reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort),
      createdAt: updatedAt,
      updatedAt,
    };

    this.profiles = [profile];
    this.activeId = profile.id;
    this.current = profileToInternal(profile);
    return true;
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
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
      activeProfileId: this.activeId,
      profiles: this.listProfilesPublic(),
      updatedAt: config.updatedAt,
    };
  }

  private listProfilesPublic(): LlmSettingsPublic["profiles"] {
    return [...this.profiles]
      .sort((a, b) => {
        if (a.id === this.activeId) return -1;
        if (b.id === this.activeId) return 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .map((profile) => ({
        id: profile.id,
        baseUrl: profile.baseUrl,
        model: profile.model,
        hasApiKey: profile.apiKey !== "",
        apiKeyHint: maskApiKey(profile.apiKey),
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        systemPrompt: profile.systemPrompt,
        timeoutMs: profile.timeoutMs,
        thinking: profile.thinking,
        reasoningEffort: profile.reasoningEffort,
        active: profile.id === this.activeId,
        updatedAt: profile.updatedAt,
      }));
  }

  isConfigured(): boolean {
    return this.current.baseUrl !== "" && this.current.model !== "";
  }

  /**
   * API key that a save with these values would keep. Mirrors update()'s
   * inheritance so a connection probe never borrows a key from another
   * provider. Both arguments must already be normalized/trimmed.
   */
  resolveApiKey(baseUrl: string, model: string, profileId?: string): string {
    const existing = this.profiles.find(
      (profile) => profile.baseUrl === baseUrl && profile.model === model,
    );
    if (existing) return existing.apiKey;

    const source =
      profileId !== undefined
        ? (this.profiles.find((profile) => profile.id === profileId) ?? null)
        : null;
    if (source !== null && source.baseUrl === baseUrl) return source.apiKey;
    if (this.current.baseUrl === baseUrl) return this.current.apiKey;
    return "";
  }

  /** Switches the active configuration to a saved profile. */
  async activateProfile(profileId: string): Promise<LlmSettingsPublic> {
    const profile = this.profiles.find(
      (candidate) => candidate.id === profileId,
    );
    if (profile === undefined) {
      throw new AppError(
        "LLM_PROFILE_NOT_FOUND",
        "模型配置不存在或已被删除",
        404,
      );
    }
    this.activeId = profile.id;
    this.current = profileToInternal(profile);
    await this.persist();
    return this.getPublic();
  }

  /**
   * Removes a saved profile. Deleting the active profile falls back to the
   * most recently updated remaining one, or clears the active config.
   */
  async deleteProfile(profileId: string): Promise<LlmSettingsPublic> {
    const index = this.profiles.findIndex(
      (candidate) => candidate.id === profileId,
    );
    if (index < 0) {
      throw new AppError(
        "LLM_PROFILE_NOT_FOUND",
        "模型配置不存在或已被删除",
        404,
      );
    }

    const wasActive = this.activeId === profileId;
    this.profiles.splice(index, 1);
    if (wasActive) {
      const next = this.profiles.reduce<LlmProfileRecord | null>(
        (latest, candidate) =>
          latest === null || candidate.updatedAt > latest.updatedAt
            ? candidate
            : latest,
        null,
      );
      this.activeId = next?.id ?? null;
      this.current = next ? profileToInternal(next) : { ...DEFAULTS };
    }
    await this.persist();
    return this.getPublic();
  }

  async update(input: LlmSettingsInput): Promise<LlmSettingsPublic> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const model = input.model.trim();
    if (model === "") {
      throw new AppError("LLM_INVALID_CONFIG", "Model 不能为空", 400);
    }

    // Profiles are keyed by Base URL + model: saving the same pair updates it
    // in place, while saving another model adds a profile and keeps the old.
    const existing =
      this.profiles.find(
        (profile) => profile.baseUrl === baseUrl && profile.model === model,
      ) ?? null;
    const source =
      input.profileId !== undefined
        ? (this.profiles.find((profile) => profile.id === input.profileId) ??
          null)
        : null;
    const sameProviderSource =
      source !== null && source.baseUrl === baseUrl ? source : null;
    const basis = existing ?? sameProviderSource ?? this.current;

    let apiKey: string;
    if (input.clearApiKey === true) {
      apiKey = "";
    } else if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
      apiKey = input.apiKey.trim();
    } else if (existing !== null) {
      apiKey = existing.apiKey;
    } else if (sameProviderSource !== null) {
      apiKey = sameProviderSource.apiKey;
    } else if (this.current.baseUrl === baseUrl) {
      // Adding another model on the currently active provider reuses its key.
      apiKey = this.current.apiKey;
    } else {
      apiKey = "";
    }

    const now = new Date().toISOString();
    const record: LlmProfileRecord = {
      id: existing?.id ?? randomUUID(),
      baseUrl,
      apiKey,
      model,
      temperature:
        input.temperature === undefined
          ? basis.temperature
          : input.temperature,
      maxTokens:
        input.maxTokens === undefined ? basis.maxTokens : input.maxTokens,
      systemPrompt:
        input.systemPrompt === undefined
          ? basis.systemPrompt
          : input.systemPrompt,
      timeoutMs: resolveTimeoutMs(input.timeoutMs, basis.timeoutMs),
      thinking:
        input.thinking === undefined ? basis.thinking : input.thinking,
      reasoningEffort:
        input.reasoningEffort === undefined
          ? basis.reasoningEffort
          : normalizeReasoningEffort(input.reasoningEffort),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const index = existing === null ? -1 : this.profiles.indexOf(existing);
    if (index >= 0) {
      this.profiles[index] = record;
    } else {
      this.profiles.push(record);
    }
    this.activeId = record.id;
    this.current = profileToInternal(record);

    await this.persist();
    return this.getPublic();
  }

  private persist(): Promise<void> {
    const payload: PersistedLlmConfig = {
      version: 2,
      activeId: this.activeId,
      profiles: this.profiles,
    };
    const data = JSON.stringify(payload, null, 2);
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
