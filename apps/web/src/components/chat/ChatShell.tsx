import { LlmSettingsDialog } from "../LlmSettingsDialog.js";
import { ChatComposer } from "./ChatComposer.js";
import { ChatConversation } from "./ChatConversation.js";
import { ChatSidebar } from "./ChatSidebar.js";
import { ChatTopBar } from "./ChatTopBar.js";

/** The chat UI: workspace-free conversations with the model. */
export function ChatShell() {
  return (
    <>
      <ChatSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatTopBar />
        <main className="min-h-0 flex-1">
          <ChatConversation />
        </main>
        <ChatComposer />
      </div>

      <LlmSettingsDialog />
    </>
  );
}
