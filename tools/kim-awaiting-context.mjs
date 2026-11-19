#!/usr/bin/env node
import os from 'node:os';
import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAwaiting, readJson, saveJson, ageLabel, COLLECT_BUDGET_MS } from './kim-awaiting.mjs';
import { readManualLedger, findManualWaiting } from './outbound-reply-chase.mjs';
import { DAY } from './lib/fleet-chase-policy.mjs';
import { isUnattendedRow } from './auto-progress-ledger.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
import { FINAL_ONLY_INSTRUCTION, selectNew, isLoopWake } from './lib/inbox-display-policy.mjs';
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
    // kim 回答済みの項目は質問として注入しない（2026-11-19）。
    const items = collect({ home, now, budgetMs: COLLECT_BUDGET_MS, sessionId }).filter(item => !item.answered);
    const discord = discordWaitingContext({ home, now });
    const discordOnly = () => discord ? { hookSpecificOutput: { hookEventName: event, additionalContext: discord } } : null;
    // loop 起床は discord 以外何も注入しない
    if (isLoopWake(input, { home, now, hook: 'kim-awaiting-context' })) return discordOnly();
    const allIds = items.map(item => item.id);
    // 新着選別
    const { fresh, known, knownFromOtherSessions } = selectNew({ home, hook: 'kim-awaiting', sessionId, ids: allIds, now });
    const freshSet = new Set(fresh);
    const freshItems = items.filter(item => freshSet.has(item.id));
    if (!freshItems.length) {
      if (!knownFromOtherSessions) return discordOnly();
      const additionalContext = `${discord}${FINAL_ONLY_INSTRUCTION}\nほか既出 ${knownFromOtherSessions} 件`;
      return { hookSpecificOutput: { hookEventName: event, additionalContext } };
    }
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/^\/mnt\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:/`);
    const briefLine = item => {
      const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
      const askPart = ` ／ 答えてほしいこと: ${oneLine(item.ask)}`;
      const suffixParts = [ageLabel(item), item.progress].map(oneLine).filter(Boolean);
      const suffix = suffixParts.length ? ` ／ ${suffixParts.join(' ／ ')}` : '';
      const head = `・${oneLine(item.title)}`;
      const askLength = [...askPart].length;
      const headLength = Math.min([...head].length, Math.max(3, 100 - askLength));
      const core = [...head].slice(0, headLength).join('') + askPart + suffix;
      return [...core].slice(0, 100).join('');
    };
    const external = freshItems.filter(item => item.external), internal = freshItems.filter(item => !item.external);
    const isCurrent = item => sessionId && item.source === 'auto-progress' && item.route?.sessionId === sessionId;
    const current = internal.filter(isCurrent);
    const shownExternal = external.slice(0, TOP);
    const shownInternal = [...current, ...internal.filter(item => !isCurrent(item))].slice(0, TOP);
    const waiting = external.filter(item => !item.warning).length;
    const externalBlock = external.length ? `🔴 社外の人を待たせています ${waiting} 件（古い順）\n${shownExternal.map(briefLine).join('\n')}${external.length > TOP ? `\nほか ${external.length - TOP} 件` : ''}\n` : '';
    const internalBlock = internal.length ? `📌 kim の返事待ち ${internal.length} 件（${current.length ? '現セッション優先・ほかは古い順' : '古い順'}）\n${shownInternal.map(briefLine).join('\n')}${internal.length > shownInternal.length ? `\nほか ${internal.length - shownInternal.length} 件` : ''}\n` : '';
    const routes = [...shownExternal, ...shownInternal].map(item => `id=${item.id} | ${item.title}`).join('\n');
    const redInstruction = external.length ? '🔴 の項目は本文を get_thread で読み、返信下書きまで作って提示せよ。送信は kim が明示した時だけ。\n' : '';
    const knownLine = known > 0 ? `\nほか既出 ${known} 件（一覧は node tools/kim-awaiting.mjs で表示）\n` : '';
    return { hookSpecificOutput: { hookEventName: event, additionalContext: `${discord}${FINAL_ONLY_INSTRUCTION}\n${externalBlock}${internalBlock}${knownLine}${redInstruction}kim がこのどれかに答えたら、その答えを本文ファイルに書いて node "${repo}/tools/kim-awaiting.mjs" --answer <id> --body-file <file> で届けよ。kim が「不要」と言ったものは --skip <id> --reason ...。以下の id は kim に見せない。\n${routes}` } };
  } catch { return null; }
}
if (isEntry(import.meta.url)) { try { const out = context(JSON.parse(await readStdinWithTimeout(500))); if (out) console.log(JSON.stringify(out)); } catch {} }
