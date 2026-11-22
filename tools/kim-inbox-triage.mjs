#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';

const execFileAsync = promisify(execFile);
const DAY_MS = 86_400_000;

export function normalizeForComparison(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/^(?:【[^】]*】\s*)+/, '')
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b/g, '')
    .replace(/\d+(?:日|時間|件)/g, 'N')
    .replace(/(?:\bkim\b|キムさん|キム|金さん|金功勇)/gi, 'kim')
    .replace(/[\p{Extended_Pictographic}\uFE0E\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ').trim();
}

export function readOpenAsks(ledgerDir) {
  let names;
  try { names = fs.readdirSync(ledgerDir); }
  catch (error) { throw new Error(`台帳を読めません: ${error.message}`); }
  return names.filter(name => /^ki-\d{14}-[a-f0-9]{4}\.json$/.test(name)).flatMap(name => {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(ledgerDir, name), 'utf8'));
      return item.kind === 'ask' && item.status === 'open' ? [item] : [];
    } catch { return []; }
  }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

export function extractReferences(text) {
  const prRefs = new Map();
  for (const match of String(text).matchAll(/https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/gi)) {
    prRefs.set(`${match[1]}#${match[2]}`, { number: Number(match[2]), repo: match[1] });
  }
  for (const match of String(text).matchAll(/(?:PR|プルリク(?:エスト)?)\s*#(\d+)/gi)) {
    if (![...prRefs.values()].some(ref => ref.number === Number(match[1])))
      prRefs.set(`#${match[1]}`, { number: Number(match[1]), repo: null });
  }
  const branches = [...new Set([...String(text).matchAll(/\b(?:rescue|task|fix|feat|chore)\/[A-Za-z0-9._/-]+/g)]
    .map(match => match[0].replace(/[),.。/]+$/, '')))];
  return { prs: [...prRefs.values()], branches };
}

