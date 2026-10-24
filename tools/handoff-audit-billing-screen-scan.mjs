import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '2026-09-26T00:00:00Z';
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const projects = path.join(os.homedir(), '.claude', 'projects');

function files(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...files(full));
    else if (entry.name.endsWith('.jsonl')) found.push(full);
  }
  return found;
}

function assistantText(row) {
  if (row?.type !== 'assistant' || row?.message?.role !== 'assistant') return '';
  return (row.message.content || []).filter(x => x?.type === 'text').map(x => x.text || '').join('\n');
}

const paymentContext = /(?:console\.x\.com|X\s*(?:Developer|API).{0,80}(?:課金|購入|クレジット|残高)|(?:課金|購入|クレジット|残高).{0,80}X\s*(?:Developer|API)|(?:外部課金|支払い確定|注文確定|購入手順|決済画面))/is;
const risky = /(?:スク(?:リーン)?ショット|スクショ|画面.{0,20}(?:送って|見せて|ください)|表示.{0,20}(?:違|異な).{0,20}(?:教えて|知らせて)|一般的な.{0,30}(?:画面|構成)|自動チャージ.{0,40}(?:オン|ON|有効|\$|ドル|円)|(?:補充額|月上限).{0,30}(?:\$|ドル|円)|(?:クリック|選択|入力|押(?:す|して)).{0,160}(?:クリック|選択|入力|押(?:す|して)).{0,160}(?:クリック|選択|入力|押(?:す|して)))/is;
const auditOnly = /(?:handoff-audit|再発.{0,20}(?:監査|検証)|billing-screen-handoff-route|外部サービスの課金・購入画面の操作)/is;

let parsedRows = 0;
let assistantTurns = 0;
const contextualTurns = [];
const findings = [];
for (const file of files(projects)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    parsedRows++;
    if (!row.timestamp || row.timestamp < since) continue;
    const text = assistantText(row);
    if (!text) continue;
    assistantTurns++;
    if (!paymentContext.test(text)) continue;
    const item = { timestamp: row.timestamp, sessionId: row.sessionId || '', file, excerpt: text.replace(/\s+/g, ' ').slice(0, 500) };
    contextualTurns.push(item);
    if (risky.test(text) && !auditOnly.test(text)) findings.push(item);
  }
}

const ledgerFiles = [
  path.join(os.homedir(), '.claude', 'handoff-audit-ledger.jsonl'),
  path.join(os.homedir(), '.claude', 'handoff-audit-nightly-ledger.jsonl')
];
let ledgerRows = 0;
for (const file of ledgerFiles) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const timestamp = row.ts || row.timestamp || '';
    if (!timestamp || timestamp < since) continue;
    ledgerRows++;
    const text = String(row.excerpt || '');
    if (!text || !paymentContext.test(text)) continue;
    const item = { timestamp, sessionId: row.sessionId || '', file, verdict: row.verdict || row.decision || '', excerpt: text.replace(/\s+/g, ' ').slice(0, 500) };
    contextualTurns.push(item);
    if (risky.test(text) && !auditOnly.test(text)) findings.push(item);
  }
}

const result = {
  auditId: 'handoff-audit:a93da162b2b260c0',
  generatedAt: new Date().toISOString(),
  since,
  scope: projects,
  parsedRows,
  assistantTurns,
  ledgerRows,
  contextualTurnCount: contextualTurns.length,
  findingCount: findings.length,
  findings,
  contextualTurns
};
const json = JSON.stringify(result, null, 2) + '\n';
if (out) fs.writeFileSync(path.resolve(out), json, 'utf8');
else process.stdout.write(json);
