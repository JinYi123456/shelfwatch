/** Run output — morning pull list and escalations. */

export type ReasoningBackend = "llm" | "offline";

export type PullAction = "pull" | "hold" | "monitor" | "escalate";

export type ActionStatus = "auto_action" | "escalated" | "rejected";

export interface PullListItem {
  action_id: string;
  product_name: string;
  action: PullAction;
  confidence: number;
  status: ActionStatus;
  evidence: string[];
  what_would_change?: string;
}

export interface Escalation {
  action_id: string;
  reason: string;
  confidence: number;
}

export interface RunStats {
  notices_in: number;
  actions_out: number;
  escalation_count: number;
  rejection_count: number;
  revision_count: number;
  memory_hits: number;
}

export interface RunResult {
  run_id: string;
  scenario_id: string;
  started_at: string;
  finished_at: string;
  reasoning_backend: ReasoningBackend;
  sample_mode: boolean;
  pull_list: PullListItem[];
  escalations: Escalation[];
  stats: RunStats;
  log_path: string;
}
