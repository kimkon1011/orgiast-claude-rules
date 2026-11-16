#!/usr/bin/env node
// tools/cache-warm-audit.mjs
// X-0024 キャッシュ漏れ監査 CLI:
// ~/.claude/projects 配下のセッション JSONL を読み、1セッション内でプロンプトキャッシュが
// 漏れた箇所（モデル切替・コンパクト・冷え・キャッシュ再構築）を機械的に洗い出す。
//
// 単価（2026-11 時点の Sonnet 系目安。実単価が違う場合は env で渡す）:
//   CLAUDE_INPUT_USD_PER_M        (既定 3)
//   CLAUDE_CACHE_READ_USD_PER_M   (既定 0.3)
//   CLAUDE_CACHE_WRITE_USD_PER_M  (既定 3.75)
//   CLAUDE_OUTPUT_USD_PER_M       (既定 15)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

// ---------- 単価（env 上書き可） ----------
function envNum(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

const RATES = {
  input: envNum('CLAUDE_INPUT_USD_PER_M', 3),
  cacheRead: envNum('CLAUDE_CACHE_READ_USD_PER_M', 0.3),
  cacheWrite: envNum('CLAUDE_CACHE_WRITE_USD_PER_M', 3.75),
  output: envNum('CLAUDE_OUTPUT_USD_PER_M', 15),
};

const FLAG_ORDER = ['MODEL_SWITCH', 'SWITCH_CACHE_LOSS', 'COLD_START_LOOP', 'LOW_HIT', 'COMPACT', 'COMPACT_RECACHE'];

// ---------- コンパクト境界の判定（実データ両対応・判定関数は分離） ----------
// 行に "isCompactSummary":true がある、または subtype/type に "compact" を含む。
export function isCompactBoundary(rawLine, parsed) {
  if (
    typeof rawLine === 'string' &&
    (rawLine.includes('"isCompactSummary":true') || rawLine.includes('"subtype":"compact"'))
  ) {
    return true;
  }
  if (parsed) {
    if (typeof parsed.subtype === 'string' && parsed.subtype.includes('compact')) return true;
    if (typeof parsed.type === 'string' && parsed.type.includes('compact')) return true;
  }
  return false;
}

// 合成プレースホルダのモデル名かどうか（コンパクト要約等、message.model が "<synthetic>" になる行）。
// プレースホルダは「モデル不明」として扱い、models にも modelSwitches にも数えない。
export function isPlaceholderModel(model) {
  if (typeof model !== 'string' || model === '') return false;
  return (model.startsWith('<') && model.endsWith('>')) || /synthetic/i.test(model);
}

// 切替行の直前/直後3アシスタント行の平均ヒット率（実 usage のある行のみ・プレースホルダ行は除外）。
function hitRatesAround(ass, idx) {
  const mean = (xs) => (xs.length ? xs.reduce((s, r) => s + r, 0) / xs.length : null);
  const before = [];
  const after = [];
  for (let i = idx - 1; i >= 0 && before.length < 3; i--) {
    if (isPlaceholderModel(ass[i].model)) continue;
    before.push(ass[i]);
  }
  for (let i = idx + 1; i < ass.length && after.length < 3; i++) {
    if (isPlaceholderModel(ass[i].model)) continue;
    after.push(ass[i]);
  }
  return {
    beforeHitRate: mean(before.map(rowRate).filter((r) => r !== null)),
    afterHitRate: mean(after.map(rowRate).filter((r) => r !== null)),
  };
}

// 1行分のアシスタントターンのキャッシュヒット率（分母 0 なら null）
function rowRate(info) {
  const u = info.usage;
  if (!u) return null;
  const cr = u.cache_read_input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const in_ = u.input_tokens || 0;
  const d = cr + cw + in_;
  return d > 0 ? cr / d : null;
}

// セッション JSONL 1ファイルを解析し、指標オブジェクトを返す。
// 読み込み失敗時は null。壊れた行はスキップして badLines に数える（例外で落とさない）。
export function analyzeJsonl(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  let badLines = 0;
  const infos = []; // {sid, timestamp, isAssistant, isCompact, model, usage}

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      badLines++;
      continue;
    }
    const isCompact = isCompactBoundary(raw, obj);
    const isAssistant = obj.type === 'assistant';
    infos.push({
      sid: typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : null,
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
      isAssistant,
      isCompact,
      model: isAssistant && obj.message && typeof obj.message.model === 'string' ? obj.message.model : null,
      usage: isAssistant && obj.message && obj.message.usage ? obj.message.usage : null,
    });
  }

  const sessionId = (infos.find((x) => x.sid)?.sid) || path.basename(filePath, path.extname(filePath));

  // タイムスタンプの最小・最大
  let startedAt = null;
  let endedAt = null;
  for (const x of infos) {
    if (!x.timestamp) continue;
    const t = new Date(x.timestamp);
    if (Number.isNaN(t.getTime())) continue;
    const iso = t.toISOString();
    if (startedAt === null || iso < startedAt) startedAt = iso;
    if (endedAt === null || iso > endedAt) endedAt = iso;
  }

  const ass = infos.filter((x) => x.isAssistant);
  const turns = ass.length;

  const models = [
    ...new Set(
      ass
        .map((a) => a.model)
        .filter(Boolean)
        .filter((m) => !isPlaceholderModel(m)),
    ),
  ];

  // モデル切替: 直前の実モデルから変わった回数。プレースホルダ（<synthetic> 等）はモデルとして
  // 扱わず、直前の実モデルを維持する（A → synthetic → A は切替0、A → synthetic → B は A→B の1回）。
  // events に from/to・位置・前後3ターンの平均ヒット率と下落フラグを残す。
  let modelSwitches = 0;
  const events = [];
  let prevModel = null;
  ass.forEach((a, idx) => {
    const m = a.model;
    if (!m || isPlaceholderModel(m)) return; // 合成プレースホルダは数えない
    if (prevModel !== null && prevModel !== m) {
      modelSwitches++;
      const { beforeHitRate, afterHitRate } = hitRatesAround(ass, idx);
      events.push({
        at: idx,
        from: prevModel,
        to: m,
        beforeHitRate,
        afterHitRate,
        hitDrop:
          beforeHitRate !== null && afterHitRate !== null && afterHitRate < beforeHitRate - 0.3,
      });
    }
    prevModel = m;
  });

  const sumU = (key) => ass.reduce((s, a) => s + (typeof (a.usage && a.usage[key]) === 'number' ? a.usage[key] : 0), 0);
  const inputTokens = sumU('input_tokens');
  const cacheReadTokens = sumU('cache_read_input_tokens');
  const cacheWriteTokens = sumU('cache_creation_input_tokens');
  const outputTokens = sumU('output_tokens');

  const denom = cacheReadTokens + cacheWriteTokens + inputTokens;
  const hitRate = denom > 0 ? cacheReadTokens / denom : null;

  // 全トークンを非キャッシュ入力として数えた場合の想定費用との差 = 削減額
  const estCostUsd =
    (inputTokens * RATES.input +
      cacheReadTokens * RATES.cacheRead +
      cacheWriteTokens * RATES.cacheWrite +
      outputTokens * RATES.output) /
    1e6;
  const estCostNoCacheUsd =
    ((inputTokens + cacheReadTokens + cacheWriteTokens) * RATES.input + outputTokens * RATES.output) / 1e6;
  const savedUsd = estCostNoCacheUsd - estCostUsd;

  const compactions = infos.filter((x) => x.isCompact).length;

  // COMPACT_RECACHE: コンパクト後に cacheWrite が増え、直後3ターンのヒット率が直前3ターンより下がった
  let compactRecache = false;
  const compactPos = infos.map((x, i) => (x.isCompact ? i : -1)).filter((i) => i >= 0);
  for (const ci of compactPos) {
    const before = [];
    const after = [];
    for (let i = ci - 1; i >= 0 && before.length < 3; i--) if (infos[i].isAssistant) before.unshift(infos[i]);
    for (let i = ci + 1; i < infos.length && after.length < 3; i++) if (infos[i].isAssistant) after.push(infos[i]);
    const bRates = before.map(rowRate).filter((r) => r !== null);
    const aRates = after.map(rowRate).filter((r) => r !== null);
    if (bRates.length === 0 || aRates.length === 0) continue;
    const avg = (xs) => xs.reduce((s, r) => s + r, 0) / xs.length;
    const bCw = before.reduce((s, x) => s + (x.usage?.cache_creation_input_tokens || 0), 0);
    const aCw = after.reduce((s, x) => s + (x.usage?.cache_creation_input_tokens || 0), 0);
    if (aCw > bCw && avg(aRates) < avg(bRates)) {
      compactRecache = true;
      break;
    }
  }

  const flags = [];
  if (modelSwitches >= 1) flags.push('MODEL_SWITCH');
  if (events.some((e) => e.hitDrop)) flags.push('SWITCH_CACHE_LOSS');
  if (cacheWriteTokens >= 50000 && hitRate !== null && hitRate < 0.2 && turns >= 3) flags.push('COLD_START_LOOP');
  if (turns >= 5 && hitRate !== null && hitRate < 0.5) flags.push('LOW_HIT');
  if (compactions >= 1) flags.push('COMPACT');
  if (compactRecache) flags.push('COMPACT_RECACHE');

  return {
    file: filePath,
    sessionId,
    startedAt,
    endedAt,
    turns,
    models,
    modelSwitches,
    events,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    hitRate,
    estCostUsd,
    estCostNoCacheUsd,
    savedUsd,
    compactions,
    flags,
    badLines,
  };
}

