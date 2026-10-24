#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAwaiting, shownFile, readJson, saveJson, COLLECT_BUDGET_MS } from './kim-awaiting.mjs';
import { DAY } from './lib/fleet-chase-policy.mjs';
import { isUnattendedRow } from './auto-progress-ledger.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export const REPEAT_MS = 3 * 3600_000;
export const SESSION_TTL = 30 * DAY;
export const DISPLAY_LIMIT = 5;
export function context(input, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), env = process.env, collect = collectAwaiting } = {}) {
  try {
    if (env.ORGIAST_AUTO_SESSION === '1' || env.CLAUDE_HEADLESS || isUnattendedRow(input, home)) return null;
    const event = input.hook_event_name || 'UserPromptSubmit';
    if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return null;
    const items = collect({ home, now, budgetMs: COLLECT_BUDGET_MS });
    const state = readJson(shownFile(home), {}), session = String(input.session_id || input.sessionId || 'unknown');
    for (const [key, value] of Object.entries(state)) if (now - value.at > SESSION_TTL) delete state[key];
    const ids = items.map(item => item.id).sort(), prior = Object.hasOwn(state, session) ? state[session] : null;
    if (event !== 'SessionStart' && prior && now - prior.at < REPEAT_MS && JSON.stringify(ids) === JSON.stringify(prior.ids)) return null;
    Object.defineProperty(state, session, { value: { at: now, ids }, enumerable: true, configurable: true, writable: true });
    saveJson(shownFile(home), state);
    if (!items.length) return null;
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/^\/mnt\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:/`);
    const visible = items.slice(0, DISPLAY_LIMIT).map(item => `・${item.title} ／ 答えてほしいこと: ${item.ask} ／ ${item.ageDays}日待ち`).join('\n');
    const routes = items.slice(0, DISPLAY_LIMIT).map(item => `id=${item.id} | ${item.title}`).join('\n');
    return { hookSpecificOutput: { hookEventName: event, additionalContext: `【必須・kim の返事待ち】応答の冒頭で user に見える形で、次の一覧をそのまま表示せよ。今回の依頼と無関係でも省略しない。\n📌 kim の返事待ち ${items.length} 件（古い順）\n${visible}${items.length > DISPLAY_LIMIT ? `\nほか ${items.length - DISPLAY_LIMIT} 件` : ''}\nkim がこのどれかに答えたら、その答えを本文ファイルに書いて node "${repo}/tools/kim-awaiting.mjs" --answer <id> --body-file <file> で届けよ。kim が「不要」と言ったものは --skip <id> --reason ...。以下の id は kim に見せない。\n${routes}` } };
  } catch { return null; }
}
if (isEntry(import.meta.url)) { try { const out = context(JSON.parse(await readStdinWithTimeout(500))); if (out) console.log(JSON.stringify(out)); } catch {} }
