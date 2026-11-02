import { useEffect, useRef, useState } from "react";
import { FolderOpen, ShieldCheck } from "lucide-react";
import { useAppStore } from "../lib/store.js";
import { Button, Modal } from "./ui.js";

export function NewSessionDialog() {
  const open = useAppStore((state) => state.ui.newSessionOpen);
  const close = useAppStore((state) => state.closeNewSession);
  const createSession = useAppStore((state) => state.createSession);
  const sandbox = useAppStore((state) => state.sandbox);
  const settings = useAppStore((state) => state.settings);

  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setWorkspaceRoot("");
    setTitle("");
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const submit = async (): Promise<void> => {
    if (!workspaceRoot.trim() || pending) return;
    setPending(true);
    const ok = await createSession(
      workspaceRoot.trim(),
      title.trim() || undefined,
    );
    setPending(false);
    if (ok) close();
  };

  return (
    <Modal
      open={open}
      onClose={pending ? undefined : close}
      title="新建会话"
      description="绑定一个已存在的本机工作区目录。工作区路径在创建后不可变。"
      footer={
        <>
          <Button variant="outline" size="sm" disabled={pending} onClick={close}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending || !workspaceRoot.trim()}
            onClick={() => void submit()}
          >
            {pending ? "创建中…" : "创建会话"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-3.5"
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            工作区路径 <span className="text-danger">*</span>
          </span>
          <div className="relative">
            <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              value={workspaceRoot}
              onChange={(event) => setWorkspaceRoot(event.target.value)}
              placeholder="/home/you/project"
              spellCheck={false}
              className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <span className="mt-1 block text-[10px] leading-4 text-muted-foreground/70">
            必须是绝对路径，且目录已存在。
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            标题 <span className="text-muted-foreground/60">(可选)</span>
          </span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="默认使用目录名"
            maxLength={120}
            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </label>

        <div className="flex gap-2 rounded-lg border border-border bg-muted/20 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 text-[11px] leading-5 text-muted-foreground">
            <p>
              新会话默认权限为「
              {settings?.defaultPreset === "danger-full-access"
                ? "完全权限"
                : settings?.defaultPreset === "read-only"
                  ? "仅可查看"
                  : "工作区内修改"}
              」，可在创建后切换。
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              沙箱：{sandbox?.runner ?? "不可用"} · {sandbox?.probe ?? "unknown"}
              {sandbox?.available === false
                ? "（非完全权限的执行将被拒绝）"
                : ""}
            </p>
          </div>
        </div>
      </form>
    </Modal>
  );
}
