#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"goal-pace-gate","remedies":[{"kind":"repo-file","ref":"docs/case-goals.md"}]};
// Tools entry point preserves the common registrar/contract discovery layout.
import { isEntry } from './is-entry.mjs';
import { main } from '../hooks/goal-pace-gate.mjs';
export { judge } from '../hooks/goal-pace-gate.mjs';
if (isEntry(import.meta.url)) await main();
