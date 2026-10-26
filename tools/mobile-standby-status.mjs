#!/usr/bin/env node
import pool from './lib/mobile-state.cjs';
// スマホ Claude アプリの「Code」一覧に並ぶ待機セッションを、PC 側の帳簿ではなく
// サーバー側 /v1/code/sessions で数える。不足していれば VSCode のタブを不足分だけ開き、
// 30 秒後に再照会して増えたことを確認する。それでも足りなければ kim に DM する。
//
// 既定は読み取り専用（状態を JSON で出すだけ）。補充は --replenish を付けた時だけ行う。
// purge-sessions.mjs --hook から 1 時間に 1 回 --replenish 付きで起動される（kim への DM は 6 時間に 1 回まで）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { buildVscodeUri, resolveVscodeCli } from './next-session-launch.mjs';
import { notifyKim } from './notify-kim.mjs';

const BASE = 'https://api.anthropic.com';
const HOUR = 3_600_000;
export const GOAL = 2;
export const COOLDOWN = HOUR; // 補充の起動間隔（purge-sessions.mjs 側の間引きも同じ 1 時間）
export const NOTIFY_COOLDOWN = 6 * HOUR; // 同じ不足を DM で何度も知らせない
export const STANDBY_TITLE = /^remote-control-/;
// 現在の自動名は <ホスト名スラッグ>-<形容詞>-<名詞>（例 011-prancy-dusk）。
export const AUTO_TITLE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z]+-[a-z]+$/;

function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function titleOf(session) { return String(session?.title ?? '').split('\n')[0]; }
function stripId(id) { return String(id ?? '').replace(/^(cse_|session_)/, ''); }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// この PC で生きている Claude セッションの bridge 側 id（接頭辞を除く）。
// サーバー側の一覧は同一アカウントの全 PC 分が混ざるので、これで自分の待機枠だけに絞る。
export function localBridgeIds(home = os.homedir(), { isAlive = pidAlive } = {}) {
  const dir = path.join(home, '.claude', 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return new Set(); }
  const ids = new Set();
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match || !isAlive(Number(match[1]))) continue;
    const bridgeSessionId = json(path.join(dir, name)).bridgeSessionId;
    if (bridgeSessionId) ids.add(stripId(bridgeSessionId));
  }
  return ids;
}

// 待機セッション = まだ発言していない枠。使われた瞬間にタイトルが会話名へ変わり context_usage が付く。
// localIds を渡すと、その中の id を持つセッション（= この PC の生存セッション）だけを数える。
export function isStandby(session, { localIds } = {}) {
  if (session?.status !== 'active' || session?.connection_status !== 'connected') return false;
  const title = titleOf(session);
  if (!STANDBY_TITLE.test(title) && !AUTO_TITLE.test(title)) return false;
  if (Number(session?.external_metadata?.context_usage?.used_tokens ?? 0) > 0) return false;
  if (localIds && !localIds.has(stripId(session?.id))) return false;
  return true;
}

export function summarize(sessions, goal = GOAL, { localIds } = {}) {
  const standbys = sessions.filter((session) => isStandby(session, { localIds }));
  return {
    goal,
    standby: standbys.length,
    shortfall: Math.max(0, goal - standbys.length),
    titles: standbys.map(titleOf),
  };
}

export function remoteHeaders(home = os.homedir()) {
  const token = json(path.join(home, '.claude', '.credentials.json')).claudeAiOauth?.accessToken;
  const org = json(path.join(home, '.claude.json')).oauthAccount?.organizationUuid;
  if (!token || !org) return null;
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': org,
  };
}

