import { createParser } from "eventsource-parser";
import { ApiError, getToken } from "./api.js";

export interface StreamSseOptions<T> {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  onEvent: (event: T) => void;
}

/**
 * Consumes an SSE response with fetch + ReadableStream. EventSource cannot
 * POST, and we need the Authorization header anyway.
 */
export async function streamSse<T>(options: StreamSseOptions<T>): Promise<void> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(options.url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "HTTP_ERROR",
      payload?.error?.message ?? response.statusText,
    );
  }
  if (!response.body) throw new Error("response has no body");

  const parser = createParser({
    onEvent(message) {
      if (!message.data) return;
      try {
        options.onEvent(JSON.parse(message.data) as T);
      } catch (error) {
        console.error("[sse] failed to parse event", error, message.data);
      }
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
