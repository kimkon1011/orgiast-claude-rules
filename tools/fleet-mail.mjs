#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { machineIdentity } from './machine-identity.mjs';
import { addDecision, listDecisions } from './pending-decisions.mjs';
import { loadOptin, redactSecrets, consentCommand, validExecCwd, truncateAnswer } from './fleet-agent.mjs';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';
import { relayQuestions, readQuestion, clearResume, reconcileResumes, collectQuestions, validSessionId, RESUME_LIMIT_MS } from './fleet-question-relay.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { LANE_HEALTH_KIM_PC, parseLaneDoctorOutput, deadLanes, repairAdvice, laneHealthSignature, buildLaneHealthMail } from './lib/lane-health.mjs';
import { dailyRuleCompliance } from './fleet-rule-compliance-daily.mjs';
import { appendAfterFromEnv } from './growi-manual.mjs';
export { resolveFleetLabel, dailyRuleCompliance };

const ownRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
// 宛先の最終 poll 表示用（fleet-status.mjs と同じ JST 表記・経過時間表記）。
function jstShort(ms) {
  const date = new Date(ms + JST_OFFSET_MS);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
function formatAge(ms) {
  if (ms === null || !Number.isFinite(ms)) return '不明';
  if (ms < 60 * 60 * 1000) return `${Math.max(0, Math.round(ms / 60000))}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}
const decisionPrefix = /^\s*\[判断依頼\]/;
export function decisionRole(mail) {
  // 返信（mail-reply-* / replyTo あり）は原本の why を引き継ぐので依頼(request)ではなく回答(answer)として扱う。
  // 回答は捨てずに注入するが返信はしない（fleet-inbox-context が [回答・返信不要] を付ける）。
  // 扱うと受領返信に相手が受領返信を返し、2分ごとに PC 間で無限に往復する（2026-10-10 kim-PC⇔cr-PC 実測）。
  if (!decisionPrefix.test(parseExecMarkers(mail?.body).body) && !/\[判断依頼\]/.test(mail?.why ?? '')) return null;
  return mail?.replyTo || String(mail?.id ?? '').startsWith('mail-reply-') ? 'answer' : 'request';
}
export function hasDecisionRequest(mail) {
  return decisionRole(mail) === 'request';
}
// Shared arrival/presentation classification. Replies never become inherited requests.
export function mailCategory(mail) {
  if (mail?.replyTo || String(mail?.id || '').startsWith('mail-reply-') || /\[(?:回答|報告)(?:・返信不要)?\]/.test(mail?.why || '') || /^\s*\[(?:回答|報告)(?:・返信不要)?\]/.test(mail?.body || '')) return 2;
  if (hasDecisionRequest(mail)) return 0;
  if (mail?.priority === 'urgent' || /\[作業依頼\]/.test(mail?.why || '') || /^\s*\[作業依頼\]/.test(mail?.body || '')) return 1;
  return 3;
}
// 本文先頭の実行モードマーカー（送信側 --exec が挿入する）。GAS は messageKind を prompt のまま扱う。
export const EXEC_KINDS = Object.freeze(['codex', 'claude']);
const execMarker = /^<!--\s*fleet-exec:\s*(codex|claude)\s*-->\s*$/;
const execCwdMarker = /^<!--\s*fleet-exec-cwd:\s*(.*?)\s*-->\s*$/;
// 全PCの設定変更・インストール・ファイル書き込みを依頼する本文を検出する。
// fleet-mail は相談・確認用で、設定変更は setup --converge 経由に一本化する（2026-10-11 事故: 手順を mail で配って
// PC ごとに手作業が発生し、converge に載っていない変更が fleet に残った）。
const installRequestPatterns = [
  /--install-extension/i,
  /\binstall\b/i,
  /\bsetup\b/i,
  /settings\.json/i,
  /\.claude\.json/i,
  /書き込/,
  /インストール/,
  /設定を変更/,
  /設定変更/,
  /セットアップ/
];
export function looksLikeInstallRequest(body) {
  const text = String(body ?? '');
  return installRequestPatterns.some(pattern => pattern.test(text));
}
// 宛先の最終 poll／ビーコンを stderr に出す。取得は fail-open（失敗・未設定なら「不明」を出して送信は続行）。
export async function describeTargetFreshness({ to, home, now = Date.now, fetchBeacons, pcMap } = {}) {
  const label = String(to ?? '');
  let result;
  try {
    const fetchImpl = fetchBeacons ?? (await import('./fleet-beacon.mjs')).fetchBeacons;
    result = await fetchImpl({ home });
  } catch (error) {
    return { text: `宛先 ${label}: 最終 poll 不明（ビーコン取得失敗: ${redactSecrets(error?.message || error)}）`, stale: false, unknown: true };
  }
  if (!result?.ok) {
    return { text: `宛先 ${label}: 最終 poll 不明（ビーコン取得失敗: ${result?.reason || '不明'}）`, stale: false, unknown: true };
  }
  const { buildFleetStatus } = await import('./fleet-status.mjs');
  const rows = buildFleetStatus({ pcMap: pcMap ?? {}, beacons: result.beacons, serverPolls: result.serverPolls, now: now() });
  const row = rows.find(candidate => candidate.label === label);
  if (!row) return { text: `宛先 ${label}: 最終 poll 不明（ビーコン無し）`, stale: false, unknown: true };
  const poll = row.pollAt ? `${jstShort(Date.parse(row.pollAt))} (${formatAge(row.pollAgeMs)}前)` : '不明';
  const beacon = row.hasBeacon ? jstShort(Date.parse(row.beaconAt)) : 'ビーコン無し';
  const stale = row.pollAgeMs === null || row.pollAgeMs > 24 * 60 * 60 * 1000;
  return { text: `宛先 ${label}: 最終poll ${poll} / ビーコン ${beacon}`, stale, unknown: row.pollAgeMs === null };
}
const nameKey = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
// pc-map 上で宛先 X と「同じ実機」を指す別キー（hostname 一致 / aliases に相互に含まれる）を返す。
export function sameMachineLabels(to, pcMap) {
  if (!pcMap || typeof pcMap !== 'object' || Array.isArray(pcMap)) return [];
  const entries = Object.entries(pcMap).filter(([label, entry]) => !label.startsWith('_') && entry && typeof entry === 'object' && !Array.isArray(entry));
  const identity = ([label, entry]) => new Set([label, entry.hostname, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].filter(Boolean).map(nameKey));
  const x = nameKey(to);
  const own = entries.filter(([label, entry]) => nameKey(label) === x || nameKey(entry.hostname) === x);
  const ownIds = new Set([x, ...own.flatMap(item => [...identity(item)])]);
  const ownKeys = new Set(own.map(([label]) => label));
  return entries.filter(item => !ownKeys.has(item[0]) && [...identity(item)].some(name => ownIds.has(name))).map(([label]) => label);
}
// 送信前の宛先解決: poll 実績の無い宛先を同一実機の別ラベル（poll 実績あり）へ付け替え、どこにも poll 実績が無ければ拒否する。
// ビーコン取得失敗は fail-open（status: 'unknown'）。
export async function resolveDeliverableTarget({ to, home, now = Date.now, fetchBeacons, pcMap } = {}) {
  const label = String(to ?? '');
  if (!label || label === 'all') return { status: 'ok', to: label };
  let result;
  try {
    const fetchImpl = fetchBeacons ?? (await import('./fleet-beacon.mjs')).fetchBeacons;
    result = await fetchImpl({ home });
  } catch { return { status: 'unknown', to: label }; }
  if (!result?.ok) return { status: 'unknown', to: label };
  const { buildFleetStatus } = await import('./fleet-status.mjs');
  const rows = buildFleetStatus({ pcMap: pcMap ?? {}, beacons: result.beacons, serverPolls: result.serverPolls, now: now() });
  const polled = rows.filter(row => row.pollAt);
  if (polled.some(row => row.label === label)) return { status: 'ok', to: label };
  const twins = new Set(sameMachineLabels(label, pcMap));
  const alt = polled.filter(row => twins.has(row.label)).sort((a, b) => Date.parse(b.pollAt) - Date.parse(a.pollAt))[0];
  if (alt) return { status: 'redirect', to: alt.label, text: `宛先 ${label} → ${alt.label} に解決（同一実機）` };
  return { status: 'none', to: label, labels: polled.map(row => row.label) };
}
export function parseExecMarkers(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  if (!execMarker.test(lines[0] ?? '')) return { exec: null, cwd: null, body: String(body ?? '') };
  let index = 1;
  let cwd = null;
  const cwdMatch = (lines[index] ?? '').match(execCwdMarker);
  if (cwdMatch) { cwd = cwdMatch[1]; index += 1; }
  const resume = (lines[index] ?? '').match(/^<!--\s*fleet-resume:\s*([A-Za-z0-9_-]+)\s*-->\s*$/);
  if (resume) index++;
  return { exec: lines[0].match(execMarker)[1], cwd, ...(resume ? { resumeSessionId: resume[1] } : {}), body: lines.slice(index).join('\n') };
}
// 受信タスクが claude CLI を見つけられない事故（2026-10-10 nishi-PC: spawn claude ENOENT）を
// 相手が追える形にする。Windows の npm グローバルは claude.cmd しか置かず shell:false では起動できない。
export function isMissingClaudeError(value) {
  return /ENOENT/i.test(String(value?.error ?? value?.message ?? value ?? ''));
}
export function missingClaudeMessage(executable, candidates = []) {
  const resolved = executable || 'claude';
  const list = Array.isArray(candidates) && candidates.length ? candidates.join(' / ') : '(候補0件)';
  return `実行失敗: claude CLI が見つかりません（実行ファイル: ${resolved} / 候補: ${list}）。受信側PCで CLAUDE_CLI_PATH を設定するか claude を再インストールしてください`;
}
// Windows: Win32_Process.Create でジョブオブジェクトの外に起動する。ShowWindow=0 で可視コンソールを出さない。
export function launchDetachedWin(file, args, spawnSyncImpl = spawnSync) {
  const quote = s => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
  const commandLine = [file, ...args].map(quote).join(' ').replace(/'/g, "''");
  const ps = `$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${commandLine}'; ProcessStartupInformation=$s}; exit [int]$r.ReturnValue`;
  const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, stdio: 'ignore', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Win32_Process.Create failed: ${result.status}`);
}
// 受信タスク(2分ごと・全PC)に相乗りする1日1回の自己修復。夜間ジョブが無いPCでも熱監視が入る
// （2026-10-10 cr-PC・カフェ用015 で OrgiastThermalGuard 未登録のまま。nightly の自己修復は fleet-poller があるPCだけ）。
export function dailySelfHeal({ dir, now = Date.now, platform = process.platform, spawnSyncImpl = spawnSync, repo = ownRepo }) {
  if (platform !== 'win32') return { skipped: 'platform' };
  if (process.env.FLEET_NO_SELF_HEAL === '1') return { skipped: 'disabled' };
  const marker = path.join(dir, '.fleet-self-heal-day');
  const day = new Date(now()).toISOString().slice(0, 10);
  let last = '';
  try { last = fs.readFileSync(marker, 'utf8').trim(); } catch {}
  if (last === day) return { skipped: 'today' };
  fs.writeFileSync(marker, day);
  const script = path.join(repo, 'tools', 'thermal-guard.ps1');
  if (!fs.existsSync(script)) return { skipped: 'no-script' };
  const ps = `if (-not (Get-ScheduledTask -TaskName 'OrgiastThermalGuard' -ErrorAction SilentlyContinue)) { & powershell -NoProfile -ExecutionPolicy Bypass -File '${script.replace(/'/g, "''")}' -Install *> $null; 'installed' } else { 'ok' }`;
  const r = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { thermalGuard: String(r.stdout || '').trim() || `exit=${r.status}` };
}
// fleet-fix-now.ps1 が更新されたら（ハッシュ変化）、受信タスクがそのPCで -NoLogin 実行する。
// 修正のたびに kim が全PCへ貼り直す往復をなくす（2026-10-12 kim 指摘: 011 で何度も貼り直し）。OAuth だけは人が要るので -NoLogin。
export function autoRunFixNow({ dir, repo = ownRepo, platform = process.platform, launch = launchDetachedWin, hashOf = f => require_hash(f) }) {
  if (platform !== 'win32' || process.env.FLEET_NO_SELF_HEAL === '1') return { skipped: 'disabled' };
  const script = path.join(repo, 'tools', 'fleet-fix-now.ps1');
  if (!fs.existsSync(script)) return { skipped: 'no-script' };
  const hash = hashOf(script);
  const marker = path.join(dir, '.fleet-fix-now-hash');
  let last = ''; try { last = fs.readFileSync(marker, 'utf8').trim(); } catch {}
  if (last === hash) return { skipped: 'same' };
  fs.writeFileSync(marker, hash);
  if (!last) return { skipped: 'first-seen' }; // 初回は記録だけ（導入直後に全PCで一斉実行しない）
  launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoLogin']);
  return { launched: hash };
}
function require_hash(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
// 1日1回、そのPCの AI レーンを実測し、dead があれば kim-PC へ note で報告する（2026-10-15 事故: codex 不在PCが無言で退避し続けた）。
// 既知の原因は fleet-fix-now.ps1 -NoLogin を同PCで起動して自動修復を試みる。全部生きていれば送らない。
// 復旧したら一度だけ recovered を送り、集計表から消す。同内容は24時間に1回まで。
export async function dailyLaneHealth({ dir, label, request, now = Date.now, platform = process.platform, spawnSyncImpl = spawnSync, launch = launchDetachedWin, repo = ownRepo }) {
  if (process.env.FLEET_NO_SELF_HEAL === '1') return { skipped: 'disabled' };
  const marker = path.join(dir, '.fleet-lane-health-day');
  const day = new Date(now()).toISOString().slice(0, 10);
  let last = ''; try { last = fs.readFileSync(marker, 'utf8').trim(); } catch {}
  const cached = readJson(path.join(dir, 'lane-health.json'), {});
  const stale = Object.values(cached?.lanes || {}).some(lane => /:stale$/.test(lane.reason || ''));
  if (last === day && !stale) return { skipped: 'today' };
  const doctor = path.join(repo, 'tools', 'lane-doctor.mjs');
  if (!fs.existsSync(doctor)) return { skipped: 'no-script' };
  const r = spawnSyncImpl(process.execPath, [doctor, '--probe', '--json'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: path.dirname(dir) }, windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const health = parseLaneDoctorOutput(r?.stdout);
  if (!health || r.error || r.status !== 0) return { skipped: 'probe-failed' };
  fs.writeFileSync(marker, day);
  const dead = deadLanes(health);
  const stateFile = path.join(dir, '.fleet-lane-health-sent.json');
  const state = readJson(stateFile, {}) || {};
  const sig = dead.length ? laneHealthSignature(label, dead) : 'ok';
  if (!dead.length && !state.sig?.startsWith?.('dead:')) return { healthy: true };
  const stamp = dead.length ? `dead:${sig}` : 'ok';
  if (state.sig === stamp && now() - Date.parse(state.at) < 24 * 3600_000) return { skipped: 'dedupe' };
  let autoFix = 'none';
  const fixScript = path.join(repo, 'tools', 'fleet-fix-now.ps1');
  if (dead.some(d => repairAdvice(d.lane, d.reason).fixNow) && platform === 'win32' && fs.existsSync(fixScript)) {
    try { launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixScript, '-NoLogin']); autoFix = 'launched'; }
    catch { autoFix = 'failed'; }
  }
  const at = new Date(now()).toISOString();
  if (label !== LANE_HEALTH_KIM_PC) { // kim-PC 自身は lane-health.json を集計側が直接読む
    const { why, body } = buildLaneHealthMail({ pc: label, dead, autoFix, recovered: !dead.length, at });
    checked(await request('mail-send', { id: mailId(now), from: label, to: LANE_HEALTH_KIM_PC, messageKind: 'note', auto: true, hop: 1, priority: 'normal', why, body, expiresAt: new Date(now() + 72 * 3600_000).toISOString() }));
  }
  writeJson(stateFile, { sig: stamp, at });
  return { reported: dead.length ? dead : 'recovered', autoFix };
}
export const LOCK_MS = 10 * 60 * 1000;
export function validId(id) {
  if (!/^mail-[A-Za-z0-9-]{1,180}$/.test(String(id ?? ''))) throw new Error('invalid mail id');
  return id;
}
export function resolveRemoteName(to, pcMap) {
  if (typeof to === 'string' && pcMap && typeof pcMap === 'object' && !Array.isArray(pcMap)) {
    const normalized = to.normalize('NFKC').trim();
    for (const [label, entry] of Object.entries(pcMap)) {
      if (label.startsWith('_') || typeof entry?.remoteName !== 'string') continue;
      if (entry.remoteName.normalize('NFKC').trim() === normalized) {
        // Resolve to the reporter label: cloned PCs can share a hostname (作業用004 and kimko-PC both report DESKTOP-PPD5V8I).
        return { to: label, resolved: true };
      }
    }
  }
  return { to, resolved: false };
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function envFile(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export function readInbox(home, { unreadOnly = true } = {}) {
  const dir = path.join(home, '.claude', 'fleet-inbox');
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter(f => /^mail-[A-Za-z0-9-]+\.json$/.test(f)).flatMap(f => {
    try {
      const raw = readJson(path.join(dir, f));
      const pending = readJson(path.join(dir, '.pending', f));
      const mail = raw && normalizeInbox(mergeLocalCompletion(raw, pending));
      return mail && (!unreadOnly || !terminal(mail)) ? [mail] : [];
    } catch { return []; } // One damaged file must not hide other unread messages.
  }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
export const TERMINAL_STATUSES = Object.freeze(['done', 'failed', 'expired']);
const terminal = mail => TERMINAL_STATUSES.includes(mail.status);
const automatic = mail => mail.auto === true || mail.auto === 'true';
const nextHop = mail => Number(mail.hop || 0) + 1;
export function mailId(now = Date.now, random = randomBytes) {
  return `mail-${now()}-${random(4).toString('hex')}`;
}
export function resolveMailTarget(to, pcMap = {}, beacons = []) {
  const remote = resolveRemoteName(to, pcMap);
  const entries = Object.entries(pcMap || {}).filter(([key, value]) => !key.startsWith('_') && value && typeof value === 'object' && !Array.isArray(value));
  const known = [...entries.map(([label, entry]) => ({ ...entry, label })), ...(Array.isArray(beacons) ? beacons : []).filter(b => typeof b?.label === 'string')];
  const exact = remote.resolved ? remote.to : known.find(b => b.label === to)?.label
    ?? known.find(b => b.hostname?.toLowerCase() === to?.toLowerCase())?.label;
  if (exact || to === 'all') return { to: exact || 'all', resolved: true };
  // Explicit aliases preserve PR #751's same-machine redirects; no substring matching.
  const alias = entries.find(([, entry]) => entry.aliases?.includes(to));
  if (alias) return { to: alias[0], resolved: true };
  const candidates = [...new Set(known.filter(b => [b.label, b.hostname, b.remoteName].some(n => typeof n === 'string' && n.startsWith(to))).map(b => b.label))].sort().slice(0, 5);
  return { to, resolved: false, candidates };
}
function inboxPath(home, id) { return path.join(home, '.claude', 'fleet-inbox', `${validId(id)}.json`); }
function normalizeInbox(mail) {
  // v1 ack and non-fleet inbox producers (decision-watch) only have readAt.
  // Once v2 fields exist, status alone controls completion, including seen records.
  const legacyRead = mail.readAt && !Object.hasOwn(mail, 'presentedAt') && !Object.hasOwn(mail, 'pendingServer') && !mail.seenAt && !mail.ackAt;
  const status = terminal(mail) ? mail.status : legacyRead ? 'done' : !mail.status || mail.status === 'new' ? 'delivered' : mail.status;
  return { ...mail, status,
    presentedAt: mail.presentedAt ?? null, presentedSession: mail.presentedSession ?? null };
}
export const INBOX_LOCK_RETRIES = 10;
export const INBOX_LOCK_DELAY_MS = 50;
export const INBOX_LOCK_STALE_MS = 2 * 60 * 1000;
export const COMMAND_LOCK_RETRIES = 5;
export const COMMAND_LOCK_DELAY_MS = 200;
export const LOCK_BUSY_EXIT = 6;
export const ACK_BATCH_LIMIT = 100;
export const SENT_STATUS_MAX_LOOKUP_FAILURES = 5;
export const CAPABILITY_BACKOFF_MS = 3600000;
export const SERVER_MAX_ATTEMPTS = 5;
export const INTERRUPTED_PROMPT_MS = 35 * 60000;
export const INTERRUPTED_PROMPT_BODY = '実行が中断・タイムアウト（結果ファイル未生成）';
// Windows can report a sharing/delete-pending conflict while a lock is released.
// These errors do not establish ownership or prove that the lock is stale.
function windowsLockBusy(error) {
  return process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(error.code);
}
// The callback runs synchronously while this file's lock is held. Never hold it over I/O to GAS.
// null means missing/busy/no change; callers must skip dependent work in that case.
export function updateInbox(id, fn, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now, retries = INBOX_LOCK_RETRIES, delayMs = INBOX_LOCK_DELAY_MS } = {}) {
  const file = inboxPath(home, id), lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST' && !windowsLockBusy(error)) throw error;
      const reclaim = `${lock}.reclaim`;
      let reclaimed = false, ownsReclaim = false;
      // Only EEXIST permits stale inspection; sharing conflicts use the same
      // bounded wait without touching another worker's lock.
      if (error.code === 'EEXIST') try {
        fs.mkdirSync(reclaim); ownsReclaim = true;
        if (now() - fs.statSync(lock).mtimeMs > INBOX_LOCK_STALE_MS) { fs.unlinkSync(lock); reclaimed = true; }
      } catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code) && !windowsLockBusy(error)) throw error; }
      finally { if (ownsReclaim) fs.rmdirSync(reclaim); }
      if (reclaimed) { attempt--; continue; }
      if (attempt === retries) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  try {
    let mail;
    try { mail = readJson(file); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const backup = path.join(path.dirname(file), 'corrupt', `${id}.json`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(file, backup);
      mail = null;
    }
    const current = mail ? normalizeInbox(mail) : null;
    const next = fn(current);
    if (!next) return null;
    if (next === current) return current;
    writeJson(file, next);
    return next;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function commandInbox(id, fn, options) {
  let visited = false;
  const result = updateInbox(id, current => { visited = true; return fn(current); }, {
    ...options, retries: COMMAND_LOCK_RETRIES, delayMs: COMMAND_LOCK_DELAY_MS,
  });
  if (!visited) throw Object.assign(new Error('fleet-mail: ロック競合=1'), { code: 'INBOX_BUSY' });
  return result;
}
function pendingLocalPath(home, id) { return path.join(home, '.claude', 'fleet-inbox', '.pending', `${validId(id)}.json`); }
function mergeLocalCompletion(mail, record) {
  if (!record?.pendingLocal) return mail;
  return { ...mail, ...record.pendingLocal,
    pendingServer: (mail.pendingServer || []).filter(action => !record.completedActions?.includes(action)) };
}
function applyLocalCompletion(home, id) {
  const file = pendingLocalPath(home, id);
  return updateInbox(id, current => {
    const record = readJson(file);
    if (!record?.pendingLocal) return null;
    const next = mergeLocalCompletion(current || { id }, record);
    // Keep the sidecar until the inbox write is durable, under the same lock.
    writeJson(inboxPath(home, id), next);
    fs.unlinkSync(file);
    return null;
  }, { home });
}
function saveLocalCompletion(home, id, pendingLocal, completedActions = [], stderr = console.error) {
  const prior = readJson(pendingLocalPath(home, id));
  writeJson(pendingLocalPath(home, id), { id, pendingLocal: { ...prior?.pendingLocal, ...pendingLocal },
    completedActions: [...new Set([...(prior?.completedActions || []), ...completedActions])] });
  try { applyLocalCompletion(home, id); }
  catch { stderr('fleet-mail: ローカル保存再試行待ち=1'); }
}
// Hook writes local intent synchronously; the detached CLI/poller owns transport.
export function presentMail({ home, id, sessionId, now = Date.now, autoAck = true }) {
  return updateInbox(id, mail => {
    if (mail?.status === 'failed' && mail.kind === 'prompt') return { ...mail, presentedAt: new Date(now()).toISOString(), presentedSession: sessionId };
    if (!mail || terminal(mail)) return null;
    const at = new Date(now()).toISOString();
    const ack = autoAck && mailCategory(mail) === 2;
    const seenBy = `${resolveFleetLabel(home, { hostname: os.hostname() })}:${sessionId}`;
    return { ...mail, presentedAt: at, presentedSession: sessionId,
      status: ack ? 'done' : 'seen', seenAt: mail.seenAt || at, seenBy: mail.seenBy || seenBy,
      ...(ack ? { ackAt: at, readAt: at } : {}),
      pendingServer: [...new Set([...(mail.pendingServer || []), 'seen', ...(ack ? ['ack'] : [])])].filter(action => !mail.abandonedServer?.includes(action)) };
  }, { home });
}
function expireInbox(home, now) {
  for (const mail of readInbox(home, { unreadOnly: false })) {
    if (mail.status !== 'done' && mail.status !== 'expired' && Date.parse(mail.expiresAt) <= now()) {
      updateInbox(mail.id, current => current && current.status !== 'done' && Date.parse(current.expiresAt) <= now() ? { ...current, status: 'expired' } : null, { home });
    }
  }
}
function migrateProcessed(home) {
  const file = path.join(home, '.claude', '.fleet-mail-processed');
  if (!fs.existsSync(file)) return;
  let busy = false;
  for (const id of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    if (!/^mail-[A-Za-z0-9-]{1,180}$/.test(id)) continue;
    let visited = false;
    updateInbox(id, mail => {
      visited = true;
      return mail && !terminal(mail) ? { ...mail, status: 'done', pendingServer: [...new Set([...(mail.pendingServer || []), 'ack'])] } : null;
    }, { home });
    if (!visited) busy = true;
  }
  if (!busy) fs.unlinkSync(file);
}
function checked(result) {
  if (result?.ok === false) throw new Error(result.reason || result.error || 'server rejected mail');
  return result;
}
function unsupported(error) {
  return error?.code === 'UNSUPPORTED_ACTION' || /unknown[_ -](?:action|kind)|handlers are not deployed/i.test(error?.message || '');
}
function validateMailResponse(kind, payload, result) {
  checked(result);
  const valid = kind === 'mail-poll' ? Array.isArray(result?.messages)
    : kind === 'mail-alerts' ? Array.isArray(result?.alerts)
    : kind === 'mail-ack' && payload.ids ? Array.isArray(result?.results)
    : result && Object.hasOwn(result, 'mail');
  if (!valid) throw Object.assign(new Error('fleet-mail: GAS mail handlers are not deployed'), { code: 'UNSUPPORTED_ACTION' });
  return result;
}
// Unknown actions in old WebApp.gs return the status-upsert shape {ok, action, row}.
export function capabilityClient(request, { home, now = Date.now, stderr = console.error, readOnly = false }) {
  const file = path.join(home, '.claude', '.fleet-mail-last-poll.json');
  return async (kind, payload, ...rest) => {
    const action = kind.replace('mail-', '');
    if (!['seen', 'ack', 'fail', 'alerts'].includes(action)) return request(kind, payload, ...rest);
    const cache = readJson(file, {});
    if (cache.serverCapabilities?.[action] === false && now() - Date.parse(cache.serverCapabilities.checkedAt) < CAPABILITY_BACKOFF_MS) {
      throw Object.assign(new Error('server capability backoff'), { code: 'CAPABILITY_BACKOFF' });
    }
    try {
      const result = validateMailResponse(kind, payload, await request(kind, payload, ...rest));
      return result;
    } catch (error) {
      if (unsupported(error)) {
        if (!readOnly) {
          // Capability probes are not successful polls; keep Task B's mtime health signal intact.
          let mtime = new Date(0);
          try { mtime = fs.statSync(file).mtime; } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
          writeJson(file, { ...readJson(file, {}), serverCapabilities: { seen: false, ack: false, fail: false, alerts: false, checkedAt: new Date(now()).toISOString() } });
          fs.utimesSync(file, mtime, mtime);
        }
        stderr('fleet-mail: 未対応サーバー=1');
      }
      throw error;
    }
  };
}
function finishSync(home, id, action, response, now, localStatus) {
  const server = response?.mail;
  const authoritative = server && terminal(server) && server.to !== 'all' ? Object.fromEntries(['status', 'seenAt', 'seenBy', 'ackAt', 'failedAt', 'failReason', 'resultAt', 'resultBody'].filter(key => server[key] !== undefined).map(key => [key, typeof server[key] === 'string' ? redactSecrets(server[key]) : server[key]])) : {};
  saveLocalCompletion(home, id, { ...(action === 'ack' ? { status: localStatus } : {}), ...authoritative,
    ...(['ack', 'fail'].includes(action) ? { serverSyncedAt: new Date(now()).toISOString() } : {}) }, [action]);
  return true;
}
function failSync(home, id, action, error, stderr) {
  if (error.code === 'CAPABILITY_BACKOFF') return;
  const saved = updateInbox(id, mail => {
    if (!mail) return null;
    const attempts = { ...mail.attempts, [action]: (mail.attempts?.[action] || 0) + 1 };
    const abandoned = attempts[action] >= SERVER_MAX_ATTEMPTS;
    return { ...mail, attempts, ...(abandoned ? {
      pendingServer: (mail.pendingServer || []).filter(a => a !== action),
      abandonedServer: [...new Set([...(mail.abandonedServer || []), action])]
    } : {}) };
  }, { home });
  if (saved?.attempts?.[action] >= SERVER_MAX_ATTEMPTS) stderr('fleet-mail: 同期打切り=1');
  else if (!unsupported(error)) stderr('fleet-mail: 同期再送待ち=1');
}
// Local intent is durable BEFORE transport. A failed action has a bounded retry queue.
export async function syncMailState({ home, id, action, request, now = Date.now, seenBy, reason, from, stderr = console.error, command = false }) {
  const at = new Date(now()).toISOString();
  const mail = (command ? commandInbox : updateInbox)(id, current => {
    let mail = current || { id, status: 'delivered' };
    if (mail.abandonedServer?.includes(action)) return null;
    if (action === 'seen' && !terminal(mail)) mail = { ...mail, status: 'seen', seenAt: mail.seenAt || at, seenBy: mail.seenBy || seenBy };
    if (action === 'ack' && !terminal(mail)) mail = { ...mail, status: 'done', ackAt: at, readAt: at };
    if (action === 'fail' && !terminal(mail)) mail = { ...mail, status: reason === 'expired' ? 'expired' : 'failed', failedAt: at, failReason: reason };
    return { ...mail, ...(reason ? { failReason: reason } : {}), pendingServer: [...new Set([...(mail.pendingServer || []), action])] };
  }, { home });
  if (!mail) return false;
  const client = capabilityClient(request, { home, now, stderr });
  let response;
  try {
    response = await client(`mail-${action}`, { id, from: from || resolveFleetLabel(home, machineIdentity()), ...(action === 'seen' ? { seenBy: mail.seenBy || seenBy } : {}), ...(action === 'fail' ? { reason: mail.failReason } : {}) });
  } catch (error) { failSync(home, id, action, error, stderr); return false; }
  return finishSync(home, id, action, response, now, mail.status);
}
export async function syncPending({ home, request, now = Date.now, from, stderr = console.error }) {
  const pendingDir = path.join(home, '.claude', 'fleet-inbox', '.pending');
  if (fs.existsSync(pendingDir)) for (const name of fs.readdirSync(pendingDir).filter(n => /^mail-[A-Za-z0-9-]+\.json$/.test(n))) {
    try { applyLocalCompletion(home, name.slice(0, -5)); }
    catch { stderr('fleet-mail: ローカル保存再試行待ち=1'); }
  }
  const mails = readInbox(home, { unreadOnly: false });
  for (const mail of mails) for (const action of mail.pendingServer || []) {
    if (!['seen', 'fail'].includes(action)) continue;
    try { await syncMailState({ home, id: mail.id, action, request, now, from, stderr, seenBy: mail.seenBy || from, reason: mail.failReason }); }
    catch { stderr('fleet-mail: 保存再試行待ち=1'); }
  }
  const ack = mails.filter(m => m.pendingServer?.includes('ack') && !m.abandonedServer?.includes('ack')).slice(0, ACK_BATCH_LIMIT);
  // Check file locks before making a transport call; a busy file remains pending.
  const ready = ack.filter(m => {
    try { return updateInbox(m.id, current => current?.pendingServer?.includes('ack') ? current : null, { home }); }
    catch { stderr('fleet-mail: 保存再試行待ち=1'); return false; }
  });
  if (ready.length) {
    let response, failure;
    try { response = await capabilityClient(request, { home, now, stderr })('mail-ack', { ids: ready.map(m => m.id), from }); }
    catch (error) { failure = error; }
    for (const mail of ready) {
      try {
        const result = response?.results.find(r => r.id === mail.id);
        if (result?.ok === true) finishSync(home, mail.id, 'ack', result, now, mail.status);
        else failSync(home, mail.id, 'ack', failure || new Error('batch item rejected'), stderr);
      } catch { stderr('fleet-mail: 保存再試行待ち=1'); }
    }
  }
}

export async function refreshSentStatus({ home, request, stderr = console.error }) {
  const dir = path.join(home, '.claude');
  let lines;
  try { lines = fs.readFileSync(path.join(dir, 'fleet-mail-sent.jsonl'), 'utf8').trim().split('\n'); } catch { return; }
  const file = path.join(dir, 'fleet-mail-sent-status.json');
  const cache = readJson(file, {});
  const rows = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const entries = rows.filter(r => ['sent', 'send-attempt'].includes(r.action) && r.id);
  const ids = [...new Set(entries.map(r => r.id))];
  const sentIds = new Set(entries.filter(r => r.action === 'sent').map(r => r.id));
  const deadline = Date.now() + 10000;
  // 送信前に失敗した send-attempt のように、サーバーに一度も現れない id は
  // 毎回 mail-get が失敗して「再試行待ち」が永久に出続ける。連続失敗が上限に達したら
  // 自動取得を打ち切る（--sent-status <id> の明示照会は今までどおり動く）。
  // ただし sent 行がある id は実際に送信できているため、一時的なタイムアウトで打ち切ると
  // 生きているメールの状態を永久に取れなくなる。期限切れ相当（8日）を過ぎるまでは打ち切らない。
  const SENT_STATUS_ABANDON_AFTER_MS = 8 * 24 * 3600000;
  const idAgeMs = id => { const m = /^mail-(\d{10,})-/.exec(id); return m ? Date.now() - Number(m[1]) : 0; };
  const abandonable = id => !sentIds.has(id) || idAgeMs(id) > SENT_STATUS_ABANDON_AFTER_MS;
  const abandoned = id => abandonable(id) && (cache[id]?.lookupFailures || 0) >= SENT_STATUS_MAX_LOOKUP_FAILURES;
  for (const id of ids.reverse().filter(id => !['done', 'expired'].includes(cache[id]?.status) && !abandoned(id)).sort((a, b) => (cache[a]?.checkedAt || 0) - (cache[b]?.checkedAt || 0)).slice(0, 5)) {
    if (Date.now() >= deadline) break;
    const previous = cache[id] || {};
    cache[id] = { ...previous, checkedAt: Date.now() };
    const failed = () => {
      const lookupFailures = (previous.lookupFailures || 0) + 1;
      cache[id] = { ...cache[id], lookupFailures };
      if (lookupFailures >= SENT_STATUS_MAX_LOOKUP_FAILURES && abandonable(id)) stderr(`fleet-mail: 送信状態を取得できないため自動取得を打ち切り=1 (${id})`);
      else stderr('fleet-mail: 送信状態取得再試行待ち=1');
    };
    try {
      const response = checked(await request('mail-get', { id }, Math.min(3000, deadline - Date.now())));
      if (response.mail) cache[id] = { ...response.mail, checkedAt: Date.now() };
      else failed();
    } catch { failed(); }
  }
  writeJson(file, cache);
}
function joinReply(home, mail) {
  if (!mail.replyTo) return;
  const dir = path.join(home, '.claude');
  let sent;
  try { sent = fs.readFileSync(path.join(dir, 'fleet-mail-sent.jsonl'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const parseLines = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  if (!parseLines(sent).some(row => row.id === mail.replyTo && ['sent', 'send-attempt'].includes(row.action))) return;
  if (!mail.id.startsWith('mail-reply-fail-')) {
    const statusFile = path.join(dir, 'fleet-mail-sent-status.json');
    const cache = readJson(statusFile, {});
    cache[mail.replyTo] = { ...cache[mail.replyTo], id: mail.replyTo, status: 'done', resultBody: mail.body };
    writeJson(statusFile, cache);
  }
  const repliesFile = path.join(dir, 'fleet-mail-replies.jsonl');
  let replies = []; try { replies = parseLines(fs.readFileSync(repliesFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!replies.some(row => row.replyId === mail.id)) fs.appendFileSync(repliesFile, `${JSON.stringify({ id: mail.replyTo, replyId: mail.id, from: mail.from, resultBody: mail.body, resultAt: mail.createdAt })}\n`, { mode: 0o600 });
}

export function acquireLock(file, { now = Date.now, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = { pid, nonce: randomUUID(), createdAt: now() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd);
      const owns = () => { try { return readJson(file)?.nonce === owner.nonce; } catch { return false; } };
      const heartbeat = setInterval(() => { if (owns()) { const d = new Date(now()); fs.utimesSync(file, d, d); } }, 30_000);
      heartbeat.unref();
      return () => { clearInterval(heartbeat); if (owns()) fs.unlinkSync(file); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const reclaim = `${file}.reclaim`;
      try { fs.mkdirSync(reclaim); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
      try {
        const stat = fs.statSync(file);
        if (now() - stat.mtimeMs < LOCK_MS) return null;
        fs.unlinkSync(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { fs.rmdirSync(reclaim); }
    }
  }
  return null;
}
export function findPriorReply(dir, id) {
  const sentFile = path.join(dir, 'fleet-mail-sent.jsonl');
  let sentLines;
  try {
    sentLines = fs.readFileSync(sentFile, 'utf8').split('\n').filter(l => l.trim());
  } catch (e) {
    if (e.code === 'ENOENT') sentLines = [];
    else throw e;
  }
  for (const line of sentLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.id === id && (entry.action === 'reply' || entry.action === 'auto-reply')) {
        return { at: entry.at, action: entry.action };
      }
    } catch { /* skip malformed line */ }
  }
  const inboxPath = path.join(dir, 'fleet-inbox', `${id}.json`);
  let mail = null;
  try { mail = readJson(inboxPath, null); } catch { /* damaged inbox file: sent.jsonl stays the source of truth */ }
  if (mail && mail.status === 'done') {
    return { at: mail.resultAt ?? null, action: 'inbox-done' };
  }
  return null;
}
export function parseArgs(argv) {
  const options = {};
  const flags = new Set(['--send', '--poll', '--no-exec', '--dry-run', '--json', '--inbox', '--force', '--sweep', '--unseen', '--all-seen', '--sync-pending']);
  const values = new Set(['--to', '--kind', '--body-file', '--why', '--expires-hours', '--wait', '--reply', '--ack', '--sent-status', '--exec', '--exec-cwd', '--priority', '--wait-for', '--answer', '--resume']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (Object.hasOwn(options, key)) throw new Error(`duplicate option: ${key}`);
    if (key === '--ack' && argv[i + 1] === '--all-seen') options[key] = true;
    else if (flags.has(key)) options[key] = true;
    else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
    else throw new Error(`unknown option or missing value: ${key}; 本文は --body-file を使ってください`);
  }
  const actions = ['--send', '--poll', '--inbox', '--reply', '--ack', '--sent-status', '--sweep', '--sync-pending', '--answer'].filter(k => options[k]);
  if (actions.length !== 1) throw new Error('指定は --send / --poll / --reply / --inbox / --ack / --sent-status のいずれか1つ');
  const allowed = {
    '--send': ['--to', '--kind', '--body-file', '--why', '--expires-hours', '--wait', '--exec', '--exec-cwd', '--force', '--priority', '--wait-for', '--dry-run', '--resume'],
    '--answer': ['--body-file', '--force'],
    '--poll': ['--dry-run', '--json', '--no-exec'], '--inbox': ['--json', '--unseen'], '--reply': ['--body-file', '--force'], '--ack': ['--all-seen'], '--sweep': [],
    '--sent-status': [], '--sync-pending': []
  };
  for (const key of Object.keys(options)) if (key !== actions[0] && !allowed[actions[0]].includes(key)) throw new Error(`option not applicable: ${key}`);
  if (options['--send']) {
    for (const key of ['--to', '--kind', '--body-file', '--why']) if (!options[key]?.trim()) throw new Error(`${key} 必須`);
    if (!['prompt', 'note'].includes(options['--kind'])) throw new Error('--kind must be prompt or note');
    if (options['--kind'] === 'note' && /^\s*\[作業依頼\]/.test(options['--why'])) throw new Error('[作業依頼] は受信側で実行されるよう --kind prompt で送ってください（note は表示のみで実行されません）');
    if (options['--to'].length > 128 || options['--why'].length > 1000) throw new Error('宛先または理由が長すぎます');
    if (options['--exec'] !== undefined) {
      if (!EXEC_KINDS.includes(options['--exec'])) throw new Error(`--exec は ${EXEC_KINDS.join(' / ')} のみ対応`);
      if (options['--kind'] !== 'prompt') throw new Error('--exec は --kind prompt でのみ使えます');
    }
    if (options['--exec-cwd'] !== undefined && options['--exec'] === undefined) throw new Error('--exec-cwd は --exec codex と併用してください');
  }
  if (options['--resume'] !== undefined) {
    if (options['--exec'] !== 'claude') throw new Error('--resume は --exec claude と併用してください');
    validSessionId(options['--resume']);
  }
  if (options['--exec'] === 'claude' && !options['--exec-cwd']?.trim()) throw new Error('--exec claude は --exec-cwd 必須');
  if (options['--exec-cwd'] && /[\r\n]|-->/.test(options['--exec-cwd'])) throw new Error('invalid --exec-cwd');
  if ((options['--reply'] || options['--answer']) && !options['--body-file']) throw new Error('--body-file 必須');
  for (const key of ['--reply', '--ack', '--sent-status', '--answer']) if (options[key] && options[key] !== true) validId(options[key]);
  for (const key of ['--expires-hours', '--wait']) if (options[key] !== undefined && (!Number.isFinite(Number(options[key])) || Number(options[key]) < (key === '--wait' ? 0 : 0.001))) throw new Error(`invalid ${key}`);
  if (options['--ack'] && options['--all-seen'] && options['--ack'] !== true) throw new Error('--ack id と --all-seen は併用不可');
  if (options['--priority'] && !['normal', 'urgent'].includes(options['--priority'])) throw new Error('invalid --priority');
  if (options['--wait-for'] && (!['seen', 'done'].includes(options['--wait-for']) || options['--wait'] === undefined)) throw new Error('invalid --wait-for');
  return options;
}
export function createClient({ url, token, fetchImpl = fetch }) {
  return async (kind, payload, timeoutMs = 60_000) => {
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ ...payload, kind, token }), signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
    });
    if (!response.ok) throw new Error(`fleet-mail HTTP ${response.status}`);
    const result = await response.json();
    if (result?.ok !== true) throw new Error(`fleet-mail: ${result?.reason || result?.error || 'invalid response'}`);
    return validateMailResponse(kind, payload, result);
  };
}
export async function waitForReply(id, seconds, { request, now = Date.now, sleepImpl = sleep, waitFor = 'done' }) {
  const deadline = now() + seconds * 1000;
  while (now() < deadline) {
    try {
      const result = await request('mail-get', { id }, Math.min(60_000, deadline - now()));
      if (waitFor === 'seen' && (result.mail?.seenAt || ['seen', 'done'].includes(result.mail?.status))) return { exitCode: 0, text: `既読（id=${id}）` };
      if (['failed', 'expired'].includes(result.mail?.status)) return { exitCode: 1, text: `${result.mail.status}（id=${id}）` };
      if (result.mail?.status === 'done') return { exitCode: 0, text: redactSecrets(result.mail.resultBody || '[ack のみ・本文なし]') };
    } catch (error) { if (now() < deadline) throw error; }
    if (now() < deadline) await sleepImpl(Math.min(15_000, deadline - now()));
  }
  return { exitCode: 2, text: `${waitFor === 'seen' ? '未読' : '未返信'}（id=${id}）` };
}
function arrivalMigrationTime(home, now) {
  const file = path.join(home, '.claude', '.fleet-mail-v2-migrated');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { const at = new Date(now()); fs.futimesSync(fd, at, at); }
    finally { fs.closeSync(fd); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return fs.statSync(file).mtimeMs;
}
export async function notifyPendingArrivals(deps) {
  const { notifyArrival, ARRIVAL_TIMEOUT_MS, ARRIVAL_BUDGET_MS } = await import('./lib/fleet-mail-discord.mjs');
  const { home, label, now = Date.now, stderr = console.error } = deps;
  const migratedAt = arrivalMigrationTime(home, now);
  const eligible = mail => mail && ['delivered', 'seen'].includes(mail.status) && !mail.arrivalNotifiedAt &&
    !mail.arrivalNotificationReservedAt && Date.parse(mail.receivedAt) >= migratedAt && mailCategory(mail) <= 1;
  const clock = deps.notificationNow ?? (() => performance.now());
  const deadline = clock() + ARRIVAL_BUDGET_MS;
  for (const mail of readInbox(home, { unreadOnly: false })) {
    if (!eligible(mail)) continue;
    if (deadline - clock() <= 0) break;
    const controller = new AbortController();
    let timer, reserved, sent = false;
    try {
      reserved = updateInbox(mail.id, current => eligible(current) ? {
        ...current, arrivalNotificationReservedAt: new Date(now()).toISOString(),
      } : null, { home });
      if (!reserved) continue;
      const remaining = deadline - clock();
      if (remaining <= 0) continue;
      // Reserve durably before notifying; a competing poll cannot send the same arrival.
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('arrival timeout')); }, Math.min(ARRIVAL_TIMEOUT_MS, remaining));
      });
      sent = await Promise.race([
        Promise.resolve().then(() => (deps.notifyArrival ?? notifyArrival)(reserved, {
          home, label, category: mailCategory(reserved), fetchImpl: deps.fetch, stderr, signal: controller.signal,
        })),
        timeout,
      ]);
    } catch { stderr('fleet-mail: 到着通知失敗=1'); }
    finally {
      clearTimeout(timer);
      if (reserved) saveLocalCompletion(home, mail.id, {
        arrivalNotificationReservedAt: null, ...(sent ? { arrivalNotifiedAt: new Date(now()).toISOString() } : {}),
      }, [], stderr);
    }
  }
}
// Only stdout is an answer. Legacy combined output must never be trusted.
export function stripClaudeWarnings(text) {
  return String(text || '').split(/\r?\n/).filter(line => !/^\s*(?:Permission allow rule \(|(?:Warning: )?(?:Invalid|Unknown|Unrecognized) (?:permission|settings?|configuration)\b)/i.test(line)).join('\n').trim();
}
export function classifyExecutionResult(result, { exec } = {}) {
  const body = truncateAnswer(redactSecrets(stripClaudeWarnings(result.stdoutTail)));
  const reason = result.timedOut ? 'timeout' : result.reason || (result.exitCode !== 0 ? `exit-${result.exitCode ?? 'unknown'}` : !body ? 'empty' : null);
  const marker = '\n--- codex-do 出力末尾 ---\n';
  const formatted = String(result.outputTail || '');
  const boundary = formatted.indexOf(marker);
  const outputTail = exec === 'codex' && formatted.startsWith('[fleet-exec codex] ') && boundary >= 0
    ? redactSecrets(formatted.slice(0, boundary + marker.length)) + body : body;
  return { ...result, reason, stdoutTail: body, outputTail };
}
export async function sendExecutionFailure(args) {
  const { result, label } = args;
  const diagnostic = redactSecrets(result.stderrTail || result.error || '').slice(-600);
  return sendHubFailure({ ...args, result: { ...result,
    outputTail: `${label} の自動回答が完了しなかった（${result.reason}）。${label} の対話セッションで回答する` + (diagnostic ? `\n${diagnostic}` : '') } });
}
// Rejection is a reply note plus a fail transition. mail-reply would mark the
// original done, after which the server correctly refuses a done -> failed change.
export async function sendHubFailure({ home, mail, result, request, label, now = Date.now, stderr = console.error }) {
  checked(await request('mail-send', {
    id: `mail-reply-fail-${createHash('sha256').update(`${mail.id}\n${label}\n${result.reason}`).digest('hex').slice(0, 24)}`,
    from: label, to: mail.from, replyTo: mail.id, messageKind: 'note', body: result.outputTail,
    why: '[報告・返信不要] 実行拒否', auto: true, hop: nextHop(mail), priority: 'normal', reason: result.reason,
    expiresAt: new Date(now() + 72 * 3600000).toISOString()
  }));
  await syncMailState({ home, id: mail.id, action: 'fail', reason: result.reason, from: label, request, now, stderr });
}
// 受信1回分。--poll のみが呼ぶ。提示 hook はこの処理を別プロセスで起動する。
// 受信タスク(OrgiastFleetMail)が死んでいても対話セッションが受信を代替するための exports（2026-10-10 事故）。
// executePrompts: false なら runner を起動せず受信だけする。
export async function pollOnce(deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const dir = path.join(home, '.claude');
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const now = deps.now ?? Date.now;
  const dryRun = !!deps.dryRun;
  const config = envFile(path.join(dir, 'fleet-sheet.env'));
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) { err('fleet-mail: fleet-sheet.env 未設定のためスキップ'); return { skipped: 'unconfigured' }; }
  const identity = deps.identity ?? machineIdentity();
  const label = deps.label ?? resolveFleetLabel(home, identity);
  const request = deps.request ?? createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetch });
  const release = dryRun ? () => {} : acquireLock(path.join(dir, 'fleet-mail.lock'), { now });
  if (!release) { err('fleet-mail: 別の受信処理が実行中'); return { skipped: 'locked' }; }
  const fileOf = id => inboxPath(home, id);
  const log = (name, value) => fs.appendFileSync(path.join(dir, `fleet-mail-${name}.jsonl`), `${JSON.stringify({ at: new Date(now()).toISOString(), ...value })}\n`, { mode: 0o600 });
  const state = (id, action, extra = {}) => syncMailState({ home, id, action, request, now, from: label, stderr: err, ...extra });
  const client = capabilityClient(request, { home, now, stderr: err });
  const quarantineDir = path.join(dir, 'fleet-inbox', 'quarantine');
  const quarantineAttempts = new Set();
  const failQuarantined = async (file, record) => {
    if (!record.serverId || !record.pendingServer?.length || quarantineAttempts.has(record.serverId)) return;
    quarantineAttempts.add(record.serverId);
    try {
      await client('mail-fail', { id: record.serverId, from: label, reason: record.reason });
      writeJson(file, { ...record, pendingServer: [] });
    } catch (error) {
      if (error.code === 'CAPABILITY_BACKOFF') return;
      record.attempts = (record.attempts || 0) + 1;
      if (record.attempts >= SERVER_MAX_ATTEMPTS) { record.pendingServer = []; err('fleet-mail: 同期打切り=1'); }
      writeJson(file, record);
    }
  };
  const quarantine = async (raw, error) => {
    let serverId = null;
    try { serverId = validId(raw?.id); } catch { /* Never send an invalid id. */ }
    const id = serverId || `mail-invalid-${createHash('sha256').update(JSON.stringify(raw) ?? 'null').digest('hex').slice(0, 16)}`;
    const record = { raw: JSON.parse(JSON.stringify(raw ?? null, (_key, value) => typeof value === 'string' ? redactSecrets(value) : value)), serverId, reason: redactSecrets(error.message).slice(0, 1000), pendingServer: serverId ? ['fail'] : [] };
    const file = path.join(quarantineDir, `${id}.json`);
    const prior = readJson(file);
    if (prior) { record.attempts = prior.attempts || 0; record.pendingServer = prior.pendingServer || []; }
    writeJson(file, record);
    if (serverId) updateInbox(serverId, mail => mail && !terminal(mail) ? { ...mail, status: 'failed', failReason: record.reason } : null, { home });
    await failQuarantined(file, record);
  };
  try {
    if (!dryRun) {
      arrivalMigrationTime(home, now);
      const removed = collectQuestions({ home, now });
      if (removed) err(`fleet-mail: 質問回収=${removed}`);
      reconcileResumes({ home, now });
      try { await relayQuestions({ home, hub: config.FLEET_HUB, label, request, now, stderr: err }); }
      catch { err('fleet-mail: 質問転送再試行待ち=1'); }
      migrateProcessed(home);
      // Archive corrupt cache under a per-file lock, then recover via mail-get even after delivery.
      const inboxDir = path.join(dir, 'fleet-inbox');
      if (fs.existsSync(inboxDir)) for (const name of fs.readdirSync(inboxDir).filter(n => /^mail-[A-Za-z0-9-]+\.json$/.test(n))) {
        try { updateInbox(name.slice(0, -5), () => null, { home }); }
        catch { err('fleet-mail: 保存再試行待ち=1'); }
      }
      expireInbox(home, now);
      await syncPending({ home, request, now, from: label, stderr: err });
      if (fs.existsSync(quarantineDir)) for (const name of fs.readdirSync(quarantineDir).filter(n => /^mail-[A-Za-z0-9-]+\.json$/.test(n))) {
        try { const file = path.join(quarantineDir, name); await failQuarantined(file, readJson(file)); } catch { err('fleet-mail: 隔離記録の再同期失敗=1'); }
      }
    }
    const pollFile = path.join(dir, '.fleet-mail-poll.json');
    const batch = dryRun ? {} : readJson(pollFile) || { requestId: randomUUID(), successfulIds: [], quarantinedIds: [] };
    if (!dryRun) writeJson(pollFile, batch);
    const response = checked(await request('mail-poll', { to: label, hostname: identity.hostname, dryRun, requestId: batch.requestId,
      // Broadcast remains pending for presentation; the inbox itself is the durable delivery receipt.
      processedIds: readInbox(home, { unreadOnly: false }).filter(m => m.to === 'all' && Date.parse(m.expiresAt) > now()).map(m => m.id) }));
    if (dryRun) {
      const messages = response.messages.map(m => ({ ...m, from: redactSecrets(m.from), why: redactSecrets(m.why), body: redactSecrets(m.body), resultBody: redactSecrets(m.resultBody) }));
      out(JSON.stringify(messages)); return { messages };
    }
    const received = [], handled = [], fresh = new Set();
    let rejected = 0, undurable = 0, legacy = 0;
    const recover = [], corruptDir = path.join(dir, 'fleet-inbox', 'corrupt');
    if (fs.existsSync(corruptDir)) for (const name of fs.readdirSync(corruptDir).filter(n => /^mail-[A-Za-z0-9-]+\.json$/.test(n))) {
      const id = name.slice(0, -5);
      if (fs.existsSync(fileOf(id))) continue;
      try { const restored = checked(await request('mail-get', { id })); if (restored.mail) recover.push(restored.mail); }
      catch { err('fleet-mail: 復旧再試行待ち=1'); }
    }
    for (const raw of [...response.messages, ...recover]) {
      if (raw?.id && ((batch.successfulIds?.includes(raw.id) && fs.existsSync(fileOf(raw.id))) || batch.quarantinedIds?.includes(raw.id))) continue;
      try {
        const exact = raw && (raw.to === 'all' || raw.to === label || (typeof raw.to === 'string' && raw.to.toLowerCase() === identity.hostname?.toLowerCase()));
        const legacyTo = !exact && typeof raw?.to === 'string' && !!raw.to && (label.includes(raw.to) || identity.hostname?.toLowerCase().includes(raw.to.toLowerCase()));
        if (!/^mail-[A-Za-z0-9-]{1,180}$/.test(raw?.id || '') || (!exact && !legacyTo) || !['note', 'prompt'].includes(raw.kind)
          || typeof raw.body !== 'string' || !raw.from || !Number.isFinite(Date.parse(raw.expiresAt))) throw Object.assign(new Error('invalid incoming mail'), { code: 'INVALID_INCOMING_MAIL' });
        let created = false;
        const saved = updateInbox(raw.id, existing => {
          if (!existing) {
            created = true;
            const mail = normalizeInbox({ ...raw, ...(legacyTo ? { legacyTo: true } : {}), from: redactSecrets(raw.from), why: redactSecrets(raw.why), body: redactSecrets(raw.body), readAt: null, receivedAt: new Date(now()).toISOString() });
            if (mail.status !== 'done' && Date.parse(mail.expiresAt) <= now()) mail.status = 'expired';
            return mail;
          }
          return terminal(raw) && !terminal(existing) ? { ...existing, ...raw, body: redactSecrets(raw.body), resultBody: redactSecrets(raw.resultBody) } : existing;
        }, { home });
        if (!saved) { undurable++; continue; }
        if (created) { fresh.add(raw.id); log('received', { count: 1 }); if (legacyTo) legacy++; }
        joinReply(home, saved);
        received.push(raw.id);
        batch.successfulIds = [...new Set([...(batch.successfulIds || []), raw.id])];
      } catch (error) {
        if (error.code === 'INVALID_INCOMING_MAIL') {
          rejected++;
          try { await quarantine(raw, error); batch.quarantinedIds = [...new Set([...(batch.quarantinedIds || []), raw?.id ?? null])]; }
          catch { undurable++; }
        } else undurable++;
      }
      writeJson(pollFile, batch);
    }
    if (!undurable) fs.unlinkSync(pollFile);
    else err(`fleet-mail: 保存再試行待ち=${undurable}`);
    if (legacy) err(`fleet-mail: 旧形式宛先受信=${legacy}`);
    const lastPollFile = path.join(dir, '.fleet-mail-last-poll.json');
    writeJson(lastPollFile, { ...readJson(lastPollFile, {}), at: new Date(now()).toISOString() });
    let promptHandled = false;
    let growiAppendHandled = false;
    const fleetMembers = deps.pcMap ?? readJson(new URL('../fleet-pc-map.json', import.meta.url), {});
    for (const pending of readInbox(home, { unreadOnly: false })) {
      let mail = pending;
      try {
        mail = updateInbox(pending.id, current => current, { home }); // Observe replies and skip a busy file.
        if (!mail || !['delivered', 'seen'].includes(normalizeInbox(mail).status)) continue;
        if (hasDecisionRequest(mail)) {
          if (!mail.decisionRegisteredAt) {
            const source = `fleet-mail:${mail.from}:${mail.id}`;
            let record = listDecisions({ home }).find(d => d.source === source);
            if (!record) {
              const subject = String(mail.why ?? '').replace(decisionPrefix, '').trim()
                || String(mail.body ?? '').trimStart().split(/\r?\n/)[0].replace(decisionPrefix, '').trim();
              record = addDecision({ source, text: `[判断依頼] ${subject} / from=${mail.from} id=${mail.id}`.slice(0, 200) }, { home, now: new Date(now()) });
            }
            updateInbox(mail.id, current => current && ({ ...current, decisionRegisteredAt: new Date(now()).toISOString(), decisionId: record.id }), { home });
            log('decision-request-skipped', { id: mail.id, from: mail.from });
            if (mail.kind === 'prompt') writeJson(path.join(dir, 'fleet-agent-results', `${mail.id}.json`), { exitCode: null, outputTail: '判断依頼を含むためヘッドレス実行では回答しません（decision-request-skipped）。kim の判断待ちです。' });
          }
          const latest = readJson(fileOf(mail.id));
          if (!latest.decisionAckAt && !automatic(mail) && nextHop(mail) < 3) {
            try {
              // A receipt must not complete the human's pending decision on the server.
              const id = `mail-reply-ack-${createHash('sha256').update(`${mail.id}\n${label}`).digest('hex').slice(0, 16)}`;
              checked(await request('mail-send', { id, from: label, to: mail.from, replyTo: mail.id, messageKind: 'note', auto: true, hop: nextHop(mail), priority: 'normal',
                why: '[回答・返信不要] 判断依頼の受領', body: `受領しました。kim の判断待ちとして登録（決定ID ${latest.decisionId}）。回答は kim が決めた後に別の note で送ります。期限: ${mail.expiresAt}`,
                expiresAt: new Date(now() + 72 * 3600000).toISOString() }));
              updateInbox(mail.id, current => current && ({ ...current, decisionAckAt: new Date(now()).toISOString() }), { home });
              log('sent', { action: 'decision-ack', id: mail.id, decisionId: latest.decisionId });
            } catch (error) { log('decision-ack-failed', { id: mail.id, error: redactSecrets(error.message) }); }
          }
          continue;
        }
        const growiRequest = Object.hasOwn(fleetMembers, mail.from) && label === config.FLEET_HUB && fs.existsSync(path.join(dir, 'growi.env'))
          && mail.kind === 'note' && /^\[growi-append\]/.test(String(mail.why ?? '')) && !mail.growiAppendDoneAt;
        if (growiRequest && !growiAppendHandled) {
          growiAppendHandled = true;
          const results = [];
          try {
            const parsed = JSON.parse(mail.body);
            if (!Array.isArray(parsed?.growiAppend) || parsed.growiAppend.length < 1 || parsed.growiAppend.length > 5) throw new Error('growiAppend は1〜5件の配列にしてください');
            for (const item of parsed.growiAppend) {
              if (!item || typeof item.path !== 'string' || !item.path.startsWith('/') || typeof item.anchor !== 'string' || !item.anchor || typeof item.lines !== 'string') throw new Error('各 growiAppend には path・anchor・lines が必要です');
              try {
                results.push(await (deps.growiAppend ?? appendAfterFromEnv)({ pagePath: item.path, anchor: item.anchor, lines: item.lines,
                  envFile: path.join(dir, 'growi.env'), timeoutMs: 120000 }));
              } catch (error) { results.push({ ok: false, path: item.path, error: redactSecrets(error.message) }); }
            }
          } catch (error) { results.push({ ok: false, error: redactSecrets(error.message) }); }
          try {
            checked(await request('mail-send', { id: `mail-reply-growi-${createHash('sha256').update(`${mail.id}\n${label}`).digest('hex').slice(0, 24)}`,
              from: label, to: mail.from, replyTo: mail.id, messageKind: 'note', auto: true,
              hop: nextHop(mail), priority: 'normal', why: '[回答・返信不要] growi-append 結果', body: JSON.stringify(results),
              expiresAt: new Date(now() + 72 * 3600000).toISOString() }));
            updateInbox(mail.id, current => current && ({ ...current, growiAppendDoneAt: new Date(now()).toISOString() }), { home });
            handled.push(mail.id);
          } catch { err('fleet-mail: growi-append 返信再送待ち=1'); }
          continue;
        }
        if (mail.kind !== 'prompt') { if (fresh.has(mail.id)) handled.push(mail.id); continue; }
        if (deps.executePrompts === false || automatic(mail) || nextHop(mail) >= 3) continue;
        const marked = parseExecMarkers(mail.body);
        const exec = { ...marked, exec: mail.exec || marked.exec, cwd: mail.execCwd || marked.cwd, resumeSessionId: mail.resumeSessionId || marked.resumeSessionId };
        const hubExecution = exec.exec === 'claude';
        if (exec.resumeSessionId) validSessionId(exec.resumeSessionId);
        const resultFile = path.join(dir, 'fleet-agent-results', `${validId(mail.id)}.json`);
        let result = readJson(resultFile);
        if (hubExecution && !result && !mail.executionStartedAt) {
          const reason = !config.FLEET_HUB || mail.from !== config.FLEET_HUB ? 'not-hub' : !validExecCwd(exec.cwd) ? 'bad-cwd' : null;
          if (reason) result = { exitCode: null, reason, outputTail: `reason: ${reason}` };
        }
        if (mail.executionStartedAt && !result) {
          if (now() - Date.parse(mail.executionStartedAt) < (hubExecution ? RESUME_LIMIT_MS : INTERRUPTED_PROMPT_MS)) continue;
          result = { exitCode: null, outputTail: INTERRUPTED_PROMPT_BODY, timedOut: true };
          if (hubExecution && exec.resumeSessionId) clearResume(home, exec.resumeSessionId, mail.id);
        }
        if (!result) {
          if (mail.executionStartedAt) continue; // Never start an interrupted execution a second time.
          const kind = hubExecution ? 'claude-resume' : exec.exec === 'codex' ? 'codex' : 'prompt';
          if (!loadOptin(path.join(dir, 'fleet-agent-optin.json')).includes(kind)) result = { exitCode: null, outputTail: `未オプトイン。承諾コマンド: ${consentCommand(kind)}` };
          else {
            if (promptHandled) continue;
            if (hubExecution && exec.resumeSessionId) {
              const current = readQuestion(home, exec.resumeSessionId);
              if (current?.resumingAt && now() - Date.parse(current.resumingAt) < RESUME_LIMIT_MS) continue;
            }
            promptHandled = true;
            const claimed = updateInbox(mail.id, current => current && !terminal(current) && !current.executionStartedAt ? { ...current, executionStartedAt: new Date(now()).toISOString() } : null, { home });
            if (!claimed) continue;
            if (!hubExecution) await state(mail.id, 'seen', { seenBy: 'headless' });
            const runnerArgs = [path.join(ownRepo, 'tools', 'fleet-task-runner.mjs'), '--id', mail.id, '--home', home];
            const failedStart = () => {
              writeJson(resultFile, { exitCode: null, outputTail: '実行失敗: runner 起動失敗' });
              err('fleet-mail: runner 起動失敗=1');
            };
            try {
              if (deps.spawnImpl || process.platform !== 'win32') {
                const child = (deps.spawnImpl ?? spawn)(process.execPath, runnerArgs, { ...backgroundSpawnOptions(), stdio: 'ignore', windowsHide: true });
                child.on('error', failedStart); child.unref();
              } else (deps.launchDetachedWin ?? launchDetachedWin)(process.execPath, runnerArgs);
            } catch { failedStart(); }
            log('exec-started', { count: 1 });
            continue;
          }
        }
        result = classifyExecutionResult({ ...result, stderrTail: result.stderrTail ?? (result.exitCode == null ? result.outputTail : '') }, { exec: exec.exec });
        if (result.stderrTail) result.stderrTail = redactSecrets(result.stderrTail);
        if (result.error) result.error = redactSecrets(result.error);
        if (result.stdoutTail !== undefined) result.stdoutTail = redactSecrets(result.stdoutTail);
        writeJson(resultFile, result);
        // A failed reply retains its result and retries transport without executing again.
        if (terminal(readJson(fileOf(mail.id)))) continue;
        if (result.reason) {
          await sendExecutionFailure({ home, mail, result, request, label, now, stderr: err });
          handled.push(mail.id); continue;
        }
        let replyResponse;
        try { replyResponse = checked(await request('mail-reply', { id: mail.id, from: label, resultBody: result.outputTail, auto: true, hop: nextHop(mail), priority: 'normal' })); }
        catch (error) { err('fleet-mail: 返信再送待ち=1'); continue; }
        if (['failed', 'expired'].includes(replyResponse?.mail?.status)) {
          updateInbox(mail.id, current => current && ({ ...current, status: replyResponse.mail.status }), { home });
          continue;
        }
        log('sent', { action: 'auto-reply', id: mail.id, exitCode: result.exitCode, timedOut: !!result.timedOut, ...(exec.exec ? { exec: exec.exec } : {}) });
        updateInbox(mail.id, current => current && ({ ...current, status: 'done', resultAt: replyResponse?.mail?.resultAt || new Date(now()).toISOString(), resultBody: redactSecrets(replyResponse?.reply?.body ?? replyResponse?.mail?.resultBody ?? result.outputTail) }), { home });
        handled.push(mail.id);
      } catch (error) {
        if (hasDecisionRequest(mail)) { log('decision-intake-failed', { id: mail.id, error: redactSecrets(error.message) }); continue; }
        err('fleet-mail: 処理再試行待ち=1');
      }
    }
    await refreshSentStatus({ home, request, stderr: err });
    try { (deps.dailySelfHeal ?? dailySelfHeal)({ dir, now }); } catch (error) { err(`fleet-mail: 自己修復失敗: ${redactSecrets(error.message)}`); }
    try { (deps.autoRunFixNow ?? autoRunFixNow)({ dir }); } catch (error) { err(`fleet-mail: 自動修復失敗: ${redactSecrets(error.message)}`); }
    try { await (deps.dailyLaneHealth ?? dailyLaneHealth)({ dir, label, request, now }); } catch (error) { err(`fleet-mail: レーン健全性報告失敗: ${redactSecrets(error.message)}`); }
    try {
      await (deps.dailyRuleCompliance ?? dailyRuleCompliance)({ dir, home, label, request, now,
        repo: deps.repo ?? ownRepo, background: true, stderr: err });
    } catch { err('fleet-mail: ルール遵守報告失敗（pollは継続）'); }
    // Transport latency must never prevent durable receipt or per-mail processing.
    await notifyPendingArrivals({ ...deps, home, label, now, stderr: err });
    out(deps.json ? JSON.stringify({ received, processed: handled }) : `受信=${received.length} / 処理=${handled.length} / 隔離=${rejected}`);
    return { received, handled, rejected };
  } finally { release(); }
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  try { return await runMain(argv, deps); }
  catch (error) {
    if (error.code !== 'INBOX_BUSY') throw error;
    (deps.stderr ?? console.error)('fleet-mail: ロック競合=1');
    return LOCK_BUSY_EXIT;
  }
}
async function runMain(argv, deps) {
  const options = parseArgs(argv);
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const dir = path.join(home, '.claude');
  const out = deps.stdout ?? (text => console.log(text));
  const err = deps.stderr ?? (text => console.error(text));
  const now = deps.now ?? Date.now;
  const inboxFile = id => path.join(dir, 'fleet-inbox', `${validId(id)}.json`);
  const log = (name, value) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `fleet-mail-${name}.jsonl`), `${JSON.stringify({ at: new Date(now()).toISOString(), ...value })}\n`, { mode: 0o600 });
  };
  const config = envFile(path.join(dir, 'fleet-sheet.env'));
  const configured = !!(config.FLEET_SHEET_URL && config.FLEET_SHEET_TOKEN);
  const identity = deps.identity ?? machineIdentity();
  const label = resolveFleetLabel(home, identity);
  const request = configured ? deps.request ?? createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetch })
    : async () => { throw new Error('fleet-sheet.env 未設定'); };
  const state = (id, action, extra = {}) => syncMailState({ home, id, action, request, now, from: label, stderr: err, ...extra });
  if (options['--sync-pending']) {
    await syncPending({ home, request, now, from: label, stderr: err });
    return 0;
  }
  if (options['--inbox']) {
    expireInbox(home, now);
    const mails = readInbox(home).filter(m => !options['--unseen'] || (['delivered', 'seen'].includes(m.status) && !m.presentedAt));
    out(options['--json'] ? JSON.stringify(mails) : mails.map(m => `${m.id} / from=${m.from} / ${m.kind} / ${m.why}\n${m.body}`).join('\n'));
    let shown = 0;
    for (const mail of mails) if (presentMail({ home, id: mail.id, sessionId: 'inbox', now, autoAck: false })) shown++;
    if (shown) {
      try {
        const child = (deps.spawnImpl ?? spawn)(process.execPath, [fileURLToPath(import.meta.url), '--sync-pending'], {
          ...backgroundSpawnOptions(deps.platform), stdio: 'ignore', env: { ...process.env, ORGIAST_HOME: home },
        });
        child.on('error', () => err('fleet-mail: 同期起動失敗=1')); child.unref();
      } catch { err('fleet-mail: 同期起動失敗=1'); }
    }
    return 0;
  }
  if (options['--ack']) {
    const mails = options['--all-seen'] ? readInbox(home).filter(m => !hasDecisionRequest(m) && (m.presentedAt || m.seenAt || m.status === 'seen')) : [readJson(inboxFile(options['--ack']))];
    if (mails.some(m => !m)) throw new Error('inbox に該当メッセージがありません');
    for (const mail of mails) commandInbox(mail.id, current => current, { home });
    let done = 0;
    for (const mail of mails) {
      await state(mail.id, 'ack', { command: true });
      if (readJson(inboxFile(mail.id))?.status === 'done') done++;
    }
    out(`完了=${done}`); return 0;
  }
  if (options['--sweep']) {
    let done = 0, expired = 0;
    for (const mail of readInbox(home, { unreadOnly: false })) {
      if (mail.status === 'done' || mail.status === 'failed' || mail.serverSyncedAt || hasDecisionRequest(mail)) continue;
      if (Date.parse(mail.expiresAt) <= now()) { await state(mail.id, 'fail', { reason: 'expired' }); expired++; }
      else if ((mail.id.startsWith('mail-reply-') && Date.parse(mail.createdAt) < now() - 72 * 3600000)
        || /^\s*\[回答・返信不要\]/.test(mail.why) || /^\s*\[回答・返信不要\]/.test(mail.body)) { await state(mail.id, 'ack'); done++; }
    }
    out(`完了=${done} / 期限切れ=${expired}`); return 0;
  }
  if (options['--reply']?.startsWith('mail-reply-') && !options['--force']) { err('fleet-mail: 返信メールへの返信は拒否（意図的な返信のみ --force）'); return 3; }
  if (!configured && !options['--dry-run'] && !options['--send']) { err('fleet-mail: fleet-sheet.env 未設定のためスキップ'); return 0; }
  if (options['--sent-status']) {
    // 読み取りのみ: 返信が相手の受信タスクに拾われたか（deliveredAt）と返信済みか（resultAt）を確認する。
    const id = options['--sent-status'];
    const result = await request('mail-get', { id });
    const mail = result?.mail;
    if (!mail) { err(`fleet-mail: ${id} はサーバーに見つかりません`); return 4; }
    out([`id: ${mail.id}`, ...['status', 'createdAt', 'expiresAt', 'deliveredAt', 'deliveredBy', 'seenAt', 'seenBy', 'resultAt', 'ackAt', 'failedAt', 'failReason'].map(key => `${key}: ${mail[key] || '(なし)'}`)].join('\n'));
    return 0;
  }
  if (options['--answer']) {
    if (process.env.CLAUDE_HEADLESS === '1' || process.env.ORGIAST_HEADLESS_JOB) { err('fleet-mail: 判断代行拒否=1'); return 2; }
    const id = options['--answer'];
    commandInbox(id, current => current, { home });
    const original = checked(await request('mail-get', { id })).mail;
    if (original?.to !== label) { err('fleet-mail: 回答対象の宛先が自ラベルと一致しません'); return 2; }
    let meta = original?.meta;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    const relay = meta?.relay;
    if (!relay || !hasDecisionRequest(original)) {
      err(`手動の判断依頼です。node tools/fleet-mail.mjs --send --to ${original?.from || '<from>'} --kind note --body-file <file> --why "回答" を使ってください`);
      return 2;
    }
    validSessionId(relay.sessionId);
    if (!original.from) throw new Error('invalid relay metadata');
    if (!validExecCwd(relay.cwd) || /[\r\n]|-->/.test(relay.cwd)) { err('fleet-mail: bad-cwd（存在する .git 付きディレクトリが必要）'); return 2; }
    const answerFile = path.join(dir, 'fleet-answers', `${id}.json`);
    if (terminal(original) && (original.status !== 'done' || !readJson(answerFile))) {
      saveLocalCompletion(home, id, { status: original.status, ...(original.ackAt ? { ackAt: original.ackAt } : {}) }, ['ack'], err);
      out('回答対象終了=1'); return original.status === 'done' ? 0 : 2;
    }
    const rawAnswer = fs.readFileSync(options['--body-file'], 'utf8');
    const answerDigest = createHash('sha256').update(rawAnswer).digest('hex');
    const answerBody = `<!-- fleet-exec: claude -->\n<!-- fleet-exec-cwd: ${relay.cwd} -->\n<!-- fleet-resume: ${relay.sessionId} -->\n${redactSecrets(rawAnswer).slice(0, 18000)}`;
    let release;
    for (let attempt = 0; attempt <= COMMAND_LOCK_RETRIES; attempt++) {
      release = acquireLock(`${answerFile}.lock`, { now });
      if (release || attempt === COMMAND_LOCK_RETRIES) break;
      await sleep(COMMAND_LOCK_DELAY_MS);
    }
    if (!release) throw Object.assign(new Error('lock busy'), { code: 'INBOX_BUSY' });
    try {
      let payload = readJson(answerFile);
      const sameAnswer = payload?.body === answerBody && (!payload.answerDigest || payload.answerDigest === answerDigest);
      if (payload && !sameAnswer && !options['--force']) { err('本文が前回と異なる。変更して送るには --force が必要です'); return 3; }
      if (sameAnswer) out('前回の回答を再送');
      if (!sameAnswer) {
        payload = { id: `mail-answer-${createHash('sha256').update(`${id}\n${label}\n${answerDigest}`).digest('hex').slice(0, 24)}`,
          from: label, to: original.from, messageKind: 'prompt', exec: 'claude', resumeSessionId: relay.sessionId, execCwd: relay.cwd,
          body: answerBody, answerDigest,
          why: 'hub からの回答・セッション再開', auto: false, hop: 0, priority: 'urgent',
          expiresAt: new Date(now() + 6 * 3600000).toISOString() };
        writeJson(answerFile, payload);
      }
      log('sent', { action: 'send-attempt', id: payload.id, to: payload.to, exec: 'claude' });
      const sent = checked(await request('mail-send', payload));
      if (['failed', 'expired'].includes(sent.mail?.status)) throw new Error('回答の送信期限切れまたは実行失敗');
      log('sent', { action: 'sent', id: payload.id, to: payload.to, exec: 'claude' });
      checked(await request('mail-ack', { id, from: label }));
      saveLocalCompletion(home, id, { status: 'done', ackAt: new Date(now()).toISOString() }, ['ack'], err);
      out(`回答送信済み: ${payload.id}`);
      return 0;
    } finally { release(); }
  }
  if (options['--send']) {
    let pcMap = deps.pcMap;
    if (pcMap === undefined) {
      try { pcMap = readJson(new URL('../fleet-pc-map.json', import.meta.url)); }
      catch { /* Beacon labels can still resolve exact targets when the roster is unavailable. */ }
    }

    // ビーコン取得は1回だけ（解決と鮮度表示で共有）。
    let beaconPromise;
    const sharedBeacons = async args => {
      if (options['--dry-run'] && !deps.fetchBeacons) return { ok: false, beacons: [] };
      beaconPromise ??= Promise.resolve().then(async () => (deps.fetchBeacons ?? (await import('./fleet-beacon.mjs')).fetchBeacons)(args));
      return beaconPromise;
    };
    let beacons = [];
    try { beacons = (await sharedBeacons({ home })).beacons || []; } catch {}
    const target = resolveMailTarget(options['--to'], pcMap, beacons);
    if (!target.resolved) { err(`fleet-mail: 宛先 ${options['--to']} は完全一致しません。候補: ${target.candidates.join(', ') || '(なし)'}`); return 4; }
    if (!configured && !options['--dry-run']) { err('fleet-mail: fleet-sheet.env 未設定のためスキップ'); return 0; }
    if (target.to !== options['--to']) err(`${options['--to']} → ${target.to}`);
    const deliverable = await resolveDeliverableTarget({ to: target.to, home, now, fetchBeacons: sharedBeacons, pcMap });
    if (deliverable.status === 'redirect') { err(deliverable.text); target.to = deliverable.to; }
    else if (deliverable.status === 'none' && !options['--force']) {
      err(`fleet-mail: 宛先 ${target.to} には poll 実績が無く、同一実機のラベルにも無いため送信しません（未配達になる）。poll 実績のあるラベル: ${deliverable.labels.join(', ') || '(なし)'}。意図的に送るときだけ --force`);
      return 6;
    }
    let id = mailId(now, deps.randomBytes);
    // --exec: 本文先頭にマーカー行を挿入して受信側に実行モードを伝える（本文ファイル自体は変更しない）。
    let body = redactSecrets(fs.readFileSync(options['--body-file'], 'utf8')).slice(0, 20000);
    if (options['--exec']) {
      const markers = [`<!-- fleet-exec: ${options['--exec']} -->`];
      if (options['--exec-cwd'] !== undefined) markers.push(`<!-- fleet-exec-cwd: ${options['--exec-cwd']} -->`);
      if (options['--resume']) markers.push(`<!-- fleet-resume: ${options['--resume']} -->`);
      body = `${markers.join('\n')}\n${body}`;
    }
    // 全PCの設定変更・インストール・ファイル書き込みの依頼は fleet-mail で配らず setup --converge に載せる。
    // 相談・確認（--kind note）や、意図的な再送（--force）は通す。
    if (options['--kind'] === 'prompt' && !options['--force'] && looksLikeInstallRequest(parseExecMarkers(body).body)) {
      err('全PCの設定変更は setup --converge 経由。fleet-mail は相談・確認用。');
      return 5;
    }
    // 宛先が受信できているかを送信前に見せる（2026-10-10 事故: 受信タスク停止で返事が永遠に届かない）。
    // 取得失敗・未設定でも送信は続行する（fail-open）。
    try {
      const freshness = await (deps.describeTargetFreshness ?? describeTargetFreshness)({ to: target.to, home, now, fetchBeacons: sharedBeacons, pcMap });
      err(freshness.text);
      if (freshness.stale) err('⚠ 宛先は24時間以上 poll していない可能性。返信が遅れます');
    } catch (error) {
      err(`宛先 ${target.to}: 最終 poll 不明（ビーコン取得失敗: ${redactSecrets(error?.message || error)}）`);
    }
    // Explicit executors share the six-hour delivery window.
    const defaultExpiresHours = options['--exec'] ? 6 : 24;
    const payload = { id, from: label, to: target.to, messageKind: options['--kind'],
      ...(options['--exec'] ? { exec: options['--exec'], execCwd: options['--exec-cwd'], resumeSessionId: options['--resume'] } : {}),
      body, why: redactSecrets(options['--why']), auto: false, hop: 0,
      priority: options['--priority'] === 'urgent' || /\[(判断依頼|作業依頼)\]/.test(options['--why']) || /^\s*\[(判断依頼|作業依頼)\]/.test(parseExecMarkers(body).body) ? 'urgent' : 'normal',
      expiresAt: new Date(now() + Number(options['--expires-hours'] ?? defaultExpiresHours) * 3600000).toISOString() };
    if (options['--dry-run']) { out(JSON.stringify(payload)); return 0; }
    for (let attempt = 0; attempt < 2; attempt++) {
      payload.id = id;
      log('sent', { action: 'send-attempt', ...payload, ...(options['--exec'] ? { exec: options['--exec'] } : {}) });
      let result;
      try { result = checked(await request('mail-send', payload)); }
      catch (error) {
        if (/^(?:fleet-mail: )?busy$/.test(error.message)) {
          err('fleet-mail: busy（ロック取得失敗）。送信されていない。');
          return 1;
        }
        if (/read-back mismatch/.test(error.message)) {
          err(`fleet-mail: read-back mismatch。行は作成済みの可能性。--sent-status ${id} で確認`);
          return 1;
        }
        throw error;
      }
      if (!result.duplicate) break;
      if (attempt === 1) { err('fleet-mail: ID 重複（再送上限）'); return 1; }
      id = mailId(now, deps.randomBytes);
    }
    log('sent', { action: 'sent', id, to: payload.to, ...(options['--exec'] ? { exec: options['--exec'] } : {}) });
    err(`状態確認: node tools/fleet-mail.mjs --sent-status ${id}`);
    if (options['--wait'] !== undefined) {
      err(`送信済み: ${id}`);
      const result = await waitForReply(id, Number(options['--wait']), { request, now, sleepImpl: deps.sleep, waitFor: options['--wait-for'] || 'done' });
      out(result.text); return result.exitCode;
    }
    out(`送信済み: ${id}`); return 0;
  }
  if (options['--reply']) {
    const id = options['--reply'];
    const body = redactSecrets(fs.readFileSync(options['--body-file'], 'utf8')).slice(0, 20000);
    if (!options['--force']) {
      const prior = findPriorReply(dir, id);
      if (prior !== null) {
        err(`fleet-mail: ${id} は ${prior.at ?? '日時不明'} に返信済み（${prior.action}）のため送信しません。意図的に再送するときだけ --force`);
        return 3;
      }
    }
    const parent = commandInbox(id, current => current, { home });
    const original = parent || checked(await request('mail-get', { id })).mail;
    const response = original?.status === 'failed'
      ? checked(await request('mail-send', { id: `mail-reply-manual-${createHash('sha256').update(`${id}\n${label}\n${body}`).digest('hex').slice(0, 24)}`, from: label, to: original.from, replyTo: id, messageKind: 'note', body, why: '[回答・返信不要] 対話回答', auto: false, hop: nextHop(original), priority: 'normal', expiresAt: new Date(now() + 72 * 3600000).toISOString() }))
      : checked(await request('mail-reply', { id, from: label, resultBody: body, auto: false, hop: parent ? nextHop(parent) : 1, priority: 'normal' }));
    if (['failed', 'expired'].includes(response?.mail?.status)) {
      if (parent) updateInbox(id, current => current && ({ ...current, status: response.mail.status }), { home });
      err(`fleet-mail: 返信なし（${response.mail.status}）`); return 1;
    }
    log('sent', { action: 'reply', id, ...(options['--force'] ? { forced: true } : {}) });
    const nowISO = new Date(now()).toISOString();
    saveLocalCompletion(home, id, { status: 'done', resultAt: response?.mail?.resultAt || nowISO,
      resultBody: redactSecrets(response?.reply?.body ?? response?.mail?.resultBody ?? body), readAt: parent?.readAt ?? nowISO }, original?.status === 'failed' ? ['fail'] : [], err);
    out(`返信済み: ${id}`);
    out(`返信は相手の受信タスクが拾うまで届きません。届いたかは --sent-status ${id} で確認`);
    return 0;
  }
  await pollOnce({ ...deps, executePrompts: options['--no-exec'] ? false : deps.executePrompts, dryRun: !!options['--dry-run'], json: !!options['--json'] });
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`fleet-mail: ${redactSecrets(error.message)}`); process.exitCode = 1; }
}
