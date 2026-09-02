#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const PREFIX = '[top3-catchup]';
const DEFAULT_REPO = 'kimkon1011/orgiast-weekly-bot';
const DEFAULT_URL = 'http://localhost:3940/secretary/api/top3/ingest';
const DEFAULT_SECRET_FILE = path.join(os.homedir(), 'Downloads', 'secretary-pc', '.env.local');
const HOUR_MS = 60 * 60 * 1000;

export function jstToday(now = new Date()) {
  return new Date(now.getTime() + 9 * HOUR_MS).toISOString().slice(0, 10);
}

export function jstHour(now = new Date()) {
  return new Date(now.getTime() + 9 * HOUR_MS).getUTCHours();
}

export function readLocalTop3(statePath) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    return { asOf: value.asOf ?? null, generatedAt: value.generatedAt ?? null };
  } catch {
    return null;
  }
}

export function parseEnvSecret(envFileText, key) {
  for (const line of envFileText.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== key) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

// 生成の定刻は 07:00/08:00 JST だが、GitHub Actions の schedule は実測で1〜3時間遅延する
// (2026-09-01 は 22:00 UTC 起動予定が 00:58 UTC = 09:58 JST に走った)。定刻直後に「artifact が無い」
// と判断して dispatch すると、遅れて来る本来の run と二重生成になり毎朝2回 Anthropic API を焼く。
// そのため dispatch は遅延の上限を過ぎる DISPATCH_AFTER_JST_HOUR まで待ってから打つ。
export const DISPATCH_AFTER_JST_HOUR = 11;
export const ALARM_AFTER_JST_HOUR = 14;

export function decideAction({ cacheAsOf, targetDay, jstHour: hour, artifactDay, dispatchCountToday, allowDispatch }) {
  if (cacheAsOf === targetDay) return { action: 'noop', reason: `${targetDay} のTOP3はローカルに到着済みです` };
  if (artifactDay === targetDay) return { action: 'ingest', reason: `${targetDay} のartifactを発見したためローカルへ投入します` };
  if (hour < DISPATCH_AFTER_JST_HOUR) return { action: 'wait', reason: `${targetDay} のartifactはまだ無く、schedule実行の遅延を待つ時間帯です（${DISPATCH_AFTER_JST_HOUR}時JSTまで待機）` };
  if (allowDispatch && dispatchCountToday < 2) return { action: 'dispatch', reason: `${targetDay} のartifactが${DISPATCH_AFTER_JST_HOUR}時JSTを過ぎても無いためworkflow_dispatchを実行します（本日${dispatchCountToday + 1}回目）` };
  if (hour >= ALARM_AFTER_JST_HOUR) return { action: 'alarm', reason: `${targetDay} のartifactが${ALARM_AFTER_JST_HOUR}時JSTを過ぎても無く、dispatchも打ち止めです` };
  return { action: 'wait', reason: `${targetDay} のartifactはまだ無く、dispatch済みの生成完了を待っています` };
}

function log(message) {
  console.log(`${PREFIX} ${message}`);
}

function fail(message) {
  console.error(`${PREFIX} error: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    noDispatch: false,
    repo: DEFAULT_REPO,
    statePath: path.join(os.homedir(), '.claude', 'secretary-state', 'top3.json'),
    url: process.env.TOP3_CATCHUP_URL || DEFAULT_URL,
    secretFile: process.env.TOP3_CATCHUP_SECRET_FILE || DEFAULT_SECRET_FILE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-dispatch') options.noDispatch = true;
    else if (['--repo', '--state-path', '--url', '--secret-file'].includes(arg)) {
      if (!argv[i + 1]) throw new Error(`${arg} には値が必要です`);
      const key = { '--repo': 'repo', '--state-path': 'statePath', '--url': 'url', '--secret-file': 'secretFile' }[arg];
      options[key] = argv[++i];
    } else throw new Error(`不明な引数です: ${arg}`);
  }
  return options;
}

function runGh(args) {
  return spawnSync('gh', args, { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

function findFiles(root, basename) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(fullPath, basename));
    else if (entry.isFile() && entry.name === basename) found.push(fullPath);
  }
  return found;
}

function readDispatchCount(statePath, targetDay) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const count = state?.[targetDay]?.dispatches;
    return Number.isInteger(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

function recordDispatch(statePath, targetDay, now) {
  let state = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch { }
  const previous = Number.isInteger(state?.[targetDay]?.dispatches) ? state[targetDay].dispatches : 0;
  state[targetDay] = { dispatches: previous + 1, lastAt: now.toISOString() };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function resolveSecret(options) {
  if (process.env.TOP3_INGEST_SECRET) return process.env.TOP3_INGEST_SECRET;
  try {
    return parseEnvSecret(fs.readFileSync(options.secretFile, 'utf8'), 'TOP3_INGEST_SECRET');
  } catch {
    return null;
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { fail(error.message); return; }

  const now = new Date();
  const targetDay = jstToday(now);
  const hour = jstHour(now);
  const cache = readLocalTop3(options.statePath);
  log(`対象日=${targetDay} JST時=${hour} cache.asOf=${cache?.asOf ?? 'なし'} state=${options.statePath}`);
  if (cache?.asOf === targetDay) {
    const decision = decideAction({ cacheAsOf: cache.asOf, targetDay, jstHour: hour, artifactDay: null, dispatchCountToday: 0, allowDispatch: !options.noDispatch });
    log(`${decision.action}: ${decision.reason}`);
    return;
  }

  const listResult = runGh(['run', 'list', '--repo', options.repo, '--workflow', 'daily-top3.yml', '--limit', '15', '--json', 'databaseId,createdAt,conclusion,status']);
  if (listResult.error) { fail(`gh を実行できません: ${listResult.error.message}`); return; }
  if (listResult.status !== 0) { fail(`gh run list が失敗しました (exit ${listResult.status}): ${(listResult.stderr || '').trim()}`); return; }

  let listedRuns;
  try { listedRuns = JSON.parse(listResult.stdout); } catch (error) { fail(`gh run list のJSONを解釈できません: ${error.message}`); return; }
  if (!Array.isArray(listedRuns)) { fail('gh run list の結果が配列ではありません'); return; }
  const oldest = now.getTime() - 36 * HOUR_MS;
  const runs = listedRuns
    .filter((run) => run?.status === 'completed' && Number.isFinite(Date.parse(run.createdAt)) && Date.parse(run.createdAt) >= oldest && Date.parse(run.createdAt) <= now.getTime())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 5);
  log(`completed run候補=${runs.length}（直近36時間・最大5件）`);

  let artifact = null;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'top3-catchup-'));
  try {
    for (const run of runs) {
      log(`run id=${run.databaseId} createdAt=${run.createdAt} conclusion=${run.conclusion ?? '不明'} を確認`);
      const runDir = path.join(tmpdir, String(run.databaseId));
      fs.mkdirSync(runDir);
      const download = runGh(['run', 'download', String(run.databaseId), '--repo', options.repo, '--dir', runDir]);
      if (download.error || download.status !== 0) {
        log(`run id=${run.databaseId} のdownload失敗: ${download.error?.message || (download.stderr || '').trim() || `exit ${download.status}`}`);
        continue;
      }
      for (const candidate of findFiles(runDir, 'top3.json')) {
        try {
          const raw = fs.readFileSync(candidate, 'utf8');
          const parsed = JSON.parse(raw);
          log(`run id=${run.databaseId} artifact=${candidate} asOf=${parsed?.asOf ?? 'なし'}`);
          if (parsed?.asOf === targetDay) { artifact = { raw, parsed, run }; break; }
        } catch (error) {
          log(`run id=${run.databaseId} のtop3.jsonを読めません: ${error.message}`);
        }
      }
      if (artifact) break;
    }

    const dispatchStatePath = path.join(path.dirname(options.statePath), 'top3-catchup.json');
    const dispatchCountToday = readDispatchCount(dispatchStatePath, targetDay);
    const decision = decideAction({ cacheAsOf: cache?.asOf ?? null, targetDay, jstHour: hour, artifactDay: artifact?.parsed?.asOf ?? null, dispatchCountToday, allowDispatch: !options.noDispatch });
    log(`decision=${decision.action}: ${decision.reason}`);
    if (options.dryRun) { log(`dry-run: ${decision.action} は実行しません`); return; }

    if (decision.action === 'ingest') {
      const secret = resolveSecret(options);
      if (!secret) { fail(`TOP3_INGEST_SECRET を環境変数または ${options.secretFile} から取得できません`); return; }
      let response;
      try {
        response = await fetch(options.url, { method: 'POST', headers: { 'x-top3-secret': secret, 'content-type': 'application/json' }, body: artifact.raw, signal: AbortSignal.timeout(30_000) });
      } catch (error) { fail(`POST に失敗しました: ${error.message}`); return; }
      const responseText = await response.text();
      log(`POST status=${response.status}`);
      if (!response.ok) { fail(`POST が非2xxでした: status=${response.status} response=${responseText.slice(0, 200)}`); return; }
      const readBack = readLocalTop3(options.statePath);
      log(`read-back state.asOf=${readBack?.asOf ?? 'なし'} generatedAt=${readBack?.generatedAt ?? 'なし'}`);
      if (readBack?.asOf !== targetDay) { fail(`POST は2xxでしたが反映されていません（期待=${targetDay}, 実際=${readBack?.asOf ?? 'なし'}）`); return; }
      log(`ingest完了: run id=${artifact.run.databaseId} の ${targetDay} を反映しました`);
      return;
    }
    if (decision.action === 'dispatch') {
      const dispatch = runGh(['workflow', 'run', 'daily-top3.yml', '--repo', options.repo]);
      if (dispatch.error) { fail(`gh workflow run を実行できません: ${dispatch.error.message}`); return; }
      if (dispatch.status !== 0) { fail(`gh workflow run が失敗しました (exit ${dispatch.status}): ${(dispatch.stderr || '').trim()}`); return; }
      recordDispatch(dispatchStatePath, targetDay, now);
      log(`dispatch完了: ${targetDay} の記録を ${dispatchStatePath} に保存しました`);
      return;
    }
    if (decision.action === 'alarm') fail(decision.reason);
    else log(`${decision.action}: ${decision.reason}`);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

if (isEntry(import.meta.url)) main().catch((error) => fail(`予期しないエラー: ${error.stack || error.message}`));
