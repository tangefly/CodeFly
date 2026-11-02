import { useEffect, useState } from "react";
import { Bot, Loader2, ShieldCheck } from "lucide-react";
import type { AgentToolName } from "@codefly/protocol";
import { useAppStore } from "../lib/store.js";
import { cn } from "../lib/utils.js";
import { Button, Modal } from "./ui.js";

const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/45 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20";

const TOOL_INFO: Array<{
  name: AgentToolName;
  label: string;
  description: string;
}> = [
  {
    name: "run_command",
    label: "运行命令",
    description: "bash -c，在 Landlock 沙箱内执行；可请求一次性提权审批。",
  },
  {
    name: "read_file",
    label: "读取文件",
    description: "读取 UTF-8 文本文件；相对路径基于工作区。",
  },
  {
    name: "write_file",
    label: "写入文件",
    description: "创建/覆盖文件，受工作区围栏与受保护路径限制。",
  },
  {
    name: "edit_file",
    label: "编辑文件",
    description: "精确字符串替换，默认要求唯一匹配。",
  },
  {
    name: "list_files",
    label: "列出目录",
    description: "浏览工作区或绝对目录，最多 500 项。",
  },
];

export function AgentSettingsDialog() {
  const open = useAppStore((state) => state.ui.agentSettingsOpen);
  const close = useAppStore((state) => state.closeAgentSettings);
  const settings = useAppStore((state) => state.agentSettings);
  const llmSettings = useAppStore((state) => state.llmSettings);
  const saveAgentSettings = useAppStore((state) => state.saveAgentSettings);

  const [maxSteps, setMaxSteps] = useState("10");
  const [commandTimeoutMs, setCommandTimeoutMs] = useState("60000");
  const [enabledTools, setEnabledTools] = useState<AgentToolName[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMaxSteps(String(settings?.maxSteps ?? 10));
    setCommandTimeoutMs(String(settings?.commandTimeoutMs ?? 60_000));
    setEnabledTools(settings?.enabledTools ?? TOOL_INFO.map((tool) => tool.name));
    setSystemPrompt(settings?.systemPrompt ?? "");
    setSaving(false);
    setError(null);
  }, [open, settings?.updatedAt]);

  const toggleTool = (name: AgentToolName): void => {
    setEnabledTools((current) =>
      current.includes(name)
        ? current.filter((tool) => tool !== name)
        : [...current, name],
    );
  };

  const save = async (): Promise<void> => {
    const steps = Number(maxSteps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 30) {
      setError("最大步数必须是 1 到 30 之间的整数。");
      return;
    }
    const timeout = Number(commandTimeoutMs);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000) {
      setError("命令超时必须是 1000 到 600000 毫秒之间的整数。");
      return;
    }
    setSaving(true);
    const ok = await saveAgentSettings({
      maxSteps: steps,
      commandTimeoutMs: timeout,
      enabledTools,
      systemPrompt,
    });
    setSaving(false);
    if (ok) close();
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : close}
      title="Agent 设置"
      description="控制 tool-calling / agent loop。工具在会话权限下执行；模型请求提权时会弹一次性审批。"
      className="max-w-xl"
      footer={
        <>
          <Button variant="outline" size="sm" disabled={saving} onClick={close}>
            关闭
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            保存 Agent 配置
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[10px] leading-5 text-muted-foreground">
          <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            Agent 会长耗时地循环「模型 → 工具 → 模型」，直到模型不再调用工具或达到最大步数。
            当前模型：
            <span className="text-foreground">
              {llmSettings?.model || "未配置"}
            </span>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 flex items-baseline justify-between">
              <span className="text-[11px] font-medium text-foreground">最大步数</span>
              <span className="text-[9px] text-muted-foreground/60">1–30</span>
            </span>
            <input
              value={maxSteps}
              onChange={(event) => setMaxSteps(event.target.value)}
              inputMode="numeric"
              className={cn(INPUT_CLASS, "font-mono")}
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-baseline justify-between">
              <span className="text-[11px] font-medium text-foreground">命令超时（ms）</span>
              <span className="text-[9px] text-muted-foreground/60">每步工具</span>
            </span>
            <input
              value={commandTimeoutMs}
              onChange={(event) => setCommandTimeoutMs(event.target.value)}
              inputMode="numeric"
              className={cn(INPUT_CLASS, "font-mono")}
            />
          </label>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] font-medium text-foreground">启用的工具</p>
          <div className="space-y-1.5">
            {TOOL_INFO.map((tool) => {
              const active = enabledTools.includes(tool.name);
              return (
                <label
                  key={tool.name}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors",
                    active
                      ? "border-primary/30 bg-primary/5"
                      : "border-border bg-background/40 hover:bg-muted/30",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleTool(tool.name)}
                    className="mt-0.5 h-3 w-3 accent-[var(--primary)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] font-medium text-foreground">
                      {tool.label}
                      <span className="ml-1.5 font-mono text-[9px] font-normal text-muted-foreground/60">
                        {tool.name}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[9px] leading-4 text-muted-foreground">
                      {tool.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {enabledTools.length === 0 ? (
            <p className="mt-1 text-[10px] text-warning">
              未启用任何工具，Agent 只能对话。
            </p>
          ) : null}
        </div>

        <details className="rounded-lg border border-border bg-background/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-[11px] font-medium text-foreground">
            高级：Agent system prompt
          </summary>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={6}
            className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[11px] leading-5 text-foreground placeholder:text-muted-foreground/45 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </details>

        <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[10px] leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            文件工具不能请求一次性提权；被围栏拒绝时模型会收到错误。命令被沙箱拒绝后，模型可用
            <code className="mx-1 rounded bg-muted/60 px-1 font-mono text-[9px]">
              sandbox_permissions + justification
            </code>
            重试同一条命令，由你在审批弹窗中决定。
          </span>
        </div>

        {error ? (
          <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
