#!/usr/bin/env node
// スマホ Claude アプリの「Code」一覧に並ぶ待機セッションを、PC 側の帳簿ではなく
// サーバー側 /v1/code/sessions で数える。不足していれば VSCode のタブを不足分だけ開き、
// 30 秒後に再照会して増えたことを確認する。それでも足りなければ kim に DM する。
//
// 既定は読み取り専用（状態を JSON で出すだけ）。補充は --replenish を付けた時だけ行う。
// purge-sessions.mjs --hook から 6 時間に 1 回 --replenish 付きで起動される。
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
export const COOLDOWN = 6 * HOUR;
export const STANDBY_TITLE = /^remote-control-/;

function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function titleOf(session) { return String(session?.title ?? '').split('\n')[0]; }

// 待機セッション = まだ発言していない枠。使われた瞬間に会話タイトルへ変わる。
export function isStandby(session) {
  return session?.status === 'active'
    && session?.connection_status === 'connected'
    && STANDBY_TITLE.test(titleOf(session));
}

export function summarize(sessions, goal = GOAL) {
  const standbys = sessions.filter(isStandby);
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

export async function checkStandby({ home, fetchImpl = fetch, goal = GOAL } = {}) {
  const listed = await listRemoteSessions({ headers: remoteHeaders(home), fetchImpl });
  if (listed.error === 'no-credentials') return { ...summarize([], goal), error: 'no-credentials' };
  const summary = summarize(listed.sessions, goal);
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

export async function openStandbyTabs({ count, codeCli, spawnProcess = spawn }) {
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
  home, fetchImpl = fetch, goal = GOAL, waitMs = 30_000, now = Date.now,
  spawnProcess = spawn, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notify = notifyKim, codeCli, open = openStandbyTabs, stateFile,
} = {}) {
  const before = await checkStandby({ home, fetchImpl, goal });
  if (before.error) return { action: 'skipped', reason: before.error, before };
  // 健全でも記録する。記録しないと purge-sessions --hook が SessionStart/Stop のたびに起動してしまう。
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ at: now(), standby: before.standby, goal }));
  if (!before.shortfall) return { action: 'none', before };
  const cli = codeCli ?? resolveVscodeCli({ env: process.env, exists: fs.existsSync, homedir: home ?? os.homedir() });
  if (!cli) return { action: 'skipped', reason: 'no-vscode-cli', before };
  let opened;
  try { opened = await open({ count: before.shortfall, codeCli: cli, spawnProcess }); }
  catch (error) { return { action: 'failed', reason: `open failed: ${error.message}`, before }; }
  await sleep(waitMs);
  const after = await checkStandby({ home, fetchImpl, goal });
  if (after.shortfall) {
    const message = `[mobile-standby] 待機セッションが不足しています。目標 ${goal} 本 / 現在 ${after.standby} 本（${after.titles.join(', ') || 'なし'}）。${opened} 本を開きましたが 30 秒後も不足。`;
    const delivery = await notify(message).catch((error) => ({ delivered: 'none', reason: error.message }));
    return { action: 'notified', opened, before, after, delivery };
  }
  return { action: 'replenished', opened, before, after };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const home = io.homedir ?? process.env.ORGIAST_HOME ?? os.homedir();
  const log = io.log ?? console.log;
  let goal = GOAL;
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
