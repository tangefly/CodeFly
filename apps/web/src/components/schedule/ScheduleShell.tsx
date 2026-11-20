import { AgentSettingsDialog } from "../AgentSettingsDialog.js";
import { AuditDrawer } from "../AuditDrawer.js";
import { LlmSettingsDialog } from "../LlmSettingsDialog.js";
import { QuestionPrompt } from "../QuestionPrompt.js";
import { SearchSettingsDialog } from "../SearchSettingsDialog.js";
import { SettingsDialog } from "../SettingsDialog.js";
import { ScheduleComposer } from "./ScheduleComposer.js";
import { ScheduleEmailSettingsDialog } from "./ScheduleEmailSettingsDialog.js";
import { SchedulePanel } from "./SchedulePanel.js";
import { ScheduleSidebar } from "./ScheduleSidebar.js";
import { ScheduleTimeline } from "./ScheduleTimeline.js";
import { ScheduleTopBar } from "./ScheduleTopBar.js";

/** The schedule assistant UI: memory, weekly plan and PNG/email export. */
export function ScheduleShell() {
  return (
    <>
      <ScheduleSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ScheduleTopBar />
        <main className="min-h-0 flex-1">
          <ScheduleTimeline />
        </main>
        <QuestionPrompt />
        <ScheduleComposer />
      </div>

      <SchedulePanel />
      <ScheduleEmailSettingsDialog />
      <SettingsDialog />
      <LlmSettingsDialog />
      <SearchSettingsDialog />
      <AgentSettingsDialog />
      <AuditDrawer />
    </>
  );
}