function groupRule(item) {
  const text = item.text || '';
  if (/\brescue\//i.test(text) && /削除|破棄|残す|レビュー|承認/i.test(text))
    return { key: 'rescue-branches', label: 'rescue ブランチの破棄可否', answer: 'rescue ブランチ一覧を「一括破棄可／残すID」に分けて1行で回答' };
  if (/(?:PR|プルリク(?:エスト)?)\s*#\d+/i.test(text) && /マージ|merge|承認|着地/i.test(text))
    return { key: 'pr-merge-approval', label: 'PR のマージ承認', answer: 'PR番号を「一括マージ可／保留」に分けて1行で回答' };
  if (/ログイン|OAuth|API.?key|secret|環境変数|認証/i.test(text) && /設定|登録|許可|承認|判断/i.test(text))
    return { key: 'credential-config', label: '認証・設定の可否', answer: '設定対象を「設定可／保留」に分けて1行で回答' };
  if (/セッション|作業ID/i.test(text) && /再開|続行|停止|破棄|クローズ|判断/i.test(text))
    return { key: 'session-disposition', label: '停滞セッションの扱い', answer: '作業IDを「再開／終了」に分けて1行で回答' };
  return null;
}

export async function collectEvidence(items, probes = {}) {
  const checkPr = probes.checkPr ?? defaultCheckPr;
  const checkBranch = probes.checkBranch ?? defaultCheckBranch;
  const prKeys = new Map(), branches = new Set();
  for (const item of items) {
    const refs = extractReferences(item.text);
    for (const ref of refs.prs) prKeys.set(`${ref.repo || ''}#${ref.number}`, ref);
    for (const branch of refs.branches) branches.add(branch);
  }
  const prStates = new Map(await Promise.all([...prKeys].map(async ([key, ref]) => {
    try { return [key, await checkPr(ref)]; } catch { return [key, null]; }
  })));
  const branchStates = new Map(await Promise.all([...branches].map(async branch => {
    try { return [branch, await checkBranch(branch)]; } catch { return [branch, null]; }
  })));
  return { prStates, branchStates };
}

async function defaultCheckPr({ number, repo }) {
  const args = ['pr', 'view', String(number), '--json', 'state,number,url'];
  if (repo) args.push('--repo', repo);
  const { stdout } = await execFileAsync('gh', args, { timeout: 15_000, windowsHide: true });
  return JSON.parse(stdout);
}

async function defaultCheckBranch(branch) {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    { timeout: 15_000, windowsHide: true });
  return { exists: stdout.trim().length > 0 };
}

export function classifyItems(items, evidence = { prStates: new Map(), branchStates: new Map() }) {
  const newestByText = new Map();
  for (const item of items) newestByText.set(normalizeForComparison(item.text), item);
  const classified = items.map(item => {
    const refs = extractReferences(item.text);
    const newer = newestByText.get(normalizeForComparison(item.text));
    if (newer && newer.id !== item.id && String(newer.createdAt) > String(item.createdAt))
      return { ...item, classification: 'A', reason: `同内容の新しい ask ${newer.id} が ${newer.createdAt} に登録済み` };
    for (const ref of refs.prs) {
      const state = evidence.prStates.get(`${ref.repo || ''}#${ref.number}`);
      if (state?.state === 'MERGED') return { ...item, classification: 'A', reason: `PR #${ref.number} が MERGED（${state.url || ref.repo || '現在の origin'}）` };
    }
    for (const branch of refs.branches) {
      const state = evidence.branchStates.get(branch);
      if (state?.exists === false) return { ...item, classification: 'A', reason: `${branch} が origin に存在しない` };
    }
    const group = groupRule(item);
    if (group) return { ...item, classification: 'B', groupKey: group.key, groupLabel: group.label, suggestedAnswer: group.answer };
    return { ...item, classification: 'C', reason: '完了・失効を実測できず、共通回答の型にも安全に集約できない' };
  });
  const groups = [...Map.groupBy(classified.filter(item => item.classification === 'B'), item => item.groupKey)]
    .map(([key, members]) => ({ key, label: members[0].groupLabel, count: members.length,
      answer: `${members[0].suggestedAnswer}（${members.length}件が対象）`, ids: members.map(item => item.id) }));
  return { items: classified, groups };
}

function originName(item) { return item.source || (item.sessionId ? `session:${item.sessionId}` : '(source/sessionなし)'); }
function askType(item) {
  if (/\brescue\//i.test(item.text || '')) return 'rescueブランチ';
  if (/(?:PR|プルリク(?:エスト)?)\s*#\d+/i.test(item.text || '')) return 'PR判断';
  if (/ログイン|OAuth|API.?key|secret|環境変数|認証/i.test(item.text || '')) return '認証・設定';
  if (/セッション|作業ID/i.test(item.text || '')) return 'セッション・作業継続';
  return 'その他の個別判断';
}
function counts(values, key) { return [...Map.groupBy(values, key)].map(([name, rows]) => ({ name, count: rows.length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)); }

export function buildReport(items, result, now = new Date()) {
  const oldest = items[0];
  return {
    generatedAt: now.toISOString(),
    summary: {
      total: items.length,
      A: result.items.filter(item => item.classification === 'A').length,
      B: result.items.filter(item => item.classification === 'B').length,
      C: result.items.filter(item => item.classification === 'C').length,
      oldest: oldest ? { id: oldest.id, createdAt: oldest.createdAt, ageDays: Math.floor((now - new Date(oldest.createdAt)) / DAY_MS) } : null,
    },
    origins: counts(items, originName),
    dates: counts(items, item => String(item.createdAt || '').slice(0, 10)).sort((a, b) => a.name.localeCompare(b.name)),
    types: counts(items, askType),
    groups: result.groups,
    items: result.items.map(({ id, createdAt, source, sessionId, classification, reason, groupKey, text }) =>
      ({ id, createdAt, source: source || '', sessionId: sessionId || '', classification, reason: reason || '', groupKey: groupKey || '', text })),
  };
}

function line(text, width) { text = String(text ?? '').replace(/\s+/g, ' '); return text.length > width ? `${text.slice(0, width - 1)}…` : text; }
export function formatTable(report) {
  const out = [`未回答 ask: ${report.summary.total}件 / A ${report.summary.A} / B ${report.summary.B} / C ${report.summary.C}`];
  if (report.summary.oldest) out.push(`最古: ${report.summary.oldest.createdAt.slice(0, 10)}（${report.summary.oldest.ageDays}日前、${report.summary.oldest.id}）`);
  out.push('', '登録元 上位10', ...report.origins.slice(0, 10).map(row => `${String(row.count).padStart(4)}  ${row.name}`));
  out.push('', '登録日別', ...report.dates.map(row => `${row.name}  ${row.count}`));
  out.push('', '質問の型', ...report.types.map(row => `${String(row.count).padStart(4)}  ${row.name}`));
  out.push('', 'A: もう答える必要がない', ...report.items.filter(item => item.classification === 'A').map(item => `${item.id}  ${line(item.reason, 110)}`));
  out.push('', 'B: まとめて1回で答えられる', ...report.groups.map(group => `${group.label}: ${group.answer}\n  ${group.ids.join(', ')}`));
  out.push('', 'C: 個別の判断が要る', ...report.items.filter(item => item.classification === 'C').map(item => `${item.id}  ${line(item.text, 110)}`));
  return out.join('\n');
}

export async function main(args = process.argv.slice(2)) {
  const formatAt = args.indexOf('--format');
  const format = formatAt >= 0 ? args[formatAt + 1] : 'table';
  if (!['table', 'json'].includes(format)) throw new Error('--format は table または json を指定してください');
  const ledgerAt = args.indexOf('--ledger-dir');
  const ledgerDir = ledgerAt >= 0 ? args[ledgerAt + 1] : path.join(os.homedir(), '.claude', 'kim-inbox');
  const items = readOpenAsks(ledgerDir);
  const evidence = await collectEvidence(items);
  const report = buildReport(items, classifyItems(items, evidence));
  console.log(format === 'json' ? JSON.stringify(report, null, 2) : formatTable(report));
}

if (isEntry(import.meta.url)) {
  main().catch(error => { console.error(`kim-inbox-triage: ${error.message}`); process.exitCode = 1; });
}
