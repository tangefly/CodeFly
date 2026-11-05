import { Terminal } from "lucide-react";
import { ModeSwitcher } from "./ModeSwitcher.js";

export function SidebarHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="px-3 pb-2 pt-4">
      <div className="flex items-center gap-2.5 px-1">
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
          <p className="text-[10px] text-muted-foreground/70">{subtitle}</p>
        </div>
      </div>
      <div className="mt-3">
        <ModeSwitcher />
      </div>
    </div>
  );
}
