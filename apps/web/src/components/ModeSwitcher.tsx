import { BookOpen, Bot, CalendarDays, MessageSquare } from "lucide-react";
import type { SessionKind } from "@codefly/protocol";
import { useAppStore } from "../lib/store.js";
import { cn } from "../lib/utils.js";

const MODES: Array<{
  id: SessionKind;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "agent", label: "Code", icon: Bot },
  { id: "paper", label: "论文", icon: BookOpen },
  { id: "schedule", label: "日程", icon: CalendarDays },
];

/** Switches between the independent UIs (chat, code, paper, schedule). */
export function ModeSwitcher() {
  const mode = useAppStore((state) => state.mode);
  const setMode = useAppStore((state) => state.setMode);

  return (
    <div
      role="tablist"
      aria-label="工作模式"
      className="grid grid-cols-4 gap-1 rounded-xl border border-border bg-card/50 p-1"
    >
      {MODES.map(({ id, label, icon: Icon }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setMode(id)}
            className={cn(
              "flex h-8 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium transition-colors",
              active
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
