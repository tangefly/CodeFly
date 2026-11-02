import { useState } from "react";
import {
  Folder,
  Plus,
  Settings,
  ShieldCheck,
  ShieldX,
  Terminal,
  Trash2,
} from "lucide-react";
import type { SandboxMode, Session } from "@codefly/protocol";
import { useAppStore } from "../lib/store.js";
import { MODE_SHORT_LABEL, basename, cn, relativeTime } from "../lib/utils.js";
import { Button, Modal, StatusDot } from "./ui.js";

const MODE_DOT: Record<SandboxMode, string> = {
  "read-only": "bg-sky-400",
  "workspace-write": "bg-primary",
  "danger-full-access": "bg-danger",
};

export function Sidebar() {
  const sessions = useAppStore((state) => state.sessions);
  const currentId = useAppStore((state) => state.currentSessionId);
  const selectSession = useAppStore((state) => state.selectSession);
  const openNewSession = useAppStore((state) => state.openNewSession);
  const openSettings = useAppStore((state) => state.openSettings);
  const open = useAppStore((state) => state.ui.sidebarOpen);
  const close = useAppStore((state) => state.closeSidebar);
  const sandbox = useAppStore((state) => state.sandbox);
  const deleteSession = useAppStore((state) => state.deleteSession);
  const chatBusy = useAppStore((state) => state.chatBusy);
  const agentBusy = useAppStore((state) => state.agentBusy);
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    const deleted = await deleteSession(pendingDelete.id);
    setDeleting(false);
    if (deleted) setPendingDelete(null);
  };

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-[1px] lg:hidden"
          onClick={close}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-border bg-canvas transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary shadow-[0_0_30px_-10px_var(--primary)]">
            <Terminal className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold tracking-tight">CodeFly</span>
              <span className="rounded border border-border px-1 py-px font-mono text-[9px] text-muted-foreground/70">
                v0.1
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground/70">local agent console</p>
          </div>
        </div>

        <div className="px-3 pb-2">
          <Button
            variant="secondary"
            size="md"
            className="w-full justify-start border-dashed text-xs"
            onClick={openNewSession}
          >
            <Plus className="h-4 w-4" />
            新建会话
          </Button>
        </div>

        <div className="flex items-center justify-between px-4 pb-1 pt-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">
            会话
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/50">
            {sessions.length}
          </span>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sessions.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] leading-5 text-muted-foreground/60">
              还没有会话。
              <br />
              创建一个并绑定工作区目录。
            </p>
          ) : (
            <ul className="space-y-1">
              {sessions.map((session) => {
                const active = session.id === currentId;
                const busy = Boolean(
                  chatBusy[session.id] || agentBusy[session.id],
                );
                return (
                  <li key={session.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => selectSession(session.id)}
                      className={cn(
                        "w-full rounded-xl border px-2.5 py-2 pr-9 text-left transition-colors",
                        active
                          ? "border-primary/30 bg-primary/10"
                          : "border-transparent hover:border-border hover:bg-muted/40",
                      )}
                      title={session.workspaceRoot}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            MODE_DOT[session.mode],
                          )}
                        />
                        <span
                          className={cn(
                            "truncate text-xs font-medium",
                            active ? "text-foreground" : "text-foreground/85",
                          )}
                        >
                          {session.title}
                        </span>
                        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/50">
                          {relativeTime(session.updatedAt)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 pl-3.5">
                        <Folder className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" />
                        <span className="truncate font-mono text-[9px] text-muted-foreground/60">
                          {basename(session.workspaceRoot)}
                        </span>
                        <span className="ml-auto shrink-0 rounded bg-muted/50 px-1 py-px text-[8px] text-muted-foreground/70">
                          {MODE_SHORT_LABEL[session.mode]}
                        </span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(session)}
                      disabled={busy}
                      aria-label={`删除会话 ${session.title}`}
                      title={busy ? "会话执行中，停止后才能删除" : "删除会话"}
                      className="absolute right-1.5 top-1.5 rounded-md p-1.5 text-muted-foreground/40 opacity-100 transition-colors hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 lg:opacity-0 lg:group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t border-border/70 p-2.5">
          <button
            type="button"
            onClick={openSettings}
            className="flex w-full items-center gap-2.5 rounded-xl border border-border/70 bg-card/40 px-2.5 py-2 text-left transition-colors hover:border-primary/25 hover:bg-muted/30"
          >
            {sandbox?.available ? (
              <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
            ) : (
              <ShieldX className="h-4 w-4 shrink-0 text-danger" />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium">
                <StatusDot
                  className={sandbox?.available ? "bg-primary" : "bg-danger"}
                  pulse={Boolean(sandbox?.available)}
                />
                {sandbox?.available
                  ? `${sandbox.runner} · ${sandbox.probe}`
                  : "沙箱不可用"}
              </span>
              <span className="mt-0.5 block truncate text-[9px] text-muted-foreground/60">
                {sandbox?.available
                  ? "非完全权限命令在沙箱内执行"
                  : "非完全权限执行会被拒绝"}
              </span>
            </span>
            <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          </button>
        </div>
      </aside>

      <Modal
        open={pendingDelete !== null}
        onClose={deleting ? undefined : () => setPendingDelete(null)}
        title="删除会话"
        description="此操作不可撤销。"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "删除"}
            </Button>
          </>
        }
      >
        <p className="text-xs leading-5 text-muted-foreground">
          将永久删除会话「{pendingDelete?.title ?? ""}」及其全部聊天与工具记录。
          工作区中的文件不会被删除。
        </p>
      </Modal>
    </>
  );
}
