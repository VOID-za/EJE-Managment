/**
 * The PostgreSQL schema, split by domain area.
 *
 * Split rather than one file because the areas are genuinely independent: the
 * checklist tables and the chat tables share nothing, and a single file of two
 * thousand lines is a file nobody reads before changing.
 *
 * NO DOMAIN LOGIC LIVES HERE. These are table definitions and the constraints
 * that make an impossible row impossible. Every business rule — which
 * transitions are legal, who may capture work, when a refusal blocks issue —
 * stays in `src/domain` and `src/application`, which remain the source of truth
 * for behaviour.
 */
export * from './enums';
export * from './columns';
export * from './identity';
export * from './settings';
export * from './customers';
export * from './machines';
export * from './jobs';
export * from './signatures';
export * from './pricing';
export * from './checklists';
export * from './documents';
export * from './availability';
export * from './collaboration';
export * from './library';
export * from './audit';
