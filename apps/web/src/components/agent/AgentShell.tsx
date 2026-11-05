import { AgentSettingsDialog } from "../AgentSettingsDialog.js";
import { AuditDrawer } from "../AuditDrawer.js";
import { LlmSettingsDialog } from "../LlmSettingsDialog.js";
import { SearchSettingsDialog } from "../SearchSettingsDialog.js";
import { SettingsDialog } from "../SettingsDialog.js";
import { AgentComposer } from "./AgentComposer.js";
import { AgentSidebar } from "./AgentSidebar.js";
import { AgentTimeline } from "./AgentTimeline.js";
import { AgentTopBar } from "./AgentTopBar.js";
import { NewSessionDialog } from "./NewSessionDialog.js";

/** The agent UI: workspace-bound sessions that can run tools. */
export function AgentShell() {
  return (
    <>
      <AgentSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AgentTopBar />
        <main className="min-h-0 flex-1">
          <AgentTimeline />
        </main>
        <AgentComposer />
      </div>

      <NewSessionDialog />
      <SettingsDialog />
      <LlmSettingsDialog />
      <SearchSettingsDialog />
      <AgentSettingsDialog />
      <AuditDrawer />
    </>
  );
}
