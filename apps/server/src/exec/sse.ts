export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** One SSE message with a monotonically increasing per-stream id. */
export function sseFrame(id: string, data: unknown): string {
  return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE comment, used as a keep-alive heartbeat. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}
