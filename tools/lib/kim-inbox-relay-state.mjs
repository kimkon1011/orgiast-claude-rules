import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isUnattendedSession } from './unattended-session.mjs';
import { displayPcNames } from './pc-display.mjs';

export const revisionOf = item => createHash('sha256').update(JSON.stringify([item.kind, item.text, item.revision, item.progressVersion])).digest('hex');
export const jstDay = now => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
export function inboxSummary(item) {
  const lines = String(item.text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  // Registration URLs are actions, not optional detail; never truncate their signed token.
  if (item.source === 'knowledge-lock-passkey-link' && lines.some(line => /^登録リンク: https:\/\//.test(line))) return lines.join(' ');
  const heading = lines.filter(line => !/^(作業ID:|成果物:|自動起票:|原因:|対処:|\d+[.．、)）])/.test(line)).join(' ').slice(0, 140);
  const action = lines.slice(1).find(s => /承認待ち|kim.*(?:判断|承認|操作)|登録リンク/.test(s));
  return (heading + (action && !heading.includes(action) ? ` / ${action.slice(0, 90)}` : '')).replace(/\s+/g, ' ').trim();
}
export function relayDue(item, sessionId, now = Date.now()) {
  const delivery = item.deliveredToKim;
  if (!delivery || delivery.revision !== revisionOf(item)) return true;
  if (item.kind === 'ask') return delivery.sessions?.[sessionId]?.day !== jstDay(now);
  return item.kind !== 'info';
}
const withoutEmoji = text => text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').trim();
const metadataLine = /^(?:【[^】]*】\s*(?:プロジェクト|セッションの目的)|プロジェクト|作業ID|セッションの目的)[:：]/;
// Deterministic extraction: only happened is shortened; actions and URLs stay intact.
export function inboxBrief(item, options = {}) {
  const text = String(item.text || '');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines.find(line => metadataLine.test(line));
  const purpose = header?.match(/セッションの目的[:：]\s*(.*?)(?:\s*／\s*(?:作業ID|プロジェクト)[:：]|$)/)?.[1].trim();
  const pc = String(item.from || '').split('・')[0].trim();
  const displayPc = displayPcNames((pc && !pc.includes('@') ? pc : header?.match(/^【([^・】]+)/)?.[1]) || '', options);
  const meaning = lines.map(withoutEmoji).find(line => line && !metadataLine.test(line) && !/^https?:\/\//.test(line)) || '';
  let topic = purpose || (header ? meaning : lines[0]) || '件名なし';
  if (displayPc && !topic.startsWith(displayPc)) topic = `${displayPc}: ${topic}`;
  const happened = Array.from(meaning).slice(0, 120).join('');
  const unspecified = `返事内容の指定なし（原文確認: node tools/kim-inbox.mjs --show ${item.id}）`;
  const actions = lines.map(withoutEmoji);
  const action = actions.find(line => /^(?:あなたの返事待ち|答えてほしいこと|判断してほしいこと|あなたの作業待ち|kim がすること)[:：]/.test(line))
    || actions.find(line => /^(?:kim の)?承認待ち/.test(line))
    || actions.find(line => /^約束[:：]/.test(line));
  const resumeFailed = item.source === 'auto-progress-resume-failed';
  const decide = resumeFailed ? '自動再開が止まっている。続けるか中止するか'
    : item.kind === 'info' ? '判断不要（報告のみ）'
    : action ? action.replace(/^(?:あなたの返事待ち|答えてほしいこと|判断してほしいこと|あなたの作業待ち|kim がすること|承認待ち|約束)[:：]\s*/, '') || unspecified
    : unspecified;
  const reply = item.kind === 'deadline' ? `${item.key || 'D-003'} 完了／延期 11/20／不要`
    : resumeFailed ? 'N 続けて／N 中止'
    : item.kind === 'info' ? '返事不要' : 'N 可／N 不要／N <指示>';
  // Keep authuser and signed registration tokens, including long passkey URLs.
  const links = [...text.matchAll(/https?:\/\/[^\s<>「」『』【】（）]+/g)].map(match => match[0]);
  return { topic, happened, decide, reply, links };
}
export function formatInboxBrief(item, n = 'N', options = {}) {
  const brief = inboxBrief(item, options);
  const reply = brief.reply.replace(/\bN(?= )/g, String(n));
  let result = `${n}. ${brief.topic}（${item.id}）\n   起きたこと: ${brief.happened}\n   判断してほしいこと: ${brief.decide}\n   返事の例: ${reply}`;
  for (const link of brief.links) {
    result += `\n   開く: ${link}`;
  }
  return result;
}

export function interactiveInboxSession(input, { home, env = process.env, raw = '' } = {}) {
  if (input.agent_id || input.isSidechain || /(?:^|[\\/])subagents[\\/]/.test(input.transcript_path || '')) return false;
  if (isUnattendedSession({ ...input, entrypoint: input.entrypoint || input.entryPoint || env.CLAUDE_CODE_ENTRYPOINT }, { home, env })) return false;
  // Transcript metadata covers plain `claude -p` without the scheduler env flags.
  const entries = raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const entrypoint = entries.filter(e => e.isSidechain !== true && (e.entrypoint || e.entryPoint)).at(-1);
  return !['sdk-cli', 'sdk-ide'].includes(entrypoint?.entrypoint || entrypoint?.entryPoint);
}
const stateFile = (home, sessionId) => path.join(home, '.claude/kim-inbox-relay', createHash('sha256').update(sessionId).digest('hex') + '.json');
export function readRelayState(home, sessionId) {
  try { return JSON.parse(fs.readFileSync(stateFile(home, sessionId), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export function writeRelayState(home, sessionId, state) {
  if (!sessionId) return;
  const file = stateFile(home, sessionId), temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function recordInjection(home, sessionId, items, { event, now = Date.now() } = {}) {
  if (!sessionId) return;
  const state = readRelayState(home, sessionId);
  writeRelayState(home, sessionId, { ...state, sessionId, event, injectedAt: new Date(now).toISOString(),
    pending: items.map((item, n) => ({ id: item.id, revision: revisionOf(item), summary: formatInboxBrief(item, n + 1, { home }).split('\n')[0] })) });
}
// Only complete answer-only lines can act as replies. Never scrape quoted tool output,
// general prose or an answer from a different session. Ambiguous multi-choice asks stay open.
export function recordPromptAnswers(home, sessionId, prompt, { listItems, answerItem }) {
  if (!sessionId) return [];
  const state = readRelayState(home, sessionId), delivered = state.lastDelivered || [];
  const lines = prompt.trim().split(/\r?\n/);
  const matches = lines.map(line => line.trim().match(/^(ki-\d{14}-[a-f0-9]{4}|[1-9]\d*)\s*[:：、.．]?\s+(可|不可|承認|否認|はい|いいえ|不要|完了|OK|保留)[。.!！]?$/i));
  if (!matches.length || matches.some(m => !m)) return [];
  const items = listItems(home), answers = [];
  for (const match of matches) {
    const receipt = delivered.find(d => match[1] === d.id || match[1] === String(d.number));
    const item = items.find(i => i.id === receipt?.id && i.kind === 'ask' && i.status === 'open' && revisionOf(i) === receipt.revision);
    if (!item || match[2] === '保留') continue;
    if (!match[1].startsWith('ki-') && (item.text.match(/^\s*\d+[.．、)）]/gm) || []).length > 1) continue;
    answers.push(answerItem(home, item.id, match[2], sessionId));
  }
  return answers;
}
