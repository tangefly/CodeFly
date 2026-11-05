import { useMemo } from "react";
import type { ChatMessage } from "../lib/store.js";
import {
  computeConversationSize,
  computeSessionUsage,
  formatSpeed,
  formatTokens,
} from "../lib/token-stats.js";

/** Token usage summary shared by the chat and agent composers. */
export function UsageBar({ messages }: { messages: ChatMessage[] }) {
  const sessionUsage = useMemo(
    () => computeSessionUsage(messages),
    [messages],
  );
  const conversationSize = useMemo(
    () => computeConversationSize(messages),
    [messages],
  );

  if (!sessionUsage) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 font-mono text-[10px] text-muted-foreground/55">
      <span className="font-sans text-muted-foreground/45">本会话用量</span>
      {conversationSize.messages > 0 ? (
        <span
          className="text-foreground/70"
          title={`当前会话 ${conversationSize.messages} 条消息，共 ${conversationSize.chars} 字符；tokens 按字符数估算，仅供参考`}
        >
          会话上下文 {conversationSize.messages} 条消息 · ≈
          {formatTokens(conversationSize.tokens)} tok
        </span>
      ) : null}
      {sessionUsage.promptTokens > 0 ? (
        <span
          title={`${sessionUsage.promptTokens} prompt tokens（本会话所有请求的上下文之和，包含缓存命中）`}
        >
          累积上下文 {formatTokens(sessionUsage.promptTokens)} tok
        </span>
      ) : null}
      {sessionUsage.completionTokens > 0 ? (
        <span title={`${sessionUsage.completionTokens} completion tokens（本会话累计）`}>
          累计输出 {formatTokens(sessionUsage.completionTokens)} tok
        </span>
      ) : null}
      {sessionUsage.reasoningTokens > 0 ? (
        <span title={`${sessionUsage.reasoningTokens} reasoning tokens（已计入输出）`}>
          思考 {formatTokens(sessionUsage.reasoningTokens)} tok
        </span>
      ) : null}
      {sessionUsage.promptTokens === 0 &&
      sessionUsage.completionTokens === 0 &&
      sessionUsage.totalTokens > 0 ? (
        <span title={`${sessionUsage.totalTokens} total tokens`}>
          合计 {formatTokens(sessionUsage.totalTokens)} tok
        </span>
      ) : null}
      {sessionUsage.speed !== null ? (
        <span title="按已上报用量的生成阶段耗时加权计算">
          {formatSpeed(sessionUsage.speed)} tok/s
        </span>
      ) : null}
      {sessionUsage.cacheHitRate !== null ? (
        <span title={`${sessionUsage.cachedTokens} cached prompt tokens`}>
          缓存命中 {Math.round(sessionUsage.cacheHitRate * 100)}%
        </span>
      ) : null}
    </div>
  );
}
