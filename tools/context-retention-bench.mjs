// セッション記録を「通常の要約」と「構造化抽出 + 決定的復元」で圧縮し、
// 次の文脈へ重要情報がどれだけ残るかを比較する実測ハーネス。
//
// 使い方:
//   node tools/context-retention-bench.mjs --local-only
//   node tools/context-retention-bench.mjs --provider <p> --model <m>
//   node tools/context-retention-bench.mjs --local-only --out <file.md>
//
// 安全性: 入力はすべて本ファイル内の合成記録。実在の人物・案件・URL・顧客名は使わない。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const KINDS = ['ref', 'path', 'decision', 'constraint', 'number', 'open'];
export const METHODS = ['summary', 'structured'];

// 合成の作業記録。gold の value は採点可能性を保つため、原文へそのまま埋め込む。
export const CASES = [
  {
    id: 'CASE-01',
    transcript: 'タスクIDは TASK-314。PR #271 を確認し、コミットSHAは A1B2C3D。対象は src/example/parser.mjs。決定事項: base は main から切る。制約: `git add -A` は禁止。期限は 3日。未解決: Windowsで改行差分が出るか？',
    gold: [
      { kind: 'ref', key: 'task', value: 'TASK-314' }, { kind: 'ref', key: 'pr', value: 'PR #271' }, { kind: 'ref', key: 'sha', value: 'A1B2C3D' },
      { kind: 'path', key: 'target', value: 'src/example/parser.mjs' }, { kind: 'decision', key: 'base', value: 'base は main から切る' },
      { kind: 'constraint', key: 'git', value: '`git add -A` は禁止' }, { kind: 'number', key: 'deadline', value: '3日' },
      { kind: 'open', key: 'newline', value: 'Windowsで改行差分が出るか？' },
    ],
  },
  {
    id: 'CASE-02',
    transcript: 'チケットID BUG-482 を調査。リポジトリは example-org/example-repo、修正対象は src/example/cache.js。決定事項: TTL は固定値にする。制約: 外部APIを呼ばない。再現は 12件。未解決: 並列実行でも順序を保証できるか？',
    gold: [
      { kind: 'ref', key: 'ticket', value: 'BUG-482' }, { kind: 'ref', key: 'repo', value: 'example-org/example-repo' },
      { kind: 'path', key: 'target', value: 'src/example/cache.js' }, { kind: 'decision', key: 'ttl', value: 'TTL は固定値にする' },
      { kind: 'constraint', key: 'network', value: '外部APIを呼ばない' }, { kind: 'number', key: 'cases', value: '12件' },
      { kind: 'open', key: 'order', value: '並列実行でも順序を保証できるか？' },
    ],
  },
  {
    id: 'CASE-03',
    transcript: '作業ID OPS-205、PR #608。設定は src/example/runtime.json に置く。決定事項: 再試行は指数バックオフにする。制約: 本番データを使わない。上限は 5回。未解決: タイムアウトを何秒にするか？',
    gold: [
      { kind: 'ref', key: 'work', value: 'OPS-205' }, { kind: 'ref', key: 'pr', value: 'PR #608' },
      { kind: 'path', key: 'config', value: 'src/example/runtime.json' }, { kind: 'decision', key: 'retry', value: '再試行は指数バックオフにする' },
      { kind: 'constraint', key: 'data', value: '本番データを使わない' }, { kind: 'number', key: 'limit', value: '5回' },
      { kind: 'open', key: 'timeout', value: 'タイムアウトを何秒にするか？' },
    ],
  },
  {
    id: 'CASE-04',
    transcript: 'タスク DEV-730、コミット 9F8E7D6。入口は src/example/cli.mjs。決定事項: 出力形式はMarkdownに統一する。制約: 既存ファイルを変更しない。予算は 8000円。未解決: 色付き出力を既定にするか？',
    gold: [
      { kind: 'ref', key: 'task', value: 'DEV-730' }, { kind: 'ref', key: 'sha', value: '9F8E7D6' },
      { kind: 'path', key: 'entry', value: 'src/example/cli.mjs' }, { kind: 'decision', key: 'format', value: '出力形式はMarkdownに統一する' },
      { kind: 'constraint', key: 'files', value: '既存ファイルを変更しない' }, { kind: 'number', key: 'budget', value: '8000円' },
      { kind: 'open', key: 'color', value: '色付き出力を既定にするか？' },
    ],
  },
  {
    id: 'CASE-05',
    transcript: 'チケット DOC-119 と PR #453 を追跡。文書は src/example/guide.md。決定事項: 用語は日本語に揃える。制約: URLを記載しない。見出しは 7個。未解決: 初心者向け例を追加するか？',
    gold: [
      { kind: 'ref', key: 'ticket', value: 'DOC-119' }, { kind: 'ref', key: 'pr', value: 'PR #453' },
      { kind: 'path', key: 'doc', value: 'src/example/guide.md' }, { kind: 'decision', key: 'terms', value: '用語は日本語に揃える' },
      { kind: 'constraint', key: 'url', value: 'URLを記載しない' }, { kind: 'number', key: 'headings', value: '7個' },
      { kind: 'open', key: 'example', value: '初心者向け例を追加するか？' },
    ],
  },
];

