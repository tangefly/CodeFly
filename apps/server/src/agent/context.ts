import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentSession } from "@codefly/protocol";
import type { LlmChatMessage } from "../llm/client.js";
import { collectProjectInstructions } from "./project-instructions.js";

/**
 * Ephemeral context messages for one agent run: a runtime snapshot plus any
 * workspace project instructions. They sit between the stable system prompt
 * and the persisted history, are recomputed every run, and are never stored —
 * so the model always sees exactly one current snapshot per conversation and
 * the system prompt stays cache-friendly.
 */
export async function agentContextMessages(
  session: AgentSession,
  enabledTools: readonly string[],
): Promise<LlmChatMessage[]> {
  const messages: LlmChatMessage[] = [runtimeContextMessage(session, enabledTools)];
  const projectInstructions = await collectProjectInstructions(session.workspaceRoot);
  if (projectInstructions !== null) {
    messages.push({ role: "user", content: projectInstructions });
  }
  return messages;
}

function runtimeContextMessage(
  session: AgentSession,
  enabledTools: readonly string[],
): LlmChatMessage {
  const tools =
    enabledTools.length > 0 ? enabledTools.join(", ") : "(none — conversation only)";
  return {
    role: "user",
    content: `<runtime_context>
Current environment (refreshed every turn):
- Workspace root: ${session.workspaceRoot}
- Permission mode: ${session.mode}
- Approval policy: ${session.approvalPolicy}
- Enabled tools: ${tools}
</runtime_context>`,
  };
}
