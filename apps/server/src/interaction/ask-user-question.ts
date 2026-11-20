import { z } from "zod";
import type {
  AgentEvent,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionOutcome,
  AgentToolMeta,
} from "@codefly/protocol";
import type { LlmToolDefinition } from "../llm/client.js";

export interface QuestionAskInput {
  sessionId: string;
  toolCallId: string;
  messageId: string;
  questions: AgentQuestion[];
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}

export interface QuestionAskResult {
  answers: AgentQuestionAnswer[];
  outcome: AgentQuestionOutcome;
}

/** Minimal QuestionService surface needed by the ask_user_question tool. */
export interface QuestionServiceLike {
  ask(input: QuestionAskInput): Promise<QuestionAskResult>;
}

/** Everything the shared ask_user_question tool needs from its caller. */
export interface AskUserQuestionContext {
  sessionId: string;
  toolCallId: string;
  messageId: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  questions: QuestionServiceLike;
}

export interface AskUserQuestionToolResult {
  content: string;
  status: "complete" | "error" | "cancelled";
  meta: AgentToolMeta;
}

export const ASK_USER_QUESTION_DEFINITION: LlmToolDefinition = {
  type: "function",
  function: {
    name: "ask_user_question",
    description:
      "Ask the user one or more questions when a decision, confirmation or missing information blocks progress. This call blocks until the user answers, skips, or the request times out. Provide options when the choice is finite; set multi_select when several answers are allowed. Do not use it for information you can obtain with tools.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          description: "Questions to ask before continuing.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable id echoed in the answer.",
              },
              question: {
                type: "string",
                description: "The specific question to ask.",
              },
              header: {
                type: "string",
                description: "Optional short heading such as Confirm or Choose.",
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 20,
                description:
                  "Optional choices. Put a recommended option first and append (Recommended) to its label.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Short user-facing label.",
                    },
                    description: {
                      type: "string",
                      description: "One sentence explaining the tradeoff.",
                    },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
              multi_select: {
                type: "boolean",
                description:
                  "Whether the user may select more than one option. Defaults to false.",
              },
            },
            required: ["id", "question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
};

const askUserQuestionArgs = z
  .object({
    questions: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            question: z.string().trim().min(1).max(4_000),
            header: z.string().trim().max(200).optional(),
            options: z
              .array(
                z
                  .object({
                    label: z.string().trim().min(1).max(500),
                    description: z.string().trim().max(2_000).optional(),
                  })
                  .strict(),
              )
              .min(2)
              .max(20)
              .optional(),
            multi_select: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

function parseArgs<T>(
  schema: z.ZodType<T>,
  raw: string,
): { ok: true; data: T } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === "" ? "{}" : raw);
  } catch {
    return { ok: false, message: "Tool arguments must be valid JSON." };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `Invalid tool arguments: ${details}` };
  }
  return { ok: true, data: result.data };
}

function questionError(message: string): AskUserQuestionToolResult {
  return { content: message, status: "error", meta: { kind: "question" } };
}

/**
 * Shared implementation of the blocking ask_user_question tool. Agent and
 * schedule sessions use the same QuestionService, so the question flow and
 * result formatting stay identical across both assistants.
 */
export async function askUserQuestionResult(
  rawArgs: string,
  ctx: AskUserQuestionContext,
): Promise<AskUserQuestionToolResult> {
  const parsed = parseArgs(askUserQuestionArgs, rawArgs);
  if (!parsed.ok) return questionError(parsed.message);
  const questions: AgentQuestion[] = parsed.data.questions.map((question) => ({
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : { options: question.options }),
    ...(question.multi_select === undefined
      ? {}
      : { multiSelect: question.multi_select }),
  }));

  try {
    const result = await ctx.questions.ask({
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      messageId: ctx.messageId,
      questions,
      signal: ctx.signal,
      emit: ctx.emit,
    });

    if (result.outcome === "timeout") {
      return {
        content:
          "The user did not answer before the question timed out. Continue with your best judgment, or ask again later with a shorter question.",
        status: "complete",
        meta: {
          kind: "question",
          questions,
          answers: result.answers,
          questionOutcome: result.outcome,
        },
      };
    }
    if (result.outcome === "cancelled") {
      return {
        content: "The question was cancelled because the turn was stopped.",
        status: "cancelled",
        meta: {
          kind: "question",
          questions,
          answers: result.answers,
          questionOutcome: result.outcome,
        },
      };
    }

    const byId = new Map(result.answers.map((answer) => [answer.id, answer]));
    const lines = questions.map((question) => {
      const answer = byId.get(question.id);
      if (
        !answer ||
        (answer.selected.length === 0 && (answer.custom ?? "").trim() === "")
      ) {
        return `- ${question.id}: (skipped)`;
      }
      const selected =
        answer.selected.length > 0 ? answer.selected.join(", ") : "(none)";
      const custom =
        answer.custom !== undefined && answer.custom.trim() !== ""
          ? `; custom: ${answer.custom.trim()}`
          : "";
      return `- ${question.id}: ${selected}${custom}`;
    });
    return {
      content: `User answers:\n${lines.join("\n")}`,
      status: "complete",
      meta: {
        kind: "question",
        questions,
        answers: result.answers,
        questionOutcome: result.outcome,
      },
    };
  } catch (error) {
    return questionError(
      `Question failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
