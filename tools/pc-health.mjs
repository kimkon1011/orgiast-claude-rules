#!/usr/bin/env node
// PCごとの利用量・品質・自動化パイプラインを、会話本文を読まずに日次点検する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { collectCodexUsage } from './cost-work-loop.mjs';

const argv = process.argv.slice(2);
const allowed = new Set(['--post', '--json', '--quiet', '--force', '--help', '-h']);
const unknown = argv.filter((arg) => !allowed.has(arg));
if (unknown.length) {
  console.error(`不明な引数: ${unknown.join(' ')}\n使い方: node tools/pc-health.mjs [--post] [--json] [--quiet] [--force]`);
  process.exit(2);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('使い方: node tools/pc-health.mjs [--post] [--json] [--quiet] [--force]');
  process.exit(0);
}

const POST = argv.includes('--post');
const JSON_MODE = argv.includes('--json');
const QUIET = argv.includes('--quiet');
const FORCE = argv.includes('--force');
const DAY = 86_400_000;
const now = Date.now();
const nativeHome = os.homedir();
const HOME = process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || nativeHome;
const CLAUDE = path.join(HOME, '.claude');
// 配布先では未指定で ~/.claude。読取専用サンドボックスから実データ検証する場合だけ保存先を分離できる。
const STATE_DIR = process.env.PC_HEALTH_STATE_DIR || CLAUDE;
const date = new Date(now).toISOString().slice(0, 10);
const hostname = os.hostname();

