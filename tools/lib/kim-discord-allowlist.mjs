// 2026-11-06: kim 宛 DM は全廃。古いローカル許可リストも例外にならない。
export function loadAllowlist() { return []; }
export function discordAllowed() { return { allowed: false, category: null }; }
