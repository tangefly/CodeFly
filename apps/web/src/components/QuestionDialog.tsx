import { useEffect, useMemo, useState } from "react";
import { Check, Clock, MessageCircleQuestion, SkipForward } from "lucide-react";
import type { AgentQuestionAnswer } from "@codefly/protocol";
import { useAppStore } from "../lib/store.js";
import { cn } from "../lib/utils.js";
import { Button, Modal } from "./ui.js";

/**
 * A blocking ask_user_question call. The agent run is paused until this dialog
 * posts answers, skips, or the server-side timeout expires.
 */
export function QuestionDialog() {
  const pending = useAppStore((state) => state.questions[0] ?? null);
  const queueLength = useAppStore((state) => state.questions.length);
  const answerQuestion = useAppStore((state) => state.answerQuestion);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);

  const pendingId = pending?.id ?? null;

  useEffect(() => {
    if (!pendingId) return;
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

  const toggle = (questionId: string, label: string, multi: boolean): void => {
    setSelected((current) => {
      const values = current[questionId] ?? [];
      if (!multi) {
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
          ? pending.questions.map((question) => ({
              id: question.id,
              selected: [],
            }))
          : answers,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title="需要你的选择"
      description="Code 已暂停当前工具调用，回答后会继续执行。"
      footer={
        <>
          <span className="mr-auto inline-flex items-center gap-2 text-[10px] text-muted-foreground/70">
            <Clock className="h-3 w-3" />
            {expired ? "已超时" : `${remaining}s`}
            {queueLength > 1 ? ` · 还有 ${queueLength - 1} 个问题` : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => void submit(true)}
          >
            <SkipForward className="h-3.5 w-3.5" />
            跳过
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
        </>
      }
    >
      <div className="space-y-5">
        {pending.questions.map((question) => {
          const values = selected[question.id] ?? [];
          const multi = question.multiSelect === true;
          return (
            <section key={question.id} className="space-y-2.5">
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
                        onClick={() =>
                          toggle(question.id, option.label, multi)
                        }
                        className={cn(
                          "rounded-lg border px-3 py-2 text-left transition-colors",
                          active
                            ? "border-primary/50 bg-primary/10"
                            : "border-border bg-muted/10 hover:border-primary/30",
                          expired && "opacity-60",
                        )}
                      >
                        <span
                          className={cn(
                            "text-xs font-medium",
                            active ? "text-primary" : "text-foreground/85",
                          )}
                        >
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
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
                  placeholder="也可以直接输入回答…"
                  rows={2}
                  className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs leading-5 outline-none focus:border-primary/50 disabled:opacity-60"
                />
              </div>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
