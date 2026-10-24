import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

import { isEntry } from './is-entry.mjs';

const DM_MENTION = /(?:Discord\s*(?:の)?\s*DM|(?<![A-Za-z])DM(?![A-Za-z]))/;
const DM_DELIVERY = /(?:DM\s*(?:で|に|を|は)?\s*(?:送付|送信|送ります|送る|送り|送って)|DM\s*の?実送信|まだ送っていません|送信不可|送れません)/;
const INTERNAL = /(?:社内|スタッフ|社員|従業員|内部|グループ会社|本人宛|経理チーム|orgiast\.jp|toho-kogyo|宮地|木下|古川|アブドゥル|金功勇|kim)/i;
const COMPLETE = /(?:送信済み|送付済み|送りました|送付しました|送信しました|実送信した|読み戻し)/;
const ROUTE_EXPLANATION = /(?:チャット本文|チャット表示|Gmail 下書き|internal-recipient|SEND_FAILED|Discord Bot トークンが見つかりません|tools\/discord-dm|再発防止の経路|handoff-audit:|規約|ルール\s*7|rule\s*7|実測[:：])/;
const APP_FEATURE = /(?:keiri-hub|\/shoyo|賞与|アプリ|機能|フロー|cron|src\/)/;

export function detectLine(line) {
  if (typeof line !== 'string') return false;
  return DM_MENTION.test(line)
    && DM_DELIVERY.test(line)
    && INTERNAL.test(line)
    && !COMPLETE.test(line)
    && !ROUTE_EXPLANATION.test(line)
    && !APP_FEATURE.test(line);
}

export function scanText(text, { source = '', ts = '' } = {}) {
  if (text == null || text === '') return [];
  return String(text).split(/\r?\n/)
    .filter(detectLine)
    .map((line) => ({ source, ts, line: line.trim().slice(0, 400) }));
}

export const CONTROLS = [
  { id: 'P1', line: '古川さんにも本人宛に PDF を DM で送ります。', want: true },
  { id: 'P2', line: '上の依頼文を kim さんへ DM で送ってよければ「送って」とだけ返す', want: true },
  { id: 'P3', line: '本人宛 DM は送信不可のため、次回トークン設置後に送ります', want: true },
  { id: 'P4', line: '宮地さんへの Discord DM、まだ送っていません。kim さんのOKが出てから送ります', want: true },
  { id: 'P5', line: '#経理チーム のスタッフへ Discord DM を送ります', want: true },
  { id: 'N1', line: '社員へ PDF を DM で送付（keiri-hub アプリの機能）', want: false },
  { id: 'N2', line: 'Discord DM で送信済みです（読み戻し確認済み）', want: false },
  { id: 'N3', line: 'tools/discord-dm.mjs は Bot トークン不在で SEND_FAILED', want: false },
  { id: 'N4', line: '内部宛は Discord DM で送る。送れない場合はチャット本文に宛先/用件/本文を完成形で表示（Gmail 下書きにしない）', want: false },
  { id: 'N5', line: 'Discord DM は使わない。チャット本文に完成形を表示する', want: false },
  { id: 'N6', line: '1. [handoff-audit:60e9dd3bf0e3453e] Discord DM 送信を前提にした社内連絡 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: チャット表示）', want: false },
  { id: 'N7', line: '社内スタッフへ Discord DM を送りました', want: false },
];

export function selftest() {
  const failures = CONTROLS.flatMap(({ id, line, want }) => {
    const got = detectLine(line);
    return got === want ? [] : [{ id, want, got, line }];
  });
  return { total: CONTROLS.length, passed: CONTROLS.length - failures.length, failures };
}

async function readQuietly(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

async function recentFile(path, sinceMs) {
  try { return (await stat(path)).mtimeMs >= sinceMs; } catch { return false; }
}

async function walkJsonl(root, sinceMs) {
  const found = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && await recentFile(path, sinceMs)) found.push(path);
    }
  }
  await walk(root);
  return found;
}

