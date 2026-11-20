import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_MAX_STEPS_LIMIT,
  AGENT_TOOL_NAMES,
  DEFAULT_AGENT_MAX_STEPS,
  type AgentSettingsInput,
  type AgentSettingsPublic,
  type AgentToolName,
} from "@codefly/protocol";
import { isNotFound } from "../http/errors.js";
import { loadPromptFile } from "../prompt-file.js";

export const DEFAULT_AGENT_PROMPT = loadPromptFile(import.meta.url);

export interface AgentInternalSettings {
  maxSteps: number;
  commandTimeoutMs: number;
  enabledTools: AgentToolName[];
  personaPrefix: string;
  personaSuffix: string;
  /** Bumped when the built-in tool set grows, so old settings gain new tools. */
  toolSchemaVersion: number;
  updatedAt: string | null;
}

const VALID_TOOLS = new Set<string>(AGENT_TOOL_NAMES);

const TOOL_SCHEMA_VERSION = 2;
const TOOLS_ADDED_V2: AgentToolName[] = [
  "apply_patch",
  "job_output",
  "job_list",
  "job_kill",
  "write_stdin",
  "todo_write",
  "ask_user_question",
];

const DEFAULTS: AgentInternalSettings = {
  maxSteps: DEFAULT_AGENT_MAX_STEPS,
  commandTimeoutMs: 60_000,
  enabledTools: [...AGENT_TOOL_NAMES],
  personaPrefix: "",
  personaSuffix: "",
  toolSchemaVersion: TOOL_SCHEMA_VERSION,
  updatedAt: null,
};

function normalizeTools(value: unknown): AgentToolName[] {
  if (!Array.isArray(value)) return [...AGENT_TOOL_NAMES];
  const tools = value.filter(
    (tool): tool is AgentToolName =>
      typeof tool === "string" && VALID_TOOLS.has(tool),
  );
  return [...new Set(tools)];
}

/**
 * Pre-persona builds stored a full system prompt that replaced the default.
 * An untouched copy of the default maps to no persona; a user edit survives
 * as the persona prefix so core harness guidance is never lost.
 */
function legacyPromptToPrefix(
  parsed: Partial<AgentInternalSettings & { systemPrompt?: unknown }>,
): string {
  if (typeof parsed.systemPrompt !== "string") return "";
  const trimmed = parsed.systemPrompt.trim();
  return trimmed !== "" && trimmed !== DEFAULT_AGENT_PROMPT.trim()
    ? parsed.systemPrompt
    : "";
}

export class AgentConfigStore {
  private current: AgentInternalSettings = {
    ...DEFAULTS,
    enabledTools: [...DEFAULTS.enabledTools],
  };
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) console.error("[agent] ignoring unreadable agent.json");
      return;
    }

    let needsPersist = false;
    try {
      const parsed = JSON.parse(raw) as Partial<
        AgentInternalSettings & { systemPrompt?: unknown }
      >;
      const storedVersion =
        typeof parsed.toolSchemaVersion === "number"
          ? parsed.toolSchemaVersion
          : 1;
      const storedTools = normalizeTools(parsed.enabledTools);
      const migratedTools =
        storedVersion < TOOL_SCHEMA_VERSION && Array.isArray(parsed.enabledTools)
          ? [...new Set([...storedTools, ...TOOLS_ADDED_V2])]
          : storedTools;
      if (storedVersion < TOOL_SCHEMA_VERSION) needsPersist = true;
      this.current = {
        maxSteps:
          typeof parsed.maxSteps === "number" &&
          parsed.maxSteps >= 1 &&
          parsed.maxSteps <= AGENT_MAX_STEPS_LIMIT
            ? Math.round(parsed.maxSteps)
            : DEFAULTS.maxSteps,
        commandTimeoutMs:
          typeof parsed.commandTimeoutMs === "number" &&
          parsed.commandTimeoutMs >= 1000 &&
          parsed.commandTimeoutMs <= 600_000
            ? Math.round(parsed.commandTimeoutMs)
            : DEFAULTS.commandTimeoutMs,
        enabledTools: migratedTools,
        personaPrefix:
          typeof parsed.personaPrefix === "string"
            ? parsed.personaPrefix
            : legacyPromptToPrefix(parsed),
        personaSuffix:
          typeof parsed.personaSuffix === "string" ? parsed.personaSuffix : "",
        toolSchemaVersion: TOOL_SCHEMA_VERSION,
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } catch {
      console.error("[agent] ignoring corrupt agent.json");
      return;
    }

    if (needsPersist) await this.persist();

    try {
      await chmod(this.file, 0o600);
    } catch {
      // Best effort.
    }
  }

  getInternal(): AgentInternalSettings {
    return { ...this.current, enabledTools: [...this.current.enabledTools] };
  }

  getPublic(): AgentSettingsPublic {
    const settings = this.current;
    return {
      maxSteps: settings.maxSteps,
      commandTimeoutMs: settings.commandTimeoutMs,
      enabledTools: [...settings.enabledTools],
      personaPrefix: settings.personaPrefix,
      personaSuffix: settings.personaSuffix,
      updatedAt: settings.updatedAt,
    };
  }

  async update(input: AgentSettingsInput): Promise<AgentSettingsPublic> {
    this.current = {
      maxSteps:
        input.maxSteps === undefined
          ? this.current.maxSteps
          : Math.min(
              AGENT_MAX_STEPS_LIMIT,
              Math.max(1, Math.round(input.maxSteps)),
            ),
      commandTimeoutMs:
        input.commandTimeoutMs === undefined
          ? this.current.commandTimeoutMs
          : Math.min(600_000, Math.max(1000, Math.round(input.commandTimeoutMs))),
      enabledTools:
        input.enabledTools === undefined
          ? this.current.enabledTools
          : normalizeTools(input.enabledTools),
      personaPrefix:
        input.personaPrefix === undefined
          ? this.current.personaPrefix
          : input.personaPrefix,
      personaSuffix:
        input.personaSuffix === undefined
          ? this.current.personaSuffix
          : input.personaSuffix,
      toolSchemaVersion: this.current.toolSchemaVersion,
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
        console.error("[agent] failed to persist settings", error);
      });
    return this.persistQueue;
  }
}