export function buildSummaryPrompt(c) {
  return '次のセッション記録を、500字以内の箇条書きで要約してください。重要だと思う点を残してください。\n\n--- 記録 ---\n' + c.transcript + '\n--- ここまで ---';
}

export function buildStructuredPrompt(c) {
  return [
    '次のセッション記録から事実をJSONだけで抜き出してください。説明文・コードフェンスは付けません。',
    'キーは ref, path, decision, constraint, number, open の6つを必ず置き、各値は {"key":"短い名称","value":"原文どおりの値"} の配列にします。該当なしは空配列です。',
    '識別子、パス、決定、制約、数値、未解決の問いを省略せず、value は記録中の文字列を改変せずに写してください。',
    '', '--- 記録 ---', c.transcript, '--- ここまで ---',
  ].join('\n');
}

// LLM応答からJSON本体を取り出す（コードフェンス・前置き混入に耐える）。
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

export function normalizeFact(kind, value) {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[\s　]+/g, ' ').trim();
  if (kind === 'ref') s = s.replace(/\b[0-9a-f]{7,40}\b/gi, (sha) => sha.toLowerCase());
  return s;
}

export function validateFacts(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return KINDS.every((kind) => Array.isArray(obj[kind]) && obj[kind].every((x) => x && typeof x === 'object' && typeof x.key === 'string' && typeof x.value === 'string'));
}

// structured の復元はLLMを通さない。検証済み要素の value を必ず原文のまま出力する。
export function renderStructured(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const lines = [];
  for (const kind of KINDS) {
    if (!Array.isArray(obj[kind])) continue;
    for (const fact of obj[kind]) {
      if (!fact || typeof fact !== 'object' || fact.value === null || fact.value === undefined) continue;
      lines.push('- [' + kind + '] ' + (typeof fact.key === 'string' && fact.key ? fact.key + ': ' : '') + String(fact.value));
    }
  }
  return lines.join('\n');
}

function hasExactValue(text, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}_])' + escaped + '(?=$|[^\\p{L}\\p{N}_])', 'u').test(text);
}

export function scoreRetention(gold, text) {
  const source = typeof text === 'string' ? text : '';
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, { matched: 0, total: 0, recall: 0 }]));
  const missing = [];
  let matched = 0;
  for (const fact of Array.isArray(gold) ? gold : []) {
    if (!KINDS.includes(fact.kind)) continue;
    const expected = normalizeFact(fact.kind, fact.value);
    const normalizedText = normalizeFact(fact.kind, source);
    const ok = expected !== '' && hasExactValue(normalizedText, expected);
    byKind[fact.kind].total += 1;
    if (ok) { matched += 1; byKind[fact.kind].matched += 1; }
    else missing.push(fact);
  }
  const total = Object.values(byKind).reduce((n, x) => n + x.total, 0);
  for (const x of Object.values(byKind)) x.recall = x.total ? x.matched / x.total : 0;
  return { recall: total ? matched / total : 0, byKind, total, matched, missing };
}

