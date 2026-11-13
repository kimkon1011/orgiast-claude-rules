// Lightweight chase policy shared with the session hook (no mail transport imports).
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
// fleet-mail mailCategory: decision=0, task=1. Kept compatible by tests.
export const CATEGORY = Object.freeze({ decision: 0, task: 1 });
export const active = item => ['open', 'waiting', 'blocked'].includes(item.status);
