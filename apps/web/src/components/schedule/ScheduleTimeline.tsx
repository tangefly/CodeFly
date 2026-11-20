import { AgentTimeline } from "../agent/AgentTimeline.js";

/** Schedule sessions share the tool-run timeline; only the empty state differs. */
export function ScheduleTimeline() {
  return <AgentTimeline mode="schedule" />;
}