function walk(dir, accept, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, accept, out);
    else if (accept(entry.name)) out.push(file);
  }
  return out;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function readJsonl(file) {
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function timeOf(value, fallback = 0) {
  const parsed = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function ageDays(ms) { return ms ? Math.max(0, (now - ms) / DAY) : null; }
function pct(value, digits = 1) { return `${(value * 100).toFixed(digits)}%`; }
function countLines(file) { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((x) => x.trim()).length; } catch { return 0; } }
function newest(files) {
  let best = null;
  for (const file of files) { try { const ms = fs.statSync(file).mtimeMs; if (!best || ms > best.ms) best = { file, ms }; } catch {} }
  return best;
}
function statusRank(status) { return status === '🚨' ? 2 : status === '⚠️' ? 1 : 0; }

// usage オブジェクト、モデル名、timestamp 以外には触れない。
async function collectClaude() {
  const since = now - 7 * DAY;
  const byModel = {};
  let outputTokens = 0, cacheRead = 0, cacheWrite = 0, cacheBase = 0;
  const files = walk(path.join(CLAUDE, 'projects'), (name) => name.endsWith('.jsonl'));
  for (const file of files) {
    try { if (fs.statSync(file).mtimeMs < since) continue; } catch { continue; }
    let input; try { input = fs.createReadStream(file, { encoding: 'utf8' }); } catch { continue; }
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"usage"')) continue;
        // transcript本文をオブジェクト化しない。必要なメタデータだけを正規表現で抜く。
        const ts = timeOf(line.match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1]); if (ts && ts < since) continue;
        const usageAt = line.indexOf('"usage"'); if (usageAt < 0) continue;
        const usageRaw = line.slice(usageAt, usageAt + 3000);
        const number = (key) => Number(usageRaw.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`))?.[1]) || 0;
        const model = line.match(/"model"\s*:\s*"([^"]+)"/)?.[1] || 'unknown';
        const out = number('output_tokens');
        outputTokens += out;
        cacheBase += number('input_tokens');
        cacheRead += number('cache_read_input_tokens');
        cacheWrite += number('cache_creation_input_tokens');
        byModel[model] = (byModel[model] || 0) + out;
      }
    } catch { input.destroy(); }
  }
  const cacheTarget = cacheRead + cacheWrite + cacheBase;
  const opusOut = Object.entries(byModel).filter(([m]) => /opus/i.test(m)).reduce((sum, [, n]) => sum + n, 0);
  const fable = Object.entries(byModel).filter(([m]) => /fable/i.test(m)).map(([model, tokens]) => ({ model, tokens }));
  return { outputTokens, byModel, opusRatio: outputTokens ? opusOut / outputTokens : 0, fable, cacheRead, cacheTarget, cacheHitRate: cacheTarget ? cacheRead / cacheTarget : 0 };
}

function collectDelegation(claudeOut) {
  const since = now - 7 * DAY;
  let executorOut = 0;
  for (const row of readJsonl(path.join(CLAUDE, 'executor-usage.jsonl'))) {
    if (timeOf(row.t ?? row.ts ?? row.timestamp) >= since) executorOut += Number(row.out) || 0;
  }
  const { outputTokens: codexOut, sessions: codexSessions } = collectCodexUsage({ home: HOME, days: 7, now });
  const total = claudeOut + executorOut + codexOut;
  return { rate: total ? (executorOut + codexOut) / total : 0, executorOut, codexOut, codexSessions };
}
function collectWork(outputTokens) {
  let commits = 0;
  const repos = (process.env.COST_WORK_REPOS || '').split(path.delimiter).filter(Boolean);
  for (const repo of repos.length ? repos : [process.cwd()]) {
    try {
      const value = execFileSync('git', ['-C', repo, 'rev-list', '--count', '--since=7 days ago', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      commits += Number.parseInt(value.trim(), 10) || 0;
    } catch {}
  }
  return { commits, outputPerCommit: commits ? outputTokens / commits : null };
}
function collectEval() {
  const rows = readJsonl(path.join(CLAUDE, 'eval-results.jsonl'));
  let latest = null, latestMs = 0;
  for (const row of rows) { const ms = timeOf(row.t ?? row.ts ?? row.timestamp); if (ms >= latestMs) { latest = row; latestMs = ms; } }
  return { exists: Boolean(latest), date: latestMs ? new Date(latestMs).toISOString() : null, ageDays: ageDays(latestMs), successRate: typeof latest?.rate === 'number' ? latest.rate : null, provider: latest?.provider ?? null, model: latest?.model ?? null, graded: latest?.graded ?? null };
}
function collectSync() {
  const stateFile = path.join(CLAUDE, '.repo-sync-state.json');
  const state = readJson(stateFile);
  let ms = timeOf(state?.lastSync ?? state?.last ?? state?.updatedAt ?? state?.t ?? state?.timestamp);
  try { if (!ms) ms = fs.statSync(stateFile).mtimeMs; } catch {}
  const expectedRepoPath = process.env.ORGIAST_REPO_PATH || path.join(HOME, 'orgiast-claude-rules');
  return { exists: Boolean(ms), date: ms ? new Date(ms).toISOString() : null, ageDays: ageDays(ms), expectedRepoPath, expectedRepoExists: fs.existsSync(expectedRepoPath) };
}
function collectSyncLog() {
  const file = path.join(CLAUDE, 'hooks', 'onboarding-sync.log');
  let lines = []; try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((x) => x.trim()); } catch {}
  let consecutiveFailures = 0;
  for (let i = lines.length - 1; i >= 0 && /fail(?:ed|ure)?|失敗|error/i.test(lines[i]); i--) consecutiveFailures++;
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch {}
  return { exists: Boolean(lines.length), lastUpdated: mtime ? new Date(mtime).toISOString() : null, consecutiveFailures };
}
function collectBatch() {
  const dir = path.join(CLAUDE, 'batch-queue');
  const pendingFile = path.join(dir, 'pending.jsonl');
  const pending = countLines(pendingFile);
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  const result = newest(names.filter((name) => /^results-.*\.jsonl$/.test(name)).map((name) => path.join(dir, name)));
  return { exists: names.length > 0, pending, lastResult: result ? new Date(result.ms).toISOString() : null, resultAgeDays: ageDays(result?.ms || 0) };
}
function collectHooks() {
  const expected = ['onboarding-sync', 'cost-loop', 'cost-routing-gate', 'claude-cost-reporter', 'tool-adoption-check'];
  let raw = ''; try { raw = fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'); } catch {}
  const missing = expected.filter((name) => !raw.includes(name));
  return { expected, missing };
}
function collectProviders() {
  const expected = {
    Anthropic管理API: ['ANTHROPIC_ADMIN_KEY'], Anthropic実行API: ['ANTHROPIC_API_KEY'], Discord: ['DISCORD_COST_WEBHOOK', 'COST_WEBHOOK'], DeepSeek: ['DEEPSEEK_API_KEY'], Groq: ['GROQ_API_KEY'], Kimi: ['MOONSHOT_API_KEY'], Mistral: ['MISTRAL_API_KEY'], OpenRouter: ['OPENROUTER_API_KEY'], xAI: ['XAI_API_KEY'], Gemini: ['GEMINI_API_KEY'],
  };
  const values = { ...process.env };
  for (const file of [...walk(CLAUDE, (name) => name.endsWith('.env')), path.join(HOME, '.gemini', '.env')]) {
    let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match && match[2].trim()) values[match[1]] = match[2].trim();
    }
  }
  const configured = [], missing = [];
  for (const [provider, keys] of Object.entries(expected)) (keys.some((key) => values[key]) ? configured : missing).push(provider);
  return { configured, missing };
}

const claude = await collectClaude();
const delegation = collectDelegation(claude.outputTokens);
const work = collectWork(claude.outputTokens);
const evaluation = collectEval();
const sync = collectSync();
const syncLog = collectSyncLog();
const batch = collectBatch();
const hooks = collectHooks();
const providers = collectProviders();
const snapshot = { date, outputTokens: claude.outputTokens, delegationRate: delegation.rate, cacheHitRate: claude.cacheHitRate, opusRatio: claude.opusRatio, evalSuccessRate: evaluation.successRate };
const historyFile = path.join(STATE_DIR, 'pc-health-history.jsonl');
const history = readJsonl(historyFile);
const target = now - 7 * DAY;
const comparable = history.filter((row) => timeOf(`${row.date}T00:00:00Z`) <= now - 6 * DAY);
const previous = comparable.sort((a, b) => Math.abs(timeOf(`${a.date}T00:00:00Z`) - target) - Math.abs(timeOf(`${b.date}T00:00:00Z`) - target))[0] || null;

const checks = [];
const add = (id, status, label, detail) => checks.push({ id, status, label, detail });
add('output', '✅', '直近7日のClaude Code出力', `${claude.outputTokens.toLocaleString('ja-JP')} tok`);
add('models', '✅', 'モデル別内訳', Object.entries(claude.byModel).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n.toLocaleString('ja-JP')} tok`).join(' / ') || '利用記録なし');
add('opus', '✅', 'Opus比率', pct(claude.opusRatio));
add('fable', claude.fable.length ? '🚨' : '✅', 'Fable5使用', claude.fable.length ? claude.fable.map((x) => `${x.model} ${x.tokens.toLocaleString('ja-JP')} tok`).join(' / ') : '検出なし');
add('cache', claude.cacheHitRate < .2 ? '🚨' : claude.cacheHitRate < .5 ? '⚠️' : '✅', 'プロンプトキャッシュヒット率', `${pct(claude.cacheHitRate)} (read ${claude.cacheRead.toLocaleString('ja-JP')} / 対象 ${claude.cacheTarget.toLocaleString('ja-JP')} tok)`);
add('delegation', delegation.rate < .1 ? '🚨' : delegation.rate < .3 ? '⚠️' : '✅', '委譲率', `${pct(delegation.rate)} (安いAI ${delegation.executorOut.toLocaleString('ja-JP')} / Codex ${delegation.codexOut.toLocaleString('ja-JP')} tok)`);
add('work', '✅', '作業量あたり出力', work.outputPerCommit === null ? `commit 0件（正規化不可）` : `${Math.round(work.outputPerCommit).toLocaleString('ja-JP')} tok/commit (${work.commits} commits)`);
add('eval', !evaluation.exists || evaluation.ageDays >= 14 ? '⚠️' : '✅', '最新eval', evaluation.exists ? `${pct(evaluation.successRate ?? 0)} / ${evaluation.provider ?? '不明'} ${evaluation.model ?? ''} / ${evaluation.date}${evaluation.ageDays >= 14 ? ' — 品質の裏付けが古い（node tools/eval-harness.mjs --all）' : ''}` : '未実行 — 品質の裏付けが古い（node tools/eval-harness.mjs --all）');
add('sync', !sync.exists || sync.ageDays >= 7 ? '🚨' : sync.ageDays >= 2 ? '⚠️' : '✅', 'repo最終同期', sync.exists ? `${sync.date} (${sync.ageDays.toFixed(1)}日前)` : `repo自動同期が動作していません: ${sync.expectedRepoPath} が${sync.expectedRepoExists ? '存在しますが同期記録を確認できません' : '存在しません'}（このPCは配布物の更新を受け取れていません）`);
add('syncLog', syncLog.consecutiveFailures ? '🚨' : '✅', 'onboarding-syncログ', syncLog.exists ? `末尾の連続失敗 ${syncLog.consecutiveFailures}件 / 更新 ${syncLog.lastUpdated}` : 'ログなし（失敗の連続は未検出）');
add('batch', batch.pending > 0 && (batch.resultAgeDays === null || batch.resultAgeDays >= 3) ? '🚨' : '✅', '夜間バッチ', `pending ${batch.pending}件 / 最終結果 ${batch.lastResult || 'なし'}${batch.pending > 0 && (batch.resultAgeDays === null || batch.resultAgeDays >= 3) ? ' — 夜間バッチが止まっている' : ''}`);
add('hooks', hooks.missing.length ? '⚠️' : '✅', 'hooks登録', hooks.missing.length ? `不足: ${hooks.missing.join(', ')}` : '期待する5フックを確認');
add('providers', '✅', 'プロバイダキー', `設定済み: ${providers.configured.join(', ') || 'なし'} / 未設定: ${providers.missing.join(', ') || 'なし'}`);
if (!previous) add('week', '✅', '前週比', '比較対象なし（初回計測）');
else {
  const changes = [];
  if (previous.outputTokens > 0 && snapshot.outputTokens >= previous.outputTokens * 2) changes.push({ status: '🚨', text: `出力トークンが2倍以上 (${previous.outputTokens.toLocaleString('ja-JP')}→${snapshot.outputTokens.toLocaleString('ja-JP')})。作業量が増えていないのに利用量だけ増えていないか` });
  if (previous.delegationRate > 0 && snapshot.delegationRate <= previous.delegationRate / 2) changes.push({ status: '🚨', text: `委譲率が半減 (${pct(previous.delegationRate)}→${pct(snapshot.delegationRate)})` });
  if (typeof previous.cacheHitRate === 'number' && previous.cacheHitRate - snapshot.cacheHitRate >= .2) changes.push({ status: '🚨', text: `キャッシュヒット率が20ポイント以上低下 (${pct(previous.cacheHitRate)}→${pct(snapshot.cacheHitRate)})。silent invalidator を疑う` });
  if (typeof previous.opusRatio === 'number' && snapshot.opusRatio - previous.opusRatio >= .2) changes.push({ status: '⚠️', text: `Opus比率が20ポイント以上上昇 (${pct(previous.opusRatio)}→${pct(snapshot.opusRatio)})` });
  add('week', changes.reduce((s, x) => statusRank(x.status) > statusRank(s) ? x.status : s, '✅'), '前週比', changes.map((x) => x.text).join(' / ') || `${previous.date} 比で急変なし`);
}

// 同日の再実行は置換し、履歴を無制限に増やさない。
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const kept = history.filter((row) => row.date !== date);
  fs.writeFileSync(historyFile, [...kept, snapshot].map((row) => JSON.stringify(row)).join('\n') + '\n');
} catch {}

