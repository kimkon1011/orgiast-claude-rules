#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"outbound-claim-evidence-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"outbound-claim-evidence-gate"}]};
import fs from 'node:fs/promises';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
import { currentTurnEntries, messageText, sentences } from './state-claim-evidence.mjs';

export const HOOK_MATCHER = 'Bash|PowerShell';
const LIMIT = 5 * 1024 * 1024;
const LINE = /api\.line\.me\/v2\/bot\/message\/(?:push|reply|multicast)/iu;
const DISCORD_POST = /discord\.com\/api\/v10\/channels\/[^\s"'`]+\/messages[\s\S]{0,300}(?:method\s*:\s*["'`]POST|-[Xx]\s*POST)|(?:method\s*:\s*["'`]POST|-[Xx]\s*POST)[\s\S]{0,300}discord\.com\/api\/v10\/channels\/[^\s"'`]+\/messages/iu;
const GMAIL_DRAFT = /(?:^|[\\/])gmail-draft\.mjs\b/iu;
const DISCORD_DM = /(?:^|[\\/])discord-dm\.mjs\b/iu;
const OPERATIONS = '(?:入力|予約|登録|送付|送信|手配|申込|申し込み|設定|発注|お振込|振込|共有|招待|追加|反映|公開|アップロード)';
const COMPLETION = '(?:いたしました|致しました|しました|済み|済です|完了しました|が完了)';
const CLAIM = new RegExp(`${OPERATIONS}${COMPLETION}`, 'u');
const OPERATION = new RegExp(OPERATIONS, 'u');
const RETRACTION = /誤った(?:ご)?連絡|誤りでした|訂正|完了しておらず|実際には.{0,30}(?:していません|できていません)/u;
const tokens = command => (String(command).match(/(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s"'`;|&]+)|[;|&\n]+/gsu) ?? []).map(x => x.replace(/^(["'`])([\s\S]*)\1$/u, '$2'));

async function readLimited(file) {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > LIMIT) throw new Error('5MB超');
    const buffer = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMIT) throw new Error('5MB超');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

function stringLiterals(source) {
  return [...String(source).matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*)\1/gu)].map(match => match[2]
    .replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\t/gu, '\t').replace(/\\(["'`\\])/gu, '$1')).join('\n');
}

function option(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; }

async function inspectedPayload(input) {
  const command = String(input.tool_input?.command ?? '');
  const argv = tokens(command);
  let cwd = path.resolve(input.cwd || process.cwd());
  let script = '';
  for (let i = 0; i < argv.length; i++) {
    if (/^(?:cd|Set-Location)$/iu.test(argv[i]) && argv[i + 1]) cwd = path.resolve(cwd, argv[++i]);
    if (!/(?:^|[\\/])node(?:\.exe)?$/iu.test(argv[i])) continue;
    let j = i + 1;
    while (argv[j]?.startsWith('-') && !/^(?:-e|--eval|-p|--print)$/u.test(argv[j])) j++;
    if (/\.(?:mjs|cjs|js)$/iu.test(argv[j] ?? '') && !/^(?:gmail-draft|discord-dm)\.mjs$/iu.test(path.basename(argv[j]))) script += `\n${await readLimited(path.resolve(cwd, argv[j]))}`;
  }
  const combined = `${command}\n${script}`;
  const gmail = GMAIL_DRAFT.test(command) && argv.includes('--send') && argv.includes('--body-file');
  const discord = DISCORD_DM.test(command);
  const sending = LINE.test(combined) || DISCORD_POST.test(combined) || gmail || discord;
  if (!sending || /api\.line\.me\/v2\/bot\/message\/(?:broadcast|narrowcast)/iu.test(combined)) return null;
  let body = script ? stringLiterals(script) : command;
  if (discord) body += `\n${option(argv, '--body')}`;
  const bodyFile = option(argv, '--body-file');
  if (bodyFile && (gmail || discord)) body += `\n${await readLimited(path.resolve(cwd, bodyFile))}`;
  return body;
}

export function findCompletionClaims(text) {
  return sentences(text).filter(sentence => CLAIM.test(sentence) && !RETRACTION.test(sentence)).slice(0, 5);
}

function currentAssistantText(raw) {
  const withoutTaskNotifications = String(raw).split(/\r?\n/u).filter(line => {
    try { return !/^\s*<task-notification>/u.test(messageText(JSON.parse(line))); } catch { return true; }
  }).join('\n');
  return currentTurnEntries(withoutTaskNotifications).filter(entry => entry.type === 'assistant' || entry.message?.role === 'assistant')
    .map(messageText).join('\n');
}

function validEvidenceTags(text) {
  const tags = [];
  for (const match of String(text).matchAll(/\[CLAIM-EVIDENCE:\s*([^\]\n]+?)\s*=>\s*([^\]\n]+?)\s*\]/gu)) {
    const summary = match[1].trim(); const source = match[2].trim();
    if (!summary || /未確認|可能性/u.test(source)) continue;
    if (/^(?:gmail|calendar|api):[^\s]+$/u.test(source) || /^url:https?:\/\/\S+$/u.test(source) || /^shot:\S+$/u.test(source)) tags.push({ summary, source });
  }
  return tags;
}

function hasOverride(text) {
  return [...String(text).matchAll(/\[OUTBOUND-CLAIM-OK:\s*([^\]\n]+)\]/gu)].some(match => match[1].trim().length >= 10);
}

export async function judge(input, { warning = () => {} } = {}) {
  try {
    if (!input || !/^(?:Bash|PowerShell)$/u.test(input.tool_name ?? '')) return { decision: 'pass' };
    const payload = await inspectedPayload(input);
    if (payload === null) return { decision: 'pass' };
    const claims = findCompletionClaims(payload);
    if (!claims.length) return { decision: 'pass' };
    const transcript = input.transcript_path ? await readLimited(input.transcript_path) : '';
    const assistant = currentAssistantText(transcript);
    if (hasOverride(assistant)) return { decision: 'pass' };
    const tags = validEvidenceTags(assistant);
    const missing = claims.filter(claim => {
      const operation = claim.match(OPERATION)?.[0];
      const index = tags.findIndex(tag => operation && tag.summary.includes(operation));
      if (index < 0) return true;
      tags.splice(index, 1); return false;
    });
    if (!missing.length) return { decision: 'pass' };
    return { decision: 'block', reason: `社外送信本文に読み戻し証拠のない完了主張があります: ${missing.map(claim => `「${claim}」`).join(' / ')}。送信前に実際の外部状態を読み戻し、現在ターンの assistant テキストへ [CLAIM-EVIDENCE: 主張の要約 => 読み戻し元] を書いてください。読み戻し元は gmail:<messageId> / calendar:<eventId> / url:<URL> / shot:<path> / api:<request-id>。予約・入力なら確認メールまたはカレンダー、送付・送信なら送信済みフォルダを確認してください。引用など真の主張でない場合だけ [OUTBOUND-CLAIM-OK: 10文字以上の理由] を使用できます。` };
  } catch (error) { warning(`判定をスキップ: ${error.message}`); return { decision: 'pass' }; }
}

export async function main() {
  try {
    const raw = await readStdinWithTimeout(4000); if (!raw.trim()) return;
    const result = await judge(JSON.parse(raw), { warning: text => console.error(`[OUTBOUND-CLAIM-EVIDENCE] ${text}`) });
    if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch (error) { console.error(`[OUTBOUND-CLAIM-EVIDENCE] 判定をスキップ: ${error.message}`); }
}

if (isEntry(import.meta.url)) await main();
