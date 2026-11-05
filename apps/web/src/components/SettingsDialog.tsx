import { useEffect, useState } from "react";
import { Bot, Eye, Globe, Pencil, ShieldCheck, ShieldOff, Sparkles } from "lucide-react";
import { DEFAULT_AGENT_MAX_STEPS, type SandboxMode } from "@codefly/protocol";
import { useAppStore } from "../lib/store.js";
import { MODE_LABEL, cn } from "../lib/utils.js";
import { Button, Modal } from "./ui.js";

const OPTIONS: Array<{
  mode: SandboxMode;
  icon: typeof Eye;
  description: string;
}> = [
  {
    mode: "read-only",
    icon: Eye,
    description: "新会话不能写文件，只读浏览与搜索。",
  },
  {
    mode: "workspace-write",
    icon: Pencil,
    description: "新会话只能写工作区与 /tmp；推荐默认值。",
  },
  {
    mode: "danger-full-access",
    icon: ShieldOff,
    description: "新会话无沙箱、无审批；需要风险确认。",
  },
];

export function SettingsDialog() {
  const open = useAppStore((state) => state.ui.settingsOpen);
  const close = useAppStore((state) => state.closeSettings);
  const settings = useAppStore((state) => state.settings);
  const sandbox = useAppStore((state) => state.sandbox);
  const llmSettings = useAppStore((state) => state.llmSettings);
  const searchSettings = useAppStore((state) => state.searchSettings);
  const agentSettings = useAppStore((state) => state.agentSettings);
  const saveDefaultPreset = useAppStore((state) => state.saveDefaultPreset);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const openSearchSettings = useAppStore((state) => state.openSearchSettings);
  const openAgentSettings = useAppStore((state) => state.openAgentSettings);

  const [preset, setPreset] = useState<SandboxMode>("workspace-write");
  const [pending, setPending] = useState(false);
  const [dangerAcknowledged, setDangerAcknowledged] = useState(false);

  useEffect(() => {
    if (open) {
      setPreset(settings?.defaultPreset ?? "workspace-write");
      setPending(false);
      setDangerAcknowledged(false);
    }
  }, [open, settings?.defaultPreset]);

  const needsDangerConfirmation =
    preset === "danger-full-access" && settings?.defaultPreset !== "danger-full-access";

  const save = async (): Promise<void> => {
    setPending(true);
    const ok = await saveDefaultPreset(preset);
    setPending(false);
    if (ok) close();
  };

  return (
    <Modal
      open={open}
      onClose={pending ? undefined : close}
      title="设置"
      description="这些设置只影响本机服务；会话创建后权限仍可单独切换。"
      footer={
        <>
          <Button variant="outline" size="sm" disabled={pending} onClick={close}>
            关闭
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={
              pending ||
              preset === settings?.defaultPreset ||
              (needsDangerConfirmation && !dangerAcknowledged)
            }
            onClick={() => void save()}
          >
            {pending ? "保存中…" : "保存默认权限"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">模型 API</h3>
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[9px]",
                llmSettings?.configured
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-warning/30 bg-warning/10 text-warning",
              )}
            >
              {llmSettings?.configured ? "已配置" : "未配置"}
            </span>
          </div>
          <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-border bg-background/40 px-3 py-2.5">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              {llmSettings?.configured ? (
                <>
                  <p className="truncate text-xs font-medium text-foreground">
                    {llmSettings.model}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                    {llmSettings.baseUrl}
                  </p>
                </>
              ) : (
                <p className="text-[11px] leading-5 text-muted-foreground">
                  对话、Agent 与论文助手都需要配置 OpenAI-compatible 模型 API。
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={openLlmSettings}
            >
              配置
            </Button>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">联网搜索</h3>
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[9px]",
                searchSettings?.configured
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-warning/30 bg-warning/10 text-warning",
              )}
            >
              {searchSettings?.configured ? "已配置" : "未配置"}
            </span>
          </div>
          <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-border bg-background/40 px-3 py-2.5">
            <Globe className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              {searchSettings?.configured ? (
                <>
                  <p className="truncate text-xs font-medium text-foreground">
                    {searchSettings.endpoint}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    独立搜索 Key：{searchSettings.hasApiKey ? "已保存" : "未设置"}
                  </p>
                </>
              ) : (
                <p className="text-[11px] leading-5 text-muted-foreground">
                  Agent 的 web_search 需要单独配置搜索 API；与聊天模型互不复用。
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={openSearchSettings}
            >
              配置
            </Button>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">Agent 模式</h3>
            <span className="font-mono text-[9px] text-muted-foreground/60">
              {agentSettings?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS} steps
            </span>
          </div>
          <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-border bg-background/40 px-3 py-2.5">
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] leading-5 text-muted-foreground">
                tool-calling / agent loop：模型可调用命令与文件工具，最多{" "}
                {agentSettings?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS} 步，已启用{" "}
                {agentSettings?.enabledTools.length ?? 0} 个工具。
              </p>
              <p className="mt-0.5 text-[9px] text-muted-foreground/60">
                工具在会话权限下执行；提权需一次性审批。
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={openAgentSettings}
            >
              配置
            </Button>
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold text-foreground">新会话默认权限</h3>
          <div className="mt-2 space-y-1.5">
            {OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = preset === option.mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => setPreset(option.mode)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-primary/35 bg-primary/10"
                      : "border-border bg-background/40 hover:bg-muted/40",
                    option.mode === "danger-full-access" && !active && "hover:border-danger/25",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      option.mode === "danger-full-access"
                        ? "text-danger/80"
                        : active
                          ? "text-primary"
                          : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-foreground">
                      {MODE_LABEL[option.mode]}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "mt-1 h-3 w-3 shrink-0 rounded-full border",
                      active ? "border-primary bg-primary" : "border-border",
                    )}
                  />
                </button>
              );
            })}
          </div>
          {needsDangerConfirmation ? (
            <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
              <input
                type="checkbox"
                checked={dangerAcknowledged}
                onChange={(event) => setDangerAcknowledged(event.target.checked)}
                className="mt-0.5 h-3 w-3 accent-[var(--danger)]"
              />
              <span>
                我了解：新会话默认使用「完全权限」，命令将无沙箱、无审批地读写工作区外文件并访问网络。
              </span>
            </label>
          ) : null}
        </section>

        <section>
          <h3 className="text-xs font-semibold text-foreground">沙箱</h3>
          <div className="mt-2 rounded-lg border border-border bg-background/40 p-3">
            <div className="flex items-center gap-2 text-xs">
              <ShieldCheck
                className={cn(
                  "h-4 w-4",
                  sandbox?.available ? "text-primary" : "text-danger",
                )}
              />
              <span className="font-medium text-foreground">
                {sandbox?.available
                  ? `${sandbox.runner} · ${sandbox.probe}`
                  : "沙箱不可用"}
              </span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
                {sandbox?.platform ?? "unknown"}
              </span>
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
              {sandbox?.details ??
                "非完全权限模式要求至少一个可用的沙箱 runner，否则拒绝执行。"}
            </p>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] leading-4 text-muted-foreground/70">
            <li>读取与网络默认不隔离：命令可以读本机文件并联网。</li>
            <li>沙箱不可用时 fail-closed，不会降级为无沙箱执行。</li>
            <li>文件工具额外拒绝写入 .git/、.claude/ 等受保护路径。</li>
            <li>审批一次性有效；超时或断连都视为拒绝。</li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}
