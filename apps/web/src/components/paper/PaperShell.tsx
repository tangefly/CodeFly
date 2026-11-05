import { AgentSettingsDialog } from "../AgentSettingsDialog.js";
import { AuditDrawer } from "../AuditDrawer.js";
import { LlmSettingsDialog } from "../LlmSettingsDialog.js";
import { SearchSettingsDialog } from "../SearchSettingsDialog.js";
import { SettingsDialog } from "../SettingsDialog.js";
import { PaperComposer } from "./PaperComposer.js";
import { PaperLibraryDrawer } from "./PaperLibraryDrawer.js";
import { PaperSidebar } from "./PaperSidebar.js";
import { PaperTimeline } from "./PaperTimeline.js";
import { PaperTopBar } from "./PaperTopBar.js";

/** The paper assistant UI: global library, arXiv search and PDF reading. */
export function PaperShell() {
  return (
    <>
      <PaperSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <PaperTopBar />
        <main className="min-h-0 flex-1">
          <PaperTimeline />
        </main>
        <PaperComposer />
      </div>

      <PaperLibraryDrawer />
      <SettingsDialog />
      <LlmSettingsDialog />
      <SearchSettingsDialog />
      <AgentSettingsDialog />
      <AuditDrawer />
    </>
  );
}