// ---------- ディレクトリ走査 ----------
function collectJsonl(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectJsonl(p, acc);
    else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

// --dir 配下を再帰的に *.jsonl 探索し、--since / --min-turns で絞ったセッション配列を返す。
export function scanDir(dir, { since = null, minTurns = 1 } = {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const f of collectJsonl(dir)) {
    const s = analyzeJsonl(f);
    if (!s) continue;
    let startTs;
    try {
      startTs = new Date(s.startedAt || fs.statSync(f).mtime);
    } catch {
      startTs = null;
    }
    if (since && startTs && !Number.isNaN(startTs.getTime()) && startTs < since) continue;
    if (s.turns < minTurns) continue;
    out.push(s);
  }
  return out;
}

// ---------- CLI ----------
function parseSince(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseArgs(argv) {
  const opts = {
    dir: path.join(os.homedir(), '.claude', 'projects'),
    since: null,
    top: 10,
    json: false,
    minTurns: 1,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dir':
        if (i + 1 < argv.length) opts.dir = argv[++i];
        break;
      case '--since':
        if (i + 1 < argv.length) opts.since = argv[++i];
        break;
      case '--top': {
        const n = parseInt(argv[i + 1] ?? '', 10);
        if (Number.isFinite(n)) {
          opts.top = n;
          i++;
        }
        break;
      }
      case '--min-turns': {
        const n = parseInt(argv[i + 1] ?? '', 10);
        if (Number.isFinite(n)) {
          opts.minTurns = n;
          i++;
        }
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--help':
        opts.help = true;
        break;
      default:
        break; // 未知の引数は無視
    }
  }
  return opts;
}

function printUsage(stream) {
  stream.write(
    [
      '使い方: node tools/cache-warm-audit.mjs [options]',
      '',
      '  セッション JSONL を解析し、プロンプトキャッシュのヒット率・想定費用・漏れフラグを出力する。',
      '',
      '  --dir <path>        対象ディレクトリ（既定: ~/.claude/projects、配下を再帰探索）',
      '  --since YYYY-MM-DD  開始日（startedAt、無ければファイルmtime）で絞る',
      '  --top N             表示するセッション数（既定 10、削減額の大きい順）',
      '  --json              機械可読 JSON で出力',
      '  --min-turns N       ターン数（assistant 行数）の下限（既定 1）',
      '  --help              このヘルプを表示して終了',
      '',
      '単価は環境変数で上書き可: CLAUDE_INPUT_USD_PER_M / CLAUDE_CACHE_READ_USD_PER_M /',
      'CLAUDE_CACHE_WRITE_USD_PER_M / CLAUDE_OUTPUT_USD_PER_M（2026-11 時点の Sonnet 系目安）。',
      '',
    ].join('\n'),
  );
}

function renderText(shown) {
  if (shown.length === 0) {
    process.stdout.write('対象なし\n');
    return;
  }
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const header = ['セッションID', '開始', 'ターン', 'モデル', 'ヒット率', '想定費用$', '削減額$', 'フラグ'];
  const rows = [header];
  for (const s of shown) {
    rows.push([
      clip(s.sessionId, 24),
      s.startedAt ? s.startedAt.slice(0, 16).replace('T', ' ') : '-',
      String(s.turns),
      clip(s.models.join(','), 16),
      s.hitRate === null ? '-' : (s.hitRate * 100).toFixed(1) + '%',
      s.estCostUsd.toFixed(3),
      s.savedUsd.toFixed(3),
      s.flags.length ? s.flags.join(',') : '-',
    ]);
  }
  const widths = rows[0].map((_, ci) => Math.max(...rows.map((r) => r[ci].length)));
  for (const r of rows) {
    process.stdout.write(r.map((c, ci) => c.padEnd(widths[ci])).join('  ') + '\n');
  }

  const n = shown.length;
  const totCr = shown.reduce((s, x) => s + x.cacheReadTokens, 0);
  const totCw = shown.reduce((s, x) => s + x.cacheWriteTokens, 0);
  const totIn = shown.reduce((s, x) => s + x.inputTokens, 0);
  const totDenom = totCr + totCw + totIn;
  const totHit = totDenom > 0 ? totCr / totDenom : null;
  const totSaved = shown.reduce((s, x) => s + x.savedUsd, 0);
  const flagCounts = {};
  for (const s of shown) for (const f of s.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;

  process.stdout.write('\n--- 合計（表示 ' + n + ' セッション）---\n');
  process.stdout.write('合計ヒット率: ' + (totHit === null ? '-' : (totHit * 100).toFixed(1) + '%') + '\n');
  process.stdout.write('合計削減額: $' + totSaved.toFixed(2) + '\n');
  process.stdout.write(
    'フラグ別件数: ' + FLAG_ORDER.map((f) => f + ': ' + (flagCounts[f] || 0)).join('  ') + '\n',
  );
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printUsage(process.stdout);
    return 0;
  }
  const since = opts.since ? parseSince(opts.since) : null;
  if (opts.since && !since) process.stderr.write('--since の形式が不正です（YYYY-MM-DD）。絞り込みをスキップします。\n');

  let sessions;
  try {
    sessions = scanDir(opts.dir, { since, minTurns: opts.minTurns });
  } catch {
    sessions = [];
  }
  sessions.sort((a, b) => (b.savedUsd ?? 0) - (a.savedUsd ?? 0));
  const shown = sessions.slice(0, opts.top);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), dir: opts.dir, sessions: shown }, null, 2) + '\n');
  } else if (shown.length === 0) {
    process.stdout.write('対象なし\n');
  } else {
    renderText(shown);
  }
  return 0;
}

// 直接実行されたときだけ main を走らせる（テストから import しても副作用なし）
// junction/symlink 越しの起動でも判定できるよう、素の URL 比較ではなく isEntry を使う。
if (isEntry(import.meta.url)) {
  process.exitCode = main();
}