const abnormal = checks.some((check) => statusRank(check.status) > 0);
const stateFile = path.join(STATE_DIR, '.pc-health-state.json');
const state = readJson(stateFile) || {};
const elapsed = now - timeOf(state.lastPost ?? state.lastRun);
const postDue = FORCE || !Number.isFinite(elapsed) || elapsed >= DAY;
const postDecision = POST ? (postDue ? '送信対象' : '24時間以内なので送信スキップ') : (postDue ? '送信可能（24時間経過済み）' : '24時間以内なので送信スキップ');
const report = { hostname, date, generatedAt: new Date(now).toISOString(), abnormal, checks, metrics: { claude, delegation, work, evaluation, sync, syncLog, batch, hooks, providers }, comparison: { previous, snapshot }, posting: { requested: POST, force: FORCE, due: postDue, decision: postDecision } };

// 仕様上のガード基準は「最終投稿」ではなく「最終実行」。表示だけの実行も記録する。
try { fs.writeFileSync(stateFile, JSON.stringify({ ...state, lastRun: new Date(now).toISOString(), hostname }, null, 2)); } catch {}

function textReport(compact = false) {
  const head = `【PCヘルス】${hostname} / 集計日 ${date}`;
  if (compact) return `${head}\n${abnormal ? `🚨/⚠️ 異常 ${checks.filter((x) => statusRank(x.status) > 0).length}件` : '✅ 異常なし'}`;
  return [head, ...checks.map((x) => `${x.status} ${x.label}: ${x.detail}`), `投稿判定: ${postDecision}`, '※ 会話内容は読み取らず、集計値とファイル更新時刻だけを使用。'].join('\n');
}

if (POST && postDue) {
  const env = {};
  let raw = ''; try { raw = fs.readFileSync(path.join(CLAUDE, 'cost-reporter.env'), 'utf8'); } catch {}
  for (const line of raw.split(/\r?\n/)) { const match = line.match(/^([^#=]+)=(.*)$/); if (match) env[match[1].trim()] = match[2].trim(); }
  const webhook = env.DISCORD_COST_WEBHOOK || env.COST_WEBHOOK || '';
  if (!webhook) report.posting.error = 'DISCORD_COST_WEBHOOK未設定';
  else {
    try {
      const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: textReport(!abnormal).slice(0, 1950) }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      report.posting.sent = true;
      try { fs.writeFileSync(stateFile, JSON.stringify({ ...state, lastRun: new Date(now).toISOString(), lastPost: new Date(now).toISOString(), hostname }, null, 2)); } catch {}
    } catch (error) { report.posting.error = error.message; }
  }
}

if (!QUIET || abnormal) console.log(JSON_MODE ? JSON.stringify(report, null, 2) : textReport());
if (POST && report.posting.error) { console.error(`Discord送信失敗: ${report.posting.error}`); process.exitCode = 1; }