export async function listRemoteSessions({ headers, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!headers) return { sessions: [], error: 'no-credentials' };
  const sessions = [];
  let cursor = '';
  for (let page = 0; page < 30; page += 1) {
    const query = new URLSearchParams({ limit: '100', ...(cursor && { cursor }) });
    let response;
    try {
      response = await fetchImpl(`${BASE}/v1/code/sessions?${query}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) { return { sessions, error: `list failed: ${error.message}` }; }
    if (!response.ok) return { sessions, error: `list ${response.status}` };
    const body = await response.json();
    const data = body.data ?? [];
    sessions.push(...data);
    if (!body.next_cursor || !data.length) break;
    cursor = body.next_cursor;
  }
  return { sessions };
}

export async function checkStandby({ home, fetchImpl = fetch, goal = GOAL, localIds } = {}) {
  const listed = await listRemoteSessions({ headers: remoteHeaders(home), fetchImpl });
  if (listed.error === 'no-credentials') return { ...summarize([], goal), error: 'no-credentials' };
  const summary = summarize(listed.sessions, goal, { localIds: localIds ?? localBridgeIds(home) });
  return { ...summary, listed: listed.sessions.length, ...(listed.error ? { error: listed.error } : {}) };
}

export function planOpenCommand({ codeCli } = {}) {
  if (!codeCli) return null;
  const uri = buildVscodeUri('');
  return {
    command: 'cmd.exe',
    args: ['/c', `""${codeCli}" --open-url "${uri}""`],
    windowsVerbatimArguments: true,
  };
}

function runPlan(plan, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(plan.command, plan.args, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`VSCode CLI exit ${code}`))));
    child.once('error', reject);
  });
}

export async function openStandbyTabs({ count, codeCli, spawnProcess = spawn, home = os.homedir() }) {
  if (!pool.isMobileEnabled(home)) return 0;
  const plan = planOpenCommand({ codeCli });
  if (!plan) throw new Error('VSCode CLI (code.cmd) が見つかりません');
  let opened = 0;
  for (let index = 0; index < count; index += 1) {
    await runPlan(plan, spawnProcess);
    opened += 1;
  }
  return opened;
}

export async function replenishStandby({
  home, fetchImpl = fetch, goal = GOAL, localIds, waitMs = 30_000, now = Date.now,
  spawnProcess = spawn, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notify = notifyKim, codeCli, open = openStandbyTabs, stateFile,
} = {}) {
  if (!pool.isMobileEnabled(home ?? os.homedir())) return { action: 'skipped', reason: 'disabled' };
  const state = stateFile ? json(stateFile) : {};
  const startedAt = now();
  const before = await checkStandby({ home, fetchImpl, goal, localIds });
  if (before.error) return { action: 'skipped', reason: before.error, before };
  // 健全でも記録する。記録しないと purge-sessions --hook が SessionStart/Stop のたびに起動してしまう。
  // notifiedAt は引き継ぐ（DM の間引きに使う）。
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ ...state, at: startedAt, standby: before.standby, goal }));
  if (!before.shortfall) return { action: 'none', before };
  const cli = codeCli ?? resolveVscodeCli({ env: process.env, exists: fs.existsSync, homedir: home ?? os.homedir() });
  if (!cli) return { action: 'skipped', reason: 'no-vscode-cli', before };
  let opened;
  try { opened = await open({ home, count: before.shortfall, codeCli: cli, spawnProcess }); }
  catch (error) { return { action: 'failed', reason: `open failed: ${error.message}`, before }; }
  await sleep(waitMs);
  const after = await checkStandby({ home, fetchImpl, goal, localIds });
  if (after.shortfall) {
    // 開き直しても戻らない時だけ知らせる。同じ不足で毎時 DM しないよう 6 時間に 1 回まで。
    if (startedAt - (Number(state.notifiedAt) || 0) < NOTIFY_COOLDOWN) {
      return { action: 'shortfall', suppressed: true, opened, before, after };
    }
    const message = `[mobile-standby] 待機セッションが不足しています。目標 ${goal} 本 / 現在 ${after.standby} 本（${after.titles.join(', ') || 'なし'}）。${opened} 本を開きましたが 30 秒後も不足。`;
    const delivery = await notify(message).catch((error) => ({ delivered: 'none', reason: error.message }));
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ ...state, at: startedAt, standby: before.standby, goal, notifiedAt: startedAt }));
    return { action: 'notified', opened, before, after, delivery };
  }
  return { action: 'replenished', opened, before, after };
}

// 目標本数は <home>/.claude/mobile-sessions.json の count（スマホ用に開いておく本数）。
export function defaultGoal(home = os.homedir()) {
  const count = Number(json(path.join(home, '.claude', 'mobile-sessions.json')).count);
  return Number.isInteger(count) && count >= 1 && count <= 10 ? count : GOAL;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const home = io.homedir ?? process.env.ORGIAST_HOME ?? os.homedir();
  const log = io.log ?? console.log;
  let goal = null;
  let replenish = false;
  let waitMs = 30_000;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--replenish') replenish = true;
    else if (value === '--goal') goal = Number(argv[++index]);
    else if (value === '--wait-ms') waitMs = Number(argv[++index]);
    else if (value === '--status') replenish = false;
    else throw new Error(`不明な引数です: ${value}`);
  }
  if (goal === null) goal = defaultGoal(home);
  if (!Number.isInteger(goal) || goal < 1 || goal > 10) throw new Error('--goal は 1..10 の整数で指定してください');
  if (!Number.isInteger(waitMs) || waitMs < 0) throw new Error('--wait-ms は 0 以上の整数で指定してください');

  if (!replenish) {
    const result = await checkStandby({ home, goal });
    log(JSON.stringify(result));
    return result.error ? 1 : 0;
  }
  const result = await replenishStandby({
    home, goal, waitMs, codeCli: io.codeCli, spawnProcess: io.spawn,
    stateFile: path.join(home, '.claude', 'mobile-standby-status-state.json'),
  });
  log(JSON.stringify(result));
  return result.action === 'notified' || result.action === 'failed' ? 1 : 0;
}

if (isEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
