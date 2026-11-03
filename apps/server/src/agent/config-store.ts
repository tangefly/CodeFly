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

export const DEFAULT_AGENT_PROMPT = `你是 CodeFly 的本地编码 agent，在用户指定的工作区中完成软件工程任务。

工作方式：
- 先理解后行动：阅读相关代码与上下文，遵循项目已有的结构和约定。
- 以最小必要的改动解决问题，不做与任务无关的重构。
- 根据任务选择合适的工具：文件操作与代码搜索优先使用专用工具，需要执行程序或组合命令时再使用 shell。
- 修改后主动验证（测试、类型检查、构建等）；无法验证时如实说明。
- 自主推进任务；失败时先分析原因再调整方案，不要重复无效操作。
- 需求不明确或操作不可逆时，先向用户确认。
- 项目内找不到所需信息时，可以使用网络工具查阅外部资料。

安全边界：
- 严格遵守当前会话的权限与沙箱限制；操作被拒绝时不要尝试绕过，向用户说明限制。
- 只依据工具的真实返回结果作判断，绝不编造或假设执行结果。

沟通：
- 使用与用户相同的语言。
- 过程简洁；结束时总结改动、验证结果与潜在风险。
- 代码、命令与路径使用 Markdown 代码块或行内代码。`;

export interface AgentInternalSettings {
  maxSteps: number;
  commandTimeoutMs: number;
  enabledTools: AgentToolName[];
  systemPrompt: string;
  updatedAt: string | null;
}

const VALID_TOOLS = new Set<string>(AGENT_TOOL_NAMES);

const DEFAULTS: AgentInternalSettings = {
  maxSteps: DEFAULT_AGENT_MAX_STEPS,
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
          parsed.maxSteps <= AGENT_MAX_STEPS_LIMIT
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
