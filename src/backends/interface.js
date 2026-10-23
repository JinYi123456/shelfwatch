/**
 * Reasoning backend contract (AGENTS.md section 4).
 * Sample mode swaps the backend, never the pipeline.
 *
 * @typedef {object} BackendContext
 * @property {import('../types/scenario.ts').Scenario} scenario
 * @property {object} logger
 * @property {number} autoActionFloor
 *
 * @typedef {object} ProposedMatch
 * @property {string} notice_id
 * @property {string} product_name
 * @property {string} entity_key
 * @property {number} confidence
 * @property {string[]} evidence
 * @property {string} [proposed_action]
 */

/**
 * @typedef {object} ReasoningBackend
 * @property {"llm"|"offline"} name
 * @property {(ctx: BackendContext) => Promise<ProposedMatch[]>} proposeMatches
 * @property {(ctx: BackendContext, match: ProposedMatch) => Promise<{ok:boolean, reason?:string, revised?:ProposedMatch}>} critique
 */

export {};
