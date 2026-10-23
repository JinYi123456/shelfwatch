/** Scenario input — overnight shift triage case. */

export type NoticeSource =
  | "fda_enforcement"
  | "fda_adverse_event"
  | "second_agency"
  | "open_food_facts"
  | "donation_ledger";

export type RecallClass = "I" | "II" | "III" | "unknown";

export interface Notice {
  notice_id: string;
  source: NoticeSource;
  product_name: string;
  brand?: string;
  lot?: string;
  class?: RecallClass;
  raw_text?: string;
  barcode?: string;
  distribution?: string;
}

export interface MemoryHit {
  entity_key: string;
  mapped_name: string;
  trust?: number;
}

export interface Scenario {
  scenario_id: string;
  shift_date: string;
  duty_officer?: string;
  auto_action_floor?: number;
  notices: Notice[];
  prior_memory_hits?: MemoryHit[];
}
