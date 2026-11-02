import { useEffect, useRef, useState } from "react";
import { ArrowRight, Clock, ShieldAlert, Terminal } from "lucide-react";
import { useAppStore } from "../lib/store.js";
import { MODE_LABEL, cn } from "../lib/utils.js";
import { Button, Modal } from "./ui.js";

export function ApprovalDialog() {
  const approval = useAppStore((state) => state.approvals[0] ?? null);
  const queueLength = useAppStore((state) => state.approvals.length);
  const decideApproval = useAppStore((state) => state.decideApproval);
  const [now, setNow] = useState(() => Date.now());
  const [deciding, setDeciding] = useState(false);
  const decidingRef = useRef(false);
  const allowRef = useRef<HTMLButtonElement>(null);

  const approvalId = approval?.id ?? null;

  const decide = async (decision: "allow_once" | "deny"): Promise<void> => {
    if (!approval || decidingRef.current) return;
    decidingRef.current = true;
    setDeciding(true);
    try {
      await decideApproval(approval.id, decision);
    } finally {
      decidingRef.current = false;
      setDeciding(false);
    }
  };

  useEffect(() => {
    if (!approvalId) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [approvalId]);

  useEffect(() => {
    if (!approvalId) return;
    setDeciding(false);
    const frame = requestAnimationFrame(() => allowRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [approvalId]);

  const expiresAt = approval ? Date.parse(approval.expiresAt) : 0;
  const createdAt = approval ? Date.parse(approval.createdAt) : 0;
  const totalSeconds = Math.max(1, Math.round((expiresAt - createdAt) / 1000));
  const remaining = approval ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;

  useEffect(() => {
    if (!approval || remaining <= 0) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        void decide("deny");
      } else if (event.key === "Enter") {
        event.preventDefault();
        void decide("allow_once");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // `decide` is guarded by decidingRef; re-registering on approval change is
    // enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval?.id, remaining <= 0]);

  if (!approval) return null;

  const danger = approval.requestedMode === "danger-full-access";
  const expired = remaining <= 0;
  const progress = Math.max(0, Math.min(100, (remaining / totalSeconds) * 100));

  return (
    <Modal
      open
      title="审批请求"
      description="一次性审批：只对本次调用生效，不提供永久允许。"
      footer={
        <>
          <span className="mr-auto text-[10px] text-muted-foreground/70">
            {queueLength > 1 ? `队列中还有 ${queueLength - 1} 个待审批` : "Enter 允许 · Esc 拒绝"}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={deciding || expired}
            onClick={() => void decide("deny")}
          >
            拒绝
          </Button>
          <Button
            ref={allowRef}
            variant={danger ? "danger" : "primary"}
            size="sm"
            disabled={deciding || expired}
            onClick={() => void decide("allow_once")}
          >
            {expired ? "已超时" : deciding ? "处理中…" : "仅本次允许"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground">
            {MODE_LABEL[approval.currentMode]}
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 font-medium",
              danger
                ? "border-danger/35 bg-danger/10 text-danger"
                : "border-primary/30 bg-primary/10 text-primary",
            )}
          >
            {MODE_LABEL[approval.requestedMode]}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground/80">
            <Clock className="h-3 w-3" />
            {remaining}s
          </span>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              danger ? "bg-danger/80" : "bg-primary/80",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>

        {approval.command ? (
          <div className="overflow-hidden rounded-lg border border-border bg-[#080a0f]">
            <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              <Terminal className="h-3 w-3" />
              命令
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-5 text-foreground/90">
              {approval.command}
            </pre>
          </div>
        ) : null}

        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            申请理由
          </p>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-foreground/85">
            {approval.justification}
          </p>
        </div>

        <div
          className={cn(
            "flex gap-2.5 rounded-lg border p-3",
            danger
              ? "border-danger/25 bg-danger/5"
              : "border-warning/25 bg-warning/5",
          )}
        >
          <ShieldAlert
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              danger ? "text-danger" : "text-warning",
            )}
          />
          <p className="text-[11px] leading-5 text-muted-foreground">
            {danger
              ? "完全权限意味着命令可以读写工作区外的文件、访问网络并执行任意脚本。只有在你明确知道这条命令要做什么时才允许。"
              : "工作区写权限意味着命令可以修改当前工作区与 /tmp 下的文件。"}
            {expired ? " 审批已超时，命令不会执行。" : ""}
          </p>
        </div>
      </div>
    </Modal>
  );
}
