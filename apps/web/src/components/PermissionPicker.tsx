import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Eye,
  Pencil,
  ShieldAlert,
  ShieldOff,
} from "lucide-react";
import type { SandboxMode } from "@codefly/protocol";
import { selectCurrentAgentSession, useAppStore } from "../lib/store.js";
import { MODE_LABEL, cn } from "../lib/utils.js";
import { Button, Modal } from "./ui.js";

const OPTIONS: Array<{
  mode: SandboxMode;
  icon: typeof Eye;
  label: string;
  description: string;
}> = [
  {
    mode: "read-only",
    icon: Eye,
    label: MODE_LABEL["read-only"],
    description: "不能写任何文件；浏览、搜索与分析。",
  },
  {
    mode: "workspace-write",
    icon: Pencil,
    label: MODE_LABEL["workspace-write"],
    description: "只能写工作区与 /tmp；日常编码默认。",
  },
  {
    mode: "danger-full-access",
    icon: ShieldOff,
    label: MODE_LABEL["danger-full-access"],
    description: "可读写工作区外文件、访问网络；无审批。",
  },
];

const MODE_ICON: Record<SandboxMode, typeof Eye> = {
  "read-only": Eye,
  "workspace-write": Pencil,
  "danger-full-access": ShieldOff,
};

export function PermissionPicker({
  disabled,
  placement = "down",
  align = "end",
}: {
  disabled?: boolean;
  /** Where the menu opens relative to the trigger. */
  placement?: "down" | "up";
  /** Which edge the menu aligns to. */
  align?: "start" | "end";
}) {
  const session = useAppStore(selectCurrentAgentSession);
  const updatePermissions = useAppStore((state) => state.updatePermissions);
  const [open, setOpen] = useState(false);
  const [confirmDanger, setConfirmDanger] = useState(false);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const currentMode: SandboxMode = session?.mode ?? "workspace-write";
  const CurrentIcon = MODE_ICON[currentMode];

  const choose = async (mode: SandboxMode): Promise<void> => {
    setOpen(false);
    if (!session || mode === session.mode) return;
    if (mode === "danger-full-access") {
      setConfirmDanger(true);
      return;
    }
    await updatePermissions(mode);
  };

  const confirmFullAccess = async (): Promise<void> => {
    setPending(true);
    const ok = await updatePermissions("danger-full-access", true);
    setPending(false);
    if (ok) setConfirmDanger(false);
  };

  return (
    <>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          disabled={disabled || !session}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-elevated px-2.5 text-xs font-medium text-foreground transition-colors",
            "hover:border-primary/30 hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-45",
            session?.mode === "danger-full-access" && "border-danger/35 text-danger",
          )}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="切换会话权限（仅影响当前会话）"
        >
          <CurrentIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{MODE_LABEL[currentMode]}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>

        {open ? (
          <div
            role="listbox"
            aria-label="会话权限"
            className={cn(
              "cf-fade-up absolute z-40 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-2xl",
              placement === "up" ? "bottom-full mb-2" : "top-full mt-2",
              align === "start" ? "left-0" : "right-0",
            )}
          >
            {OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = session?.mode === option.mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => void choose(option.mode)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    active ? "bg-primary/10" : "hover:bg-muted/60",
                    option.mode === "danger-full-access" && !active && "hover:bg-danger/10",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      option.mode === "danger-full-access"
                        ? "text-danger/80"
                        : active
                          ? "text-primary"
                          : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      {option.label}
                      {active ? <Check className="h-3 w-3 text-primary" /> : null}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </button>
              );
            })}
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] leading-4 text-muted-foreground/60">
              切换立即影响下一次执行；正在运行的命令不受影响。
            </p>
          </div>
        ) : null}
      </div>

      <Modal
        open={confirmDanger}
        onClose={() => (pending ? undefined : setConfirmDanger(false))}
        title="启用完全权限？"
        description="这会移除沙箱。请确认你信任接下来要执行的命令。"
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmDanger(false)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => void confirmFullAccess()}
            >
              {pending ? "正在切换…" : "我了解风险，启用"}
            </Button>
          </>
        }
      >
        <div className="flex gap-3 rounded-lg border border-danger/25 bg-danger/5 p-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <div className="space-y-2 text-xs leading-5 text-muted-foreground">
            <p className="font-medium text-danger">完全权限将允许：</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>直接读写工作区以外的任意文件（包括家目录与系统目录）</li>
              <li>访问网络、下载并执行任意脚本</li>
              <li>不再弹出审批（approval policy = never）</li>
            </ul>
            <p>
              此模式只适合你明确知道要改系统或其他目录的场景。文件工具仍会拒写{" "}
              <code className="rounded bg-muted/60 px-1 font-mono text-[10px]">.git/</code>、{" "}
              <code className="rounded bg-muted/60 px-1 font-mono text-[10px]">.claude/</code>{" "}
              等受保护路径。
            </p>
          </div>
        </div>
      </Modal>
    </>
  );
}
