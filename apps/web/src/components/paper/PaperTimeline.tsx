import { AgentTimeline } from "../agent/AgentTimeline.js";

/** Paper sessions share the tool-run timeline; only the empty state differs. */
export function PaperTimeline() {
  return <AgentTimeline mode="paper" />;
}
