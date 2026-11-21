import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  MessageCircleQuestion,
  SkipForward,
} from "lucide-react";
import type { AgentQuestionAnswer } from "@codefly/protocol";
import { useAppStore } from "../lib/store.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui.js";

/**
 * A blocking ask_user_question call, docked above the composer so answering
 * stays part of the conversation. The agent run is paused until this panel
 * posts answers, skips, or the server-side timeout expires. Questions from
 * one call are paged; answers survive page switches.
 */
export function QuestionPrompt() {
  const pending = useAppStore((state) => state.questions[0] ?? null);
  const queueLength = useAppStore((state) => state.questions.length);
  const answerQuestion = useAppStore((state) => state.answerQuestion);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);

  const pendingId = pending?.id ?? null;

  useEffect(() => {
    if (!pendingId) return;
    setPage(0);
    setSelected({});
    setCustom({});
    setSubmitting(false);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [pendingId]);

  const remaining = pending
    ? Math.max(0, Math.ceil((Date.parse(pending.expiresAt) - now) / 1000))
    : 0;
  const expired = pending !== null && remaining <= 0;

  const answers = useMemo<AgentQuestionAnswer[]>(() => {
    if (!pending) return [];
    return pending.questions.map((question) => ({
      id: question.id,
      selected: selected[question.id] ?? [],
      ...(custom[question.id]?.trim()
        ? { custom: custom[question.id]!.trim() }
        : {}),
    }));
  }, [pending, selected, custom]);

  if (!pending) return null;

  const total = pending.questions.length;
  const currentPage = Math.min(page, total - 1);
  const question = pending.questions[currentPage];
  if (!question) return null;

  const values = selected[question.id] ?? [];
  const multi = question.multiSelect === true;
  const answeredCount = pending.questions.filter(
    (candidate) =>
      (selected[candidate.id]?.length ?? 0) > 0 ||
      (custom[candidate.id] ?? "").trim() !== "",
  ).length;

  const toggle = (questionId: string, label: string, multiSelect: boolean): void => {
    setSelected((current) => {
      const values = current[questionId] ?? [];
      if (!multiSelect) {
        return {
          ...current,
          [questionId]: values.includes(label) ? [] : [label],
        };
      }
      return {
        ...current,
        [questionId]: values.includes(label)
          ? values.filter((value) => value !== label)
          : [...values, label],
      };
    });
  };

  const submit = async (skip: boolean): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await answerQuestion(
        pending.id,
        skip
          ? pending.questions.map((item) => ({
              id: item.id,
              selected: [],
            }))
          : answers,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative z-20 shrink-0 px-3 pb-2 pt-2 sm:px-6">
      <section
        role="region"
        aria-label="需要你的选择"
        className="cf-fade-up mx-auto w-full max-w-6xl overflow-hidden rounded-2xl border border-primary/30 bg-card/95 shadow-[0_-18px_50px_-30px_rgba(0,0,0,0.9)] backdrop-blur"
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-4 py-2.5">
          <MessageCircleQuestion className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-xs font-semibold text-foreground">
            需要你的选择
          </span>
          {total > 1 ? (
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {currentPage + 1} / {total}
            </span>
          ) : null}
          {queueLength > 1 ? (
            <span className="text-[10px] text-muted-foreground/60">
              还有 {queueLength - 1} 组待回答
            </span>
          ) : null}
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1 font-mono text-[10px]",
              expired ? "text-danger/80" : "text-muted-foreground/70",
            )}
          >
            <Clock className="h-3 w-3" />
            {expired ? "已超时" : `${remaining}s`}
          </span>
        </header>

        <div className="max-h-[45vh] min-h-[220px] overflow-y-auto px-4 py-3">
          <section
            key={question.id}
            aria-live="polite"
            className="cf-fade-up space-y-3"
          >
            <div className="flex items-start gap-2">
              <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-primary/80" />
              <div className="min-w-0">
                {question.header ? (
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                    {question.header}
                  </p>
                ) : null}
                <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
                  {question.question}
                </p>
                {multi ? (
                  <p className="mt-0.5 text-[10px] text-muted-foreground/60">
                    可多选
                  </p>
                ) : null}
              </div>
            </div>

            {question.options && question.options.length > 0 ? (
              <div className="grid gap-2 pl-6">
                {question.options.map((option) => {
                  const active = values.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      disabled={expired}
                      aria-pressed={active}
                      onClick={() => toggle(question.id, option.label, multi)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left transition-colors",
                        active
                          ? "border-primary/50 bg-primary/10"
                          : "border-border bg-muted/10 hover:border-primary/30",
                        expired && "opacity-60",
                      )}
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span
                          className={cn(
                            "shrink-0 text-xs font-medium",
                            active ? "text-primary" : "text-foreground/85",
                          )}
                        >
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className="min-w-0 flex-1 text-[11px] leading-5 text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div className="pl-6">
              <textarea
                value={custom[question.id] ?? ""}
                disabled={expired}
                onChange={(event) =>
                  setCustom((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                placeholder={
                  question.options && question.options.length > 0
                    ? "也可以补充或自定义回答…"
                    : "输入你的回答…"
                }
                rows={2}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs leading-5 outline-none focus:border-primary/50 disabled:opacity-60"
              />
            </div>
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/20 px-3 py-2.5">
          {total > 1 ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= total - 1}
                onClick={() =>
                  setPage((value) => Math.min(total - 1, value + 1))
                }
              >
                下一页
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <span className="text-[10px] text-muted-foreground/60">
                已回答 {answeredCount}/{total}
              </span>
            </>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => void submit(true)}
            >
              <SkipForward className="h-3.5 w-3.5" />
              {total > 1 ? "全部跳过" : "跳过"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={submitting || expired}
              onClick={() => void submit(false)}
            >
              <Check className="h-3.5 w-3.5" />
              {submitting ? "提交中…" : "提交回答"}
            </Button>
          </span>
        </footer>
      </section>
    </div>
  );
}