function factsFromGold(gold) {
  const obj = Object.fromEntries(KINDS.map((kind) => [kind, []]));
  for (const fact of gold) obj[fact.kind].push({ key: fact.key, value: fact.value });
  return obj;
}

// クラウド経路: 既存の統合CLIを子プロセスで呼び、--no-fallback で応答元を固定する。
function cloudCall(root, provider, model, prompt, timeoutMs) {
  const ask = path.join(root, 'tools', 'llm-ask.mjs');
  const r = spawnSync(process.execPath, [ask, '--provider', provider, '--model', model, '--no-fallback', '--max', '2000', prompt], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const localOnly = args.includes('--local-only');
  const provider = opt('--provider', 'openrouter');
  const model = opt('--model', 'qwen/qwen3-coder-flash');
  const timeoutMs = parseInt(opt('--timeout', '90000'), 10);
  const rows = [];

  for (const c of CASES) {
    if (localOnly) {
      const text = renderStructured(factsFromGold(c.gold));
      rows.push({ method: 'structured', caseId: c.id, text, err: '' });
      continue;
    }
    for (const method of METHODS) {
      const prompt = method === 'summary' ? buildSummaryPrompt(c) : buildStructuredPrompt(c);
      const r = cloudCall(root, provider, model, prompt, timeoutMs);
      let err = r.status === 0 ? '' : ('exit=' + r.status + ' ' + String(r.stderr).slice(0, 200));
      let text = r.stdout;
      if (method === 'structured' && !err) {
        const obj = extractJson(text);
        if (!validateFacts(obj)) { err = 'structured JSON schema invalid'; text = ''; }
        else text = renderStructured(obj);
      }
      rows.push({ method, caseId: c.id, text, err });
    }
  }

  const out = ['', '| 手法 | 識別子保持率 | 全体保持率 | 圧縮後バイト | 元バイト | 圧縮率 |', '|---|---:|---:|---:|---:|---:|'];
  for (const method of METHODS.filter((m) => rows.some((r) => r.method === m))) {
    const selected = rows.filter((r) => r.method === method);
    let refs = 0, refTotal = 0, matched = 0, total = 0, compressed = 0, original = 0;
    for (const row of selected) {
      const c = CASES.find((x) => x.id === row.caseId);
      const sc = scoreRetention(c.gold, row.text);
      refs += sc.byKind.ref.matched; refTotal += sc.byKind.ref.total;
      matched += sc.matched; total += sc.total;
      compressed += Buffer.byteLength(row.text, 'utf8'); original += Buffer.byteLength(c.transcript, 'utf8');
    }
    out.push('| ' + method + ' | ' + refs + '/' + refTotal + ' (' + Math.round(refs / refTotal * 100) + '%) | ' + matched + '/' + total + ' (' + Math.round(matched / total * 100) + '%) | ' + compressed + ' B | ' + original + ' B | ' + (original ? (compressed / original * 100).toFixed(1) : '0.0') + '% |');
  }
  console.log(out.join('\n'));
  console.log('\n### ケース別');
  for (const row of rows) {
    const c = CASES.find((x) => x.id === row.caseId);
    const sc = scoreRetention(c.gold, row.text);
    console.log('- ' + row.method + ' ' + row.caseId + ': 一致=' + sc.matched + '/' + sc.total + (row.err ? ' ERR=' + row.err : ''));
  }

  const outFile = opt('--out', '');
  if (outFile) {
    const lines = ['', ...out, '', '### 生データ', '', '```json', JSON.stringify(rows.map((row) => ({ method: row.method, case: row.caseId, err: row.err })), null, 1), '```'];
    fs.appendFileSync(outFile, lines.join('\n') + '\n');
    console.log('\n[written] ' + outFile);
  }
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === 'context-retention-bench.mjs';
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
