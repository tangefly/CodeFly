import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_TOOL_NAMES,
  type AgentSettingsInput,
  type AgentSettingsPublic,
  type AgentToolName,
} from "@codefly/protocol";
import { isNotFound } from "../http/errors.js";

export const DEFAULT_AGENT_PROMPT = `你是 CodeFly 的本地编码 agent，工作在用户指定的工作区内。
你可以调用工具读取/写入文件、列目录和执行 shell 命令。

规则：
- 修改文件前先读取相关文件；修改后尽量运行测试或命令验证。
- 文件写入受会话权限与工作区围栏限制。被拒绝时不要尝试绕过，向用户说明限制或请用户调整权限。
- run_command 在 Landlock 沙箱内运行；默认只能写工作区与 /tmp。
- 如果命令被沙箱拒绝，只有工具结果明确建议时，才可以用完全相同的 command 加上 sandbox_permissions 和 justification 重试；这会弹出一次性审批。
- 不要编造工具执行结果，等待真实结果返回。
- 使用与用户相同的语言，回答简洁；代码使用 Markdown 代码块。`;

export interface AgentInternalSettings {
  maxSteps: number;
  commandTimeoutMs: number;
  enabledTools: AgentToolName[];
  systemPrompt: string;
  updatedAt: string | null;
}

const VALID_TOOLS = new Set<string>(AGENT_TOOL_NAMES);

const DEFAULTS: AgentInternalSettings = {
  maxSteps: 10,
  commandTimeoutMs: 60_000,
  enabledTools: [...AGENT_TOOL_NAMES],
  systemPrompt: DEFAULT_AGENT_PROMPT,
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

    try {
      const parsed = JSON.parse(raw) as Partial<AgentInternalSettings>;
      this.current = {
        maxSteps:
          typeof parsed.maxSteps === "number" &&
          parsed.maxSteps >= 1 &&
          parsed.maxSteps <= 30
            ? Math.round(parsed.maxSteps)
            : DEFAULTS.maxSteps,
        commandTimeoutMs:
          typeof parsed.commandTimeoutMs === "number" &&
          parsed.commandTimeoutMs >= 1000 &&
          parsed.commandTimeoutMs <= 600_000
            ? Math.round(parsed.commandTimeoutMs)
            : DEFAULTS.commandTimeoutMs,
        enabledTools: normalizeTools(parsed.enabledTools),
        systemPrompt:
          typeof parsed.systemPrompt === "string"
            ? parsed.systemPrompt
            : DEFAULTS.systemPrompt,
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } catch {
      console.error("[agent] ignoring corrupt agent.json");
      return;
    }

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
      systemPrompt: settings.systemPrompt,
      updatedAt: settings.updatedAt,
    };
  }

  async update(input: AgentSettingsInput): Promise<AgentSettingsPublic> {
    this.current = {
      maxSteps:
        input.maxSteps === undefined
          ? this.current.maxSteps
          : Math.min(30, Math.max(1, Math.round(input.maxSteps))),
      commandTimeoutMs:
        input.commandTimeoutMs === undefined
          ? this.current.commandTimeoutMs
          : Math.min(600_000, Math.max(1000, Math.round(input.commandTimeoutMs))),
      enabledTools:
        input.enabledTools === undefined
          ? this.current.enabledTools
          : normalizeTools(input.enabledTools),
      systemPrompt:
        input.systemPrompt === undefined
          ? this.current.systemPrompt
          : input.systemPrompt,
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
