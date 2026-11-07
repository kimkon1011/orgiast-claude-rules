#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"past-log-search-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"past-log-search-gate"}]};
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { classifyHandoff } from './lib/handoff-kind.mjs';
import { isPastLogSearchToolUse } from './lib/user-facing.mjs';
import { isHumanEntry, transcriptEntries } from './lib/human-turn.mjs';
export { classifyHandoff } from './lib/handoff-kind.mjs';
const KNOWN_APPS = 'MacroDroid,Tasker,LINE,WeChat,Messenger,Facebook,Instagram,X,Discord,Slack,GitHub,Vercel,Supabase,Tailscale,Google Drive,Gmail,Google Sheets,スプレッドシート,Apps Script,Chrome,freee,マネーフォワード,ヤフオク,メルカリ,Tapo,Plaud,tl;dv,Zoom,Teams,Notion,Canva,Figma,Shopify,Stripe,Square,Amazon,楽天,ネットプリント,Beds24,Airbnb'.split(',');
export function extractAppNames(text, { humanText = '', playbookNames = [] } = {}) {
  const combined = `${text || ''}\n${humanText}`;
  const includes = name => name === 'X' ? /(?:^|[^A-Za-z])X(?:\s|の|で|に|を|\(|（)/.test(combined) : name.toLowerCase() === 'line' ? /(?:^|[^A-Za-z])LINE(?:$|[^A-Za-z])/i.test(combined) : /^[ -~]+$/.test(name) ? new RegExp(`(?:^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9])`, 'i').test(combined) : combined.toLowerCase().includes(name.toLowerCase());
  const names = [...playbookNames, ...KNOWN_APPS].filter(includes);
  for (const match of String(text || '').matchAll(/\*\*([^*]+)\*\*|「([^」]+)」/g)) {
    const name = match[1] || match[2];
    if (/^[A-Z][A-Za-z0-9 .+-]{2,29}$/.test(name) && humanText.toLowerCase().includes(name.toLowerCase())) names.push(name);
  }
  return names.filter((name, i) => names.findIndex(n => n.toLowerCase() === name.toLowerCase()) === i);
}
export function listPlaybookNames(home) {
  try { return fs.readdirSync(path.join(home, '.claude', 'playbooks'), { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name.slice(0, -3)).sort(); } catch { return []; }
}
export function turnToolUses(transcriptRaw) {
  const entries = transcriptEntries(transcriptRaw);
  return entries.slice(entries.findLastIndex(isHumanEntry) + 1).flatMap(e => e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content.filter(b => b?.type === 'tool_use').map(({ name, input }) => ({ name, input })) : []);
}
export function evaluatePastLogSearch({ text, humanText = '', transcriptRaw = '', playbookNames = [] }) {
  if (classifyHandoff(text) !== 'manual-steps') return { decision: 'pass' };
  if (/\[PASTLOG-OK\]\s*\S/.test(text)) return { decision: 'pass', code: 'PASTLOG-OK' };
  const apps = extractAppNames(text, { humanText, playbookNames });
  if (!apps.length) return { decision: 'pass', reason: 'app-unknown' };
  const uses = turnToolUses(transcriptRaw), entries = transcriptEntries(transcriptRaw), last = entries.findLastIndex(isHumanEntry);
  const injected = entries.filter((e, i) => i >= last || (i >= last - 5 && e.type === 'attachment')).map(e => JSON.stringify(e)).join('\n').toLowerCase();
  const missing = apps.filter(app => !injected.includes(`[playbook:${app.toLowerCase()}]`) && !uses.some(({ name, input }) =>
    (isPastLogSearchToolUse(name, input) && JSON.stringify(input || {}).toLowerCase().includes(app.toLowerCase())) ||
    (name === 'Read' && String(input?.file_path || '').replaceAll('\\', '/').toLowerCase().endsWith(`/playbooks/${app.toLowerCase()}.md`))));
  if (!missing.length) return { decision: 'pass', apps };
  return { decision: 'block', code: 'PAST-LOG-SEARCH', apps, reason: `[PAST-LOG-SEARCH] user に手作業手順を渡していますが、このターンで「${missing.join('」「')}」の過去ログを検索していません。${missing[0]} で過去ログを検索してから書き直せ: ① Skill find-session（引数 "${missing[0]}"） ② Grep pattern="${missing[0]}" path="~/.claude/projects"（*.jsonl）③ Grep path="~/.claude/projects/*/memory" と "~/.claude/playbooks"。過去に成功した実測手順があればそれを使い、無ければ「過去ログ: 該当なし（検索語 ${missing[0]}）」と1行書く。検索しても意味が無い正当な理由がある時だけ [PASTLOG-OK] <理由> を書く。` };
}
async function main() {
  try {
    const input = JSON.parse(await readStdinWithTimeout());
    if (input.stop_hook_active || /subagents/i.test(input.transcript_path || '')) return;
    const ctx = readTranscriptContext(input.transcript_path);
    const result = evaluatePastLogSearch({ text: ctx.assistantText, humanText: ctx.humanText, transcriptRaw: ctx.raw, playbookNames: listPlaybookNames(process.env.ORGIAST_HOME || os.homedir()) });
    if (result.decision === 'block') console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
  } catch { /* hook は fail-open。 */ }
}
if (isEntry(import.meta.url)) await main();
