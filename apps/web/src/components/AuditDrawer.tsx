import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Activity, RefreshCw, X } from "lucide-react";
import type { AuditEvent } from "@codefly/protocol";
import { selectCurrentSession, useAppStore } from "../lib/store.js";
import { MODE_LABEL, cn } from "../lib/utils.js";
import { Button } from "./ui.js";

function toneFor(event: AuditEvent): string {
  const type = event.type;
  if (type === "llm.chat") {
    return event.outcome === "complete"
      ? "border-primary/25 bg-primary/10 text-primary"
      : "border-danger/30 bg-danger/10 text-danger";
  }
  if (type === "llm.config.changed")
    return "border-sky-400/25 bg-sky-400/10 text-sky-300";
  if (type.startsWith("approval")) return "border-warning/30 bg-warning/10 text-warning";
  if (type === "exec.denied" || type === "sandbox.unavailable")
    return "border-danger/30 bg-danger/10 text-danger";
  if (type === "exec.exit") return "border-primary/25 bg-primary/10 text-primary";
  if (type.startsWith("exec")) return "border-sky-400/25 bg-sky-400/10 text-sky-300";
  if (type === "fs.write") return "border-violet-400/25 bg-violet-400/10 text-violet-300";
  return "border-border bg-muted/40 text-muted-foreground";
}

function summarize(event: AuditEvent): string {
  switch (event.type) {
    case "session.created":
      return `工作区 ${String(event.workspaceRoot ?? "")}`;
    case "permission.changed": {
      const from = event.from as { mode?: string } | undefined;
      const to = event.to as { mode?: string } | undefined;
      return `${from?.mode ?? "?"} → ${to?.mode ?? "?"}`;
    }
    case "settings.changed":
      return `默认权限 ${String(event.defaultPreset ?? "")}`;
    case "exec.started":
      return String(event.command ?? "");
    case "exec.denied":
      return `${String(event.mode ?? "")} · ${String(event.command ?? "")}`;
    case "exec.exit":
      return `code ${event.code ?? "—"} · ${String(event.durationMs ?? 0)} ms${
        event.truncated ? " · truncated" : ""
      }`;
    case "approval.asked":
      return `${String(event.currentMode ?? "")} → ${String(event.requestedMode ?? "")}`;
    case "approval.decided":
      return `${String(event.outcome ?? "")}${
        event.reason ? ` (${String(event.reason)})` : ""
      }`;
    case "fs.write":
      return `${String(event.op ?? "write")} · ${String(event.path ?? "")}`;
    case "sandbox.unavailable":
      return String(event.message ?? "");
    case "llm.config.changed":
      return `${String(event.model ?? "")} · ${String(event.baseUrl ?? "")}`;
    case "llm.chat":
      return `${String(event.outcome ?? "")} · ${String(event.model ?? "")} · ${String(
        event.durationMs ?? 0,
      )} ms`;
    default:
      return "";
  }
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="cf-slide-in absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl">
        {children}
      </aside>
    </div>,
    document.body,
  );
}

export function AuditDrawer() {
  const open = useAppStore((state) => state.ui.auditOpen);
  const close = useAppStore((state) => state.closeAudit);
  const refreshAudit = useAppStore((state) => state.refreshAudit);
  const audit = useAppStore((state) => state.audit);
  const session = useAppStore(selectCurrentSession);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await refreshAudit();
    setRefreshing(false);
  };

  useEffect(() => {
    if (open) void refresh();
    // Only refresh when the drawer opens; refreshAudit is stable in the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const events = [...audit].reverse();

  return (
    <Drawer open={open} onClose={close}>
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/40 text-primary">
          <Activity className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">审计日志</h2>
          <p className="truncate text-[10px] text-muted-foreground">
            {session ? session.title : "未选择会话"} · 最近 {events.length} 条
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新"
          title="刷新"
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="关闭" onClick={close}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {events.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <Activity className="h-6 w-6 opacity-40" />
            <p className="text-xs">还没有审计事件</p>
            <p className="max-w-[240px] text-[10px] leading-4 opacity-70">
              执行命令、切换权限、审批与文件写入都会记录在 data/audit.jsonl。
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {events.map((event, index) => (
              <li
                key={`${event.ts}-${event.type}-${index}`}
                className="rounded-lg border border-border/70 bg-background/35 px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {timeOf(event.ts)}
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-1.5 py-px font-mono text-[9px]",
                      toneFor(event),
                    )}
                  >
                    {event.type}
                  </span>
                  {event.mode ? (
                    <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">
                      {MODE_LABEL[event.mode as keyof typeof MODE_LABEL] ?? String(event.mode)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 break-words text-[11px] leading-4 text-foreground/85">
                  {summarize(event)}
                </p>
                <details className="mt-1 group">
                  <summary className="cursor-pointer select-none text-[9px] text-muted-foreground/50 hover:text-muted-foreground">
                    详情
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-black/30 p-2 font-mono text-[9px] leading-4 text-muted-foreground/80">
                    {JSON.stringify(event, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