function parseArgs(argv) {
  const args = { json: false, selftest: false, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--selftest') args.selftest = true;
    else if (argv[i] === '--since') args.since = argv[++i];
  }
  return args;
}

function messageText(rec) {
  const content = rec?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n');
}

function hasToolResult(rec) {
  const content = rec?.message?.content;
  return Array.isArray(content) && content.some((part) => part?.type === 'tool_result');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.selftest) {
    const result = selftest();
    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length) process.exitCode = 1;
    return;
  }

  const defaultSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sinceDate = args.since ? new Date(args.since) : defaultSince;
  const since = sinceDate.toISOString();
  const sinceMs = sinceDate.getTime();
  const home = homedir();
  const claude = join(home, '.claude');
  const hits = [];
  const ledgerNames = [
    'handoff-audit-ledger', 'stop-gate-runner-ledger', 'course-corrections-ledger',
    'auto-progress-ledger', 'handoff-audit-nightly-ledger', 'handoff-audit-deferral-ledger',
    'handoff-audit-promotions', 'handoff-audit-candidates',
  ];

  for (const name of ledgerNames) {
    const filename = `${name}.jsonl`;
    const text = await readQuietly(join(claude, filename));
    if (text == null) continue;
    for (const raw of text.split(/\r?\n/)) {
      try {
        const row = JSON.parse(raw);
        if (row.ts && new Date(row.ts).getTime() >= sinceMs) {
          hits.push(...scanText(JSON.stringify(row), { source: `ledger:${filename}`, ts: row.ts }));
        }
      } catch { /* unreadable records are skipped */ }
    }
  }

  for (const filename of ['next-session.md', 'session-handoffs.md']) {
    const path = join(claude, filename);
    if (!await recentFile(path, sinceMs)) continue;
    const text = await readQuietly(path);
    if (text != null) hits.push(...scanText(text, { source: filename, ts: new Date((await stat(path)).mtimeMs).toISOString() }));
  }

  const runsDir = join(claude, 'auto-session', 'runs');
  let runEntries = [];
  try { runEntries = await readdir(runsDir, { withFileTypes: true }); } catch { /* absent directory */ }
  for (const entry of runEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.summary.md')) continue;
    const path = join(runsDir, entry.name);
    if (!await recentFile(path, sinceMs)) continue;
    const info = await stat(path);
    const text = await readQuietly(path);
    if (text != null) hits.push(...scanText(text, { source: `summary:${entry.name}`, ts: new Date(info.mtimeMs).toISOString() }));
  }

  const transcriptRoots = [
    join(claude, 'projects'), join(claude, 'projects-archive'), join(claude, 'cheap-code-worker', 'projects'),
  ];
  for (const root of transcriptRoots) {
    for (const path of await walkJsonl(root, sinceMs)) {
      const text = await readQuietly(path);
      if (text == null) continue;
      for (const raw of text.split(/\r?\n/)) {
        try {
          const rec = JSON.parse(raw);
          const ts = rec.ts || rec.timestamp;
          if (!ts || new Date(ts).getTime() < sinceMs || !['assistant', 'user'].includes(rec.type)) continue;
          if (rec.type === 'user' && hasToolResult(rec)) continue;
          hits.push(...scanText(messageText(rec), { source: `transcript:${basename(path)}`, ts }));
        } catch { /* unreadable records are skipped */ }
      }
    }
  }

  const counts = {
    ledger: 0,
    'next-session.md': 0,
    'session-handoffs.md': 0,
    summary: 0,
    transcript: 0,
  };
  for (const hit of hits) {
    const kind = hit.source.split(':', 1)[0];
    counts[kind] = (counts[kind] || 0) + 1;
  }
  if (args.json) console.log(JSON.stringify({ since, counts, hits }, null, 2));
  else {
    console.log(`since: ${since}`);
    for (const [kind, count] of Object.entries(counts)) console.log(`${kind}: ${count}`);
    if (!hits.length) console.log('hits: 0');
    for (const hit of hits) console.log(`${hit.ts} / ${hit.source} / ${hit.line.slice(0, 200)}`);
  }
}

if (isEntry(import.meta.url)) await main();
