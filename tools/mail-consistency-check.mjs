#!/usr/bin/env node
/** Gmail スレッド全体の合意と送信予定本文を照合する（readonly）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const DEFAULT_USER = 'seisaku-team@orgiast.jp';
const idOk = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value);
export const bodyHash = body => crypto.createHash('sha256').update(body).digest('hex');
export const statePath = (target, home = os.homedir()) => path.join(home, '.claude', 'state', 'mail-consistency', `${target}.json`);

function decode(data = '') { return Buffer.from(String(data), 'base64url').toString('utf8'); }
function header(payload, name) { return payload?.headers?.find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value ?? ''; }
export function stripQuoted(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/u.test(line)) continue;
    if (/^\s*-----Original Message-----/iu.test(line) || /^\s*-----\s*$/u.test(line)
      || /^\s*20\d{2}年\d{1,2}月\d{1,2}日.*<[^>]+>:/u.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}
export function mimeText(payload) {
  const texts = [];
  const attachments = [];
  const walk = part => {
    if (!part) return;
    if (part.filename) attachments.push(part.filename);
    if (part.mimeType === 'text/plain' && part.body?.data) texts.push(decode(part.body.data));
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  if (!texts.length && payload?.body?.data) texts.push(decode(payload.body.data));
  return { text: stripQuoted(texts.join('\n')), attachments };
}
export function buildTimeline(messages) {
  return [...messages].sort((a, b) => Number(a.internalDate) - Number(b.internalDate)).map(message => {
    const { text, attachments } = mimeText(message.payload);
    const date = header(message.payload, 'Date') || new Date(Number(message.internalDate)).toISOString();
    const from = header(message.payload, 'From') || '(不明)';
    return { date, from, text, attachments, line: `[${date}][${from}] ${text}${attachments.length ? `\n添付: ${attachments.join(', ')}` : ''}` };
  });
}
export function deterministicFindings({ body, timeline, extras = [], now = new Date() }) {
  const source = `${timeline.map(x => x.text).join('\n')}\n${extras.join('\n')}`;
  const findings = [];
  const amounts = [...new Set(body.match(/¥?[0-9][0-9,]{3,}円?/gu) ?? [])];
  for (const amount of amounts) if (!source.includes(amount) && !source.includes(amount.replace(/[¥円,]/gu, ''))) findings.push({ severity: 'warn', category: '金額', thread_fact: 'スレッド・補助資料に同額なし', thread_ref: null, draft_claim: amount, suggestion: '金額の出所と税区分を確認してください（出所不明の金額）。' });
  if (/(?:見積|請求|金額|ご請求)/u.test(body)) {
    const exclusion = /(?:不要|なし|納品のみ|キャンセル|取りやめ)/u;
    const target = /(?:スタッフ|人件費|設営|撤去|運搬|オプション)/u;
    for (const item of timeline) for (const sentence of item.text.split(/[。！？\n]/u)) {
      if (exclusion.test(sentence) && target.test(sentence)) findings.push({ severity: 'block', category: '除外項目', thread_fact: sentence.trim(), thread_ref: { date: item.date, from: item.from }, draft_claim: body.match(/[^。\n]*(?:見積|請求|金額|ご請求)[^。\n]*/u)?.[0] ?? body, suggestion: '合意済みの除外項目が見積・請求に残っていないか要照合してください。' });
    }
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const todayNumber = parts.year * 10000 + parts.month * 100 + parts.day;
  for (const match of body.matchAll(/(?<!\d)(\d{1,2})(?:\/|月)(\d{1,2})(?:日)?/gu)) {
    const draftNumber = parts.year * 10000 + Number(match[1]) * 100 + Number(match[2]);
    if (draftNumber < todayNumber) findings.push({ severity: 'warn', category: '日付', thread_fact: `本日: ${parts.year}/${parts.month}/${parts.day}`, thread_ref: null, draft_claim: match[0], suggestion: '過去の日付が意図どおりか確認してください。' });
  }
  return findings;
}

