import type { FastifyInstance } from "fastify";
import {
  chatSchema,
  llmSettingsUpdateSchema,
  llmTestSchema,
  type ChatEvent,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import { SSE_HEADERS, sseComment, sseFrame } from "../exec/sse.js";
import type { LlmConfigStore } from "../llm/config-store.js";
import type { MessageStore } from "../llm/messages.js";
import type { ChatService } from "../llm/service.js";
import type { SessionStore } from "../session/store.js";

export interface LlmRouteDeps {
  sessions: SessionStore;
  messages: MessageStore;
  llmConfig: LlmConfigStore;
  chat: ChatService;
  audit: AuditLog;
}

const CHAT_HEARTBEAT_MS = 15_000;

export function registerLlmRoutes(app: FastifyInstance, deps: LlmRouteDeps): void {
  app.get("/api/llm/settings", async () => {
    return { settings: deps.llmConfig.getPublic() };
  });

  app.put("/api/llm/settings", async (request) => {
    const body = llmSettingsUpdateSchema.parse(request.body);
    const before = deps.llmConfig.getPublic();
    const settings = await deps.llmConfig.update(body);

    await deps.audit.append({
      type: "llm.config.changed",
      baseUrl: settings.baseUrl,
      model: settings.model,
      thinking: settings.thinking,
      reasoningEffort: settings.reasoningEffort,
      hasApiKey: settings.hasApiKey,
      apiKeyChanged:
        before.hasApiKey !== settings.hasApiKey ||
        body.clearApiKey === true ||
        (body.apiKey !== undefined && body.apiKey.trim() !== ""),
    });

    return { settings };
  });

  app.post("/api/llm/test", async (request) => {
    const body = llmTestSchema.parse(request.body ?? {});
    return deps.chat.test(body);
  });

  app.get("/api/sessions/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    deps.sessions.getOrThrow(id);
    return { messages: deps.messages.list(id) };
  });

  app.post("/api/sessions/:id/chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = deps.sessions.getOrThrow(id);
    const body = chatSchema.parse(request.body);
    // Fail before hijacking so configuration/lock errors still use the
    // normal JSON error shape.
    deps.chat.assertReady(id);

    reply.hijack();
    reply.raw.writeHead(200, SSE_HEADERS);
    reply.raw.setTimeout(0);

    let seq = 0;
    let finished = false;
    const abort = new AbortController();

    const write = (chunk: string): void => {
      if (finished || reply.raw.writableEnded) return;
      try {
        reply.raw.write(chunk);
      } catch {
        // Client went away; the close handler aborts the upstream request.
      }
    };

    const emit = (event: ChatEvent): void => {
      seq += 1;
      write(sseFrame(String(seq), event));
    };

    const heartbeat = setInterval(() => {
      write(sseComment("ping"));
    }, CHAT_HEARTBEAT_MS);
    heartbeat.unref?.();

    const onClose = (): void => {
      if (!finished) abort.abort();
    };
    reply.raw.on("close", onClose);

    try {
      if (!abort.signal.aborted) {
        await deps.chat.chat(session, body.message, abort.signal, emit);
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      emit({
        type: "chat.error",
        messageId: "",
        code: appError?.code ?? "CHAT_ERROR",
        message:
          appError?.message ??
          (error instanceof Error ? error.message : String(error)),
      });
    } finally {
      finished = true;
      clearInterval(heartbeat);
      reply.raw.removeListener("close", onClose);
      if (!reply.raw.writableEnded) {
        try {
          reply.raw.end();
        } catch {
          // Socket already closed.
        }
      }
    }

    return reply;
  });
}
