#!/usr/bin/env node
import os from 'node:os';
import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAwaiting, shownFile, readJson, saveJson, ageLabel, COLLECT_BUDGET_MS } from './kim-awaiting.mjs';
import { readManualLedger, findManualWaiting } from './outbound-reply-chase.mjs';
import { DAY } from './lib/fleet-chase-policy.mjs';
import { isUnattendedRow } from './auto-progress-ledger.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export const REPEAT_MS = 3 * 3600_000;
export const SESSION_TTL = 30 * DAY;
export const DISPLAY_LIMIT = 5;
export const EXTERNAL_LIMIT = 15;
export const TOP = 3;
// Separate state: the existing three-hour kim reminder must not suppress Discord work.
export function discordWaitingContext({ home, now }) {
  let lock;
  try {
    const entries = findManualWaiting(readManualLedger(path.join(home, '.claude', 'reply-waiting.json')).entries, { now, staleDays: 2 })
      .filter(row => row.channel === 'Discord' && /^\d+$/.test(row.discord?.channelId || '') && /^\d+$/.test(row.discord?.messageId || ''));
    if (!entries.length) return '';
    const file = path.join(home, '.claude', 'discord-reply-waiting-shown.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const candidate = `${file}.lock`;
    try { if (Date.now() - statSync(candidate).mtimeMs > 300_000) rmdirSync(candidate); } catch {}
    mkdirSync(candidate);
    lock = candidate;
    const prior = readJson(file, {});
    if (Number.isFinite(prior.at) && now - prior.at < DAY) return '';
    const clean = value => String(value).replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
    const rows = entries.map(row => `${clean(row.who)} ${clean(row.subject)}（${row.elapsedDays}日）。mcp__claude_ai_Discord__list_messages channel_id=${row.discord.channelId} after=${row.discord.messageId} で返信を確認し、返信があれば内容を処理して \`node tools/outbound-reply-chase.mjs --done ${row.id}\`、無ければ相手に1回だけ催促（kim 同席の文面）して user に1行報告せよ。`).join('\n');
    saveJson(file, { at: now });
    return `【必須】Discord 返事待ち ${entries.length} 件: ${rows}\n`;
  } catch { return ''; }
  finally { if (lock) { try { rmdirSync(lock); } catch {} } }
}
export function context(input, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), env = process.env, collect = collectAwaiting } = {}) {
  try {
    if (env.ORGIAST_AUTO_SESSION === '1' || env.CLAUDE_HEADLESS || isUnattendedRow(input, home)) return null;
    const event = input.hook_event_name || 'UserPromptSubmit';
    if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return null;
    const sessionId = String(input.session_id || input.sessionId || '');
    const items = collect({ home, now, budgetMs: COLLECT_BUDGET_MS, sessionId });
    const discord = discordWaitingContext({ home, now });
    const discordOnly = () => discord ? { hookSpecificOutput: { hookEventName: event, additionalContext: discord } } : null;
    const state = readJson(shownFile(home), {}), session = sessionId || 'unknown';
    for (const [key, value] of Object.entries(state)) if (now - value.at > SESSION_TTL) delete state[key];
    const ids = items.map(item => item.id).sort(), prior = Object.hasOwn(state, session) ? state[session] : null;
    if (event !== 'SessionStart' && prior && now - prior.at < REPEAT_MS && JSON.stringify(ids) === JSON.stringify(prior.ids)) return discordOnly();
    Object.defineProperty(state, session, { value: { at: now, ids }, enumerable: true, configurable: true, writable: true });
    saveJson(shownFile(home), state);
    if (!items.length) return discordOnly();
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/^\/mnt\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:/`);
    // 2026-11-15 kim 指示: 注入を圧縮（件数＋上位3件の1行要約・各100字以内）
    // 答えてほしいこと（質問文）は必ず残す。100字に収めるため title/age/progress を先に削る
    const briefLine = item => {
      const askPart = `答えてほしいこと: ${item.ask}`;
      const suffixParts = [ageLabel(item), item.progress].filter(Boolean);
      const suffix = suffixParts.length ? ` ／ ${suffixParts.join(' ／ ')}` : '';
      const head = `・${item.title}`;
      let line = `${head} ／ ${askPart}${suffix}`;
      if ([...line].length <= 100) return line;
      // 100字超: title から削り、足りなければ ask 末尾を落とす
      const suffixLen = [...suffix].length;
      const reserved = 100 - suffixLen;
      const askBudget = Math.min([...` ／ ${askPart}`].length, Math.max(40, reserved - 3));
      const titleBudget = Math.max(3, reserved - askBudget);
      const briefTitle = [...head].slice(0, titleBudget).join('');
      const surplus = 100 - suffixLen;
      let core = [...`${briefTitle} ／ ${askPart}`].slice(0, surplus).join('');
      return `${core}${suffix}`;
    };
    const TOP = 3;
    const external = items.filter(item => item.external), internal = items.filter(item => !item.external);
    const isCurrent = item => sessionId && item.source === 'auto-progress' && item.route?.sessionId === sessionId;
    const current = internal.filter(isCurrent);
    const shownExternal = external.slice(0, TOP);
    const shownInternal = [...current, ...internal.filter(item => !isCurrent(item)).slice(0, TOP)];
    const waiting = external.filter(item => !item.warning).length;
    const listCmd = `node "${repo}/tools/kim-awaiting.mjs" --list`;
    const externalBlock = external.length ? `🔴 社外の人を待たせています ${waiting} 件（古い順）\n${shownExternal.map(briefLine).join('\n')}${external.length > TOP ? `\nほか ${external.length - TOP} 件` : ''}\n` : '';
    const internalBlock = internal.length ? `📌 kim の返事待ち ${internal.length} 件（${current.length ? '現セッション優先・ほかは古い順' : '古い順'}）\n${shownInternal.map(briefLine).join('\n')}${internal.length > shownInternal.length ? `\nほか ${internal.length - shownInternal.length} 件` : ''}\n` : '';
    const routes = [...shownExternal, ...shownInternal].map(item => `id=${item.id} | ${item.title}`).join('\n');
    const redInstruction = external.length ? '🔴 の項目は本文を get_thread で読み、返信下書きまで作って提示せよ。送信は kim が明示した時だけ。\n' : '';
    const helpNote = `全件確認: ${listCmd} ／ 回答: node "${repo}/tools/kim-awaiting.mjs" --answer <id> --body-file <file> ／ 不要: --skip <id>\n`;
    return { hookSpecificOutput: { hookEventName: event, additionalContext: `${discord}【kim の返事待ち】${helpNote}${externalBlock}${internalBlock}${redInstruction}以下の id は kim に見せない。\n${routes}` } };
  } catch { return null; }
}
if (isEntry(import.meta.url)) { try { const out = context(JSON.parse(await readStdinWithTimeout(500))); if (out) console.log(JSON.stringify(out)); } catch {} }