async function gmailJson(token, endpoint, fetchImpl) {
  const res = await fetchImpl(`${API}${endpoint}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`Gmail API ${res.status}`);
  return res.json();
}
export async function loadTarget({ draftId, threadId, body, user, fetchImpl = globalThis.fetch, getToken = getDriveToken }) {
  const token = await getToken({ scope: SCOPE, impersonate: user });
  let draft;
  if (draftId) {
    draft = await gmailJson(token, `/drafts/${encodeURIComponent(draftId)}?format=full`, fetchImpl);
    threadId = draft.message?.threadId;
    body = mimeText(draft.message?.payload).text;
  }
  if (!idOk(threadId)) throw new Error('threadId を取得できません');
  const thread = await gmailJson(token, `/threads/${encodeURIComponent(threadId)}?format=full`, fetchImpl);
  return { threadId, body, timeline: buildTimeline((thread.messages ?? []).filter(m => !m.labelIds?.includes('DRAFT'))) };
}
function parseJson(text) {
  const match = String(text).match(/\{[\s\S]*\}/u); if (!match) throw new Error('JSON ではありません');
  const value = JSON.parse(match[0]); if (typeof value.ok !== 'boolean' || !Array.isArray(value.findings)) throw new Error('JSON schema 不正');
  return value;
}
export function defaultLlm(prompt) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm-ask.mjs');
  const failures = [];
  for (const provider of ['kimi', 'gemini', 'groq', 'openrouter']) {
    const call = extra => spawnSync(process.execPath, [script, '--provider', provider, '--no-fallback', '--prefer-provider', '--category', 'extraction', '--max', '4000', '--no-persist', prompt + extra], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    let result = call('');
    if (result.status === 0) {
      try { return { ...parseJson(result.stdout), provider }; }
      catch {
        result = call('\n前の応答が不正です。説明・コードフェンスなしで厳密な JSON オブジェクトだけを返してください。');
        try { return { ...parseJson(result.stdout), provider }; } catch {}
      }
    }
    failures.push(`${provider}: ${String(result.stderr || result.error?.message || '失敗').trim().slice(0, 160)}`);
  }
  throw new Error(`LLM 全プロバイダ失敗: ${failures.join(' / ')}`);
}
export function promptFor(timeline, body, extras) {
  return `次のメールスレッド全体の合意と下書きを照合してください。合意事項を金額（税抜/税込/見積番号）、数量、人件費・設営・撤去の要否、納品形態、日程（搬入・搬出・納期）、名義・宛先、支払条件・請求タイミング、約束（〜までに・負担する）に分類し、日付と発言者を保持してください。矛盾は block、不確実・要確認は warn。厳密に {"ok":boolean,"findings":[{"severity":"block|warn","category":"","thread_fact":"","thread_ref":{"date":"","from":""},"draft_claim":"","suggestion":""}],"summary":""} の JSON だけを返してください。\n\nスレッド:\n${timeline.map(x => x.line).join('\n\n')}\n\n補助資料:\n${extras.join('\n---\n')}\n\n下書き:\n${body}`;
}
export function saveState(report, home = os.homedir()) { const file = statePath(report.target, home); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); return file; }
export async function checkConsistency({ target, draftId, threadId, body, user = DEFAULT_USER, extras = [], deps = {} }) {
  const loaded = deps.loaded ?? await loadTarget({ draftId, threadId, body, user, fetchImpl: deps.fetchImpl, getToken: deps.getToken });
  const deterministic = deterministicFindings({ body: loaded.body, timeline: loaded.timeline, extras, now: deps.now?.() ?? new Date() });
  let llm = { provider: null, error: null }, llmFindings = [], summary = '';
  try { const result = await (deps.llm ?? defaultLlm)(promptFor(loaded.timeline, loaded.body, extras)); llm = { provider: result.provider ?? null, error: null }; llmFindings = result.findings; summary = result.summary ?? ''; }
  catch (error) { llm.error = String(error.message || error); }
  const findings = [...deterministic, ...llmFindings];
  const report = { target: target ?? draftId ?? loaded.threadId, bodyHash: bodyHash(loaded.body), checkedAt: new Date().toISOString(), ok: !findings.some(f => f.severity === 'block'), findings, llm, summary };
  (deps.saveState ?? saveState)(report, deps.home); return report;
}
function parseArgs(argv) { const a = { extraFile: [] }; for (let i=0;i<argv.length;i++) { const k=argv[i]; if(k==='--json'){a.json=true;continue;} if(!['--draft','--thread-id','--body-file','--user','--extra-file'].includes(k)||!argv[i+1]||argv[i+1].startsWith('--')) throw new Error('引数不正'); const v=argv[++i]; if(k==='--extra-file')a.extraFile.push(v); else a[k.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v; } if(Boolean(a.draft)===Boolean(a.threadId)||(!a.draft&&!a.bodyFile)|| (a.draft&&a.bodyFile)) throw new Error('使い方: --draft ID または --thread-id ID --body-file PATH'); return a; }
export async function runCli(argv = process.argv.slice(2), deps = {}) { let json = argv.includes('--json'); try { const a=parseArgs(argv); const body=a.bodyFile?(deps.readFile??fs.readFileSync)(a.bodyFile,'utf8'):undefined; const extras=a.extraFile.map(p=>(deps.readFile??fs.readFileSync)(p,'utf8')); const report=await checkConsistency({target:a.draft??a.threadId,draftId:a.draft,threadId:a.threadId,body,user:a.user??DEFAULT_USER,extras,deps}); (deps.stdout??console.log)(json?JSON.stringify(report):render(report)); return report.ok?0:2; } catch(error) { const out={ok:false,errorKind:'gmail_fetch_failed',error:String(error.message||error)}; (deps.stdout??console.log)(json?JSON.stringify(out):`Gmail 取得失敗: ${out.error}`); return 3; } }
export function render(report) { return [`メール整合性: ${report.ok?'OK':'BLOCK'}`, ...report.findings.map(f=>`[${f.severity}] ${f.category}\n根拠: ${f.thread_fact}${f.thread_ref?` (${f.thread_ref.date} / ${f.thread_ref.from})`:''}\n下書き: ${f.draft_claim}\n修正: ${f.suggestion}`), ...(report.llm.error?[`[warn] LLM チェック失敗: ${report.llm.error}（決定論チェックのみ）`]:[])].join('\n'); }
if (isEntry(import.meta.url)) process.exitCode = await runCli();
