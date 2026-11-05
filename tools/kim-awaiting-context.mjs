#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAwaiting, shownFile, readJson, saveJson, ageLabel, COLLECT_BUDGET_MS } from './kim-awaiting.mjs';
import { DAY } from './lib/fleet-chase-policy.mjs';
import { isUnattendedRow } from './auto-progress-ledger.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export const REPEAT_MS = 3 * 3600_000;
export const SESSION_TTL = 30 * DAY;
export const DISPLAY_LIMIT = 5;
export const EXTERNAL_LIMIT = 15;
export function context(input, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), env = process.env, collect = collectAwaiting } = {}) {
  try {
    if (env.ORGIAST_AUTO_SESSION === '1' || env.CLAUDE_HEADLESS || isUnattendedRow(input, home)) return null;
    const event = input.hook_event_name || 'UserPromptSubmit';
    if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return null;
    const sessionId = String(input.session_id || input.sessionId || '');
    const items = collect({ home, now, budgetMs: COLLECT_BUDGET_MS, sessionId });
    const state = readJson(shownFile(home), {}), session = sessionId || 'unknown';
    for (const [key, value] of Object.entries(state)) if (now - value.at > SESSION_TTL) delete state[key];
    const ids = items.map(item => item.id).sort(), prior = Object.hasOwn(state, session) ? state[session] : null;
    if (event !== 'SessionStart' && prior && now - prior.at < REPEAT_MS && JSON.stringify(ids) === JSON.stringify(prior.ids)) return null;
    Object.defineProperty(state, session, { value: { at: now, ids }, enumerable: true, configurable: true, writable: true });
    saveJson(shownFile(home), state);
    if (!items.length) return null;
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/^\/mnt\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:/`);
    const line = item => `・${item.title} ／ 答えてほしいこと: ${item.ask} ／ ${ageLabel(item)}${item.progress ? ` ／ ${item.progress}` : ''}`;
    const external = items.filter(item => item.external), internal = items.filter(item => !item.external);
    const isCurrent = item => sessionId && item.source === 'auto-progress' && item.route?.sessionId === sessionId;
    const current = internal.filter(isCurrent);
    const shownExternal = external.slice(0, EXTERNAL_LIMIT);
    const shownInternal = [...current, ...internal.filter(item => !isCurrent(item)).slice(0, DISPLAY_LIMIT)];
    const waiting = external.filter(item => !item.warning).length;
    const externalBlock = external.length ? `🔴 社外の人を待たせています ${waiting} 件（古い順）\n${shownExternal.map(line).join('\n')}${external.length > EXTERNAL_LIMIT ? `\nほか ${external.length - EXTERNAL_LIMIT} 件` : ''}\n` : '';
    const internalBlock = internal.length ? `📌 kim の返事待ち ${internal.length} 件（${current.length ? '現セッション優先・ほかは古い順' : '古い順'}）\n${shownInternal.map(line).join('\n')}${internal.length > shownInternal.length ? `\nほか ${internal.length - shownInternal.length} 件` : ''}\n` : '';
    const routes = [...shownExternal, ...shownInternal].map(item => `id=${item.id} | ${item.title}`).join('\n');
    const redInstruction = external.length ? '🔴 の項目は、本文を get_thread で読み、返信下書きまで作って kim に提示せよ。送信は kim が『送って』と明示した時だけ。\n' : '';
    return { hookSpecificOutput: { hookEventName: event, additionalContext: `【必須・kim の返事待ち】応答の冒頭で user に見える形で、次の一覧をそのまま表示せよ。今回の依頼と無関係でも省略しない。\n${externalBlock}${internalBlock}${redInstruction}kim がこのどれかに答えたら、その答えを本文ファイルに書いて node "${repo}/tools/kim-awaiting.mjs" --answer <id> --body-file <file> で届けよ。kim が「不要」と言ったものは --skip <id> --reason ...。以下の id は kim に見せない。\n${routes}` } };
  } catch { return null; }
}
if (isEntry(import.meta.url)) { try { const out = context(JSON.parse(await readStdinWithTimeout(500))); if (out) console.log(JSON.stringify(out)); } catch {} }
