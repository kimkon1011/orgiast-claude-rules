#!/usr/bin/env node
// routing-table.mjs — eval-harness の実測(~/.claude/eval-results.jsonl)から、カテゴリ別に
// 「成功率≥90% を満たす中で最安(同率なら最速)」のプロバイダ/モデルを選び tools/routing-table.json に書く。
// 1回しか計測が無いカテゴリは provisional:true で載せる(成功可否の信頼度が低いため、文言を「暫定」にする)。
// cost-routing-gate.mjs / llm-fallback.mjs(経由 llm-ask.mjs) がこの表を読み、実測値付きでルーティングを出す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROUTING_CATEGORIES = Object.freeze(['classification', 'extraction', 'summarize', 'jp_reply', 'code']);

function userHome() {
  const h = os.homedir();
  const m = process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i);
  return process.env.USERPROFILE || m?.[1] || h;
}
const HOME = userHome();
export const DEFAULT_RESULTS = path.join(HOME, '.claude', 'eval-results.jsonl');
export function routingTableFile(dir = HERE) { return path.join(dir, 'routing-table.json'); }

function readJsonl(file) {
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  return out;
}

// カテゴリ別に使える実測を、プロバイダ/モデル×カテゴリで「直近2回」まで集計する。
export function aggregateMeasurements(rows, category) {
  const byCandidate = new Map();
  for (const record of rows) {
    const cat = record?.byCategory?.[category];
    if (!cat) continue;
    const graded = Number(cat.graded) || 0;
    if (graded <= 0) continue;
    // 記録全体が計測不能(エラー+切断が1割超)の回は、このカテゴリの成功可否の根拠にしない。
    const n = Number(cat.n) || 0;
    const unstable = n > 0 && ((Number(cat.errors) || 0) + (Number(cat.truncated) || 0)) / n > 0.1;
    if (unstable) continue;
    const key = `${record.provider}#${record.model}`;
    if (!byCandidate.has(key)) byCandidate.set(key, { provider: record.provider, model: record.model, measurements: [] });
    byCandidate.get(key).measurements.push({
      t: record.t,
      pass: Number(cat.pass) || 0,
      graded,
      n,
      costUsd: Number(cat.costUsd) || 0,
      msAvg: Number(record.msAvg) || 0,
    });
  }
  const out = [];
  for (const { provider, model, measurements } of byCandidate.values()) {
    const sorted = measurements.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const latest = sorted.slice(-2); // 直近2回の計測で判定
    const samples = latest.length;
    const pass = latest.reduce((s, x) => s + x.pass, 0);
    const graded = latest.reduce((s, x) => s + x.graded, 0);
    const totalN = latest.reduce((s, x) => s + x.n, 0);
    const rate = graded ? pass / graded : null;
    if (rate === null) continue;
    out.push({
      provider,
      model,
      samples,
      rate,
      usdPerTask: totalN ? latest.reduce((s, x) => s + x.costUsd, 0) / totalN : null,
      msAvg: totalN ? latest.reduce((s, x) => s + x.msAvg * x.n, 0) / totalN : null,
      measuredAt: latest[samples - 1].t,
    });
  }
  return out;
}

// カテゴリごとに「成功率≥90% を満たす中で最安(同率なら最速)」を選ぶ。
// 1回しか計測が無い候補しか無い場合は provisional:true で最安を採用。90%に届く候補が無ければ載せない。
export function buildRoutingTable(rows, { now = new Date() } = {}) {
  const categories = {};
  for (const category of ROUTING_CATEGORIES) {
    const candidates = aggregateMeasurements(rows, category).filter((x) => x.rate >= 0.9 && x.usdPerTask != null);
    if (!candidates.length) continue;
    const strong = candidates.filter((x) => x.samples >= 2);
    const pool = strong.length ? strong : candidates;
    const provisional = strong.length === 0;
    const chosen = [...pool].sort((a, b) => a.usdPerTask - b.usdPerTask || a.msAvg - b.msAvg || a.samples - b.samples)[0];
    const entry = {
      provider: chosen.provider,
      model: chosen.model,
      rate: Number(chosen.rate.toFixed(4)),
      usdPerTask: Number(chosen.usdPerTask.toFixed(8)),
      msAvg: Math.round(chosen.msAvg || 0),
      measuredAt: chosen.measuredAt,
      samples: chosen.samples,
    };
    if (provisional) entry.provisional = true;
    categories[category] = entry;
  }
  return { builtAt: new Date(now).toISOString(), categories };
}

export function rebuildRoutingTable({ resultsFile = DEFAULT_RESULTS, outFile = routingTableFile(), now = new Date() } = {}) {
  const rows = readJsonl(resultsFile);
  const table = buildRoutingTable(rows, { now });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  for (const [category, entry] of Object.entries(table.categories)) {
    const provisional = entry.provisional ? ' (暫定・計測1回)' : '';
    console.log(`カテゴリ ${category}: ${entry.provider}/${entry.model} / 成功率 ${(entry.rate * 100).toFixed(0)}% / $${entry.usdPerTask}/task / ${entry.msAvg}ms / n=${entry.samples}${provisional}`);
  }
  const missing = ROUTING_CATEGORIES.filter((c) => !table.categories[c]);
  if (missing.length) console.log(`載せなかったカテゴリ(成功率90%未満/データ不足): ${missing.join(', ')}`);
  return table;
}

// 週次改善の自動適用(許可リスト)用: ~/.claude/routing-overrides.json の demote を操作する。
// provider を --days N(既定3)だけ連鎖の末尾へ回す(demote)/demote を解除する(promote)。
function routingOverridesFile(claudeDir) {
  return path.join(claudeDir, 'routing-overrides.json');
}
export function applyRoutingDemote({ claudeDir, provider, days = 3, now = new Date() }) {
  const name = String(provider || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`不正なprovider名: ${provider}`);
  const file = routingOverridesFile(claudeDir);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  if (!state.demote || typeof state.demote !== 'object' || Array.isArray(state.demote)) state.demote = {};
  const until = new Date(new Date(now).getTime() + Number(days) * 86400000).toISOString();
  const changed = state.demote[name] !== until;
  state.demote[name] = until;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { file, provider: name, until, changed };
}
export function applyRoutingPromote({ claudeDir, provider }) {
  const name = String(provider || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`不正なprovider名: ${provider}`);
  const file = routingOverridesFile(claudeDir);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  if (!state.demote || typeof state.demote !== 'object' || Array.isArray(state.demote)) state.demote = {};
  const changed = Object.prototype.hasOwnProperty.call(state.demote, name);
  delete state.demote[name];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { file, provider: name, changed };
}

export async function main(argv = process.argv.slice(2)) {
  const rebuild = argv.includes('--rebuild');
  const home = process.env.ORGIAST_HOME || userHome();
  const claudeDir = path.join(home, '.claude');
  const demoteIndex = argv.indexOf('--demote');
  const promoteIndex = argv.indexOf('--promote');
  if (demoteIndex >= 0) {
    const provider = argv[demoteIndex + 1];
    const daysArgIndex = argv.indexOf('--days');
    const days = daysArgIndex >= 0 ? Number(argv[daysArgIndex + 1]) : 3;
    if (!provider || !Number.isFinite(days) || days < 0) { console.error('使い方: node tools/routing-table.mjs --demote <provider> --days <N>'); return 2; }
    const result = applyRoutingDemote({ claudeDir, provider, days });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (promoteIndex >= 0) {
    const provider = argv[promoteIndex + 1];
    if (!provider) { console.error('使い方: node tools/routing-table.mjs --promote <provider>'); return 2; }
    const result = applyRoutingPromote({ claudeDir, provider });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (!rebuild) {
    console.error('使い方: node tools/routing-table.mjs --rebuild / --demote <provider> --days <N> / --promote <provider>  (eval-results.jsonl から tools/routing-table.json を再生成)');
    return 2;
  }
  rebuildRoutingTable();
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
