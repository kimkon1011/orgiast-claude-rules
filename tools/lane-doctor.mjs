#!/usr/bin/env node
import { isAutoDisabled, readDisabledEntries, restoreExpiredDisabledLanes } from './lib/lane-disabled.mjs';
import { wslInstalled } from './lib/wsl-present.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { codexAuthStatusAny } from './codex-auth-status.mjs';
import { loadEnvKey, loadGeminiKey, loadDeepseekKey } from './codex-do.mjs';
import { providerResetUntil } from './codex-cooldown.mjs';
import { isDailyQuotaResponse, nextUtcMidnight } from './lib/provider-daily-cooldown.mjs';
import { notifyKim } from './notify-kim.mjs';
import { redactAll } from './lib/redact.mjs';
import { catalog } from './provider-catalog.mjs';
import { applyRealLaneHealth, laneErrorText, probeViaChain, billingFailure, billingWithQuotaHint, quotaFailure, retiredModel } from './lib/lane-real-health.mjs';
import { readEnvValue } from './env-kv.mjs';
import { isEnrollToken, validKeyservePcId } from './keyserve-auth.mjs';

export const PROVIDERS = ['codex', 'gemini', 'deepseek', 'glm', 'groq', 'openrouter'];
// 任意レーン: キーがあるPCだけ実測する（2026-10-29 mistral 既定モデル 403 が未監視で放置された）。
export const OPTIONAL_PROVIDERS = ['mistral', 'grok'];
const isLane = p => PROVIDERS.includes(p) || OPTIONAL_PROVIDERS.includes(p);
export const laneHome = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
const repo = fileURLToPath(new URL('../', import.meta.url));
export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
const MAX_HISTORY_RESET_MS = 7 * 86400_000;
const time = v => typeof v === 'number' ? v : Date.parse(v);
export const freshProbe = (v, now = Date.now()) => Number.isFinite(time(v)) && now - time(v) >= 0 && now - time(v) < 30 * 60_000;
// Migrate successful probes written before lastProbeOkAt was introduced.
function probeHistory(state = {}) {
  const lastProbeOkAt = state.lastProbeOkAt ||
    (state.alive && /^(?:auth_ok:)?probe_ok(?::stale)?$/.test(state.reason) ? state.probedAt : undefined);
  return {
    ...Object.fromEntries(['viaChain', 'probeResult', 'probeEvidence', 'billingProbeStreak'].filter(key => state[key] !== undefined).map(key => [key, state[key]])),
    ...(state.probedAt ? { probedAt: state.probedAt } : {}),
    ...(lastProbeOkAt ? { lastProbeOkAt } : {}),
    ...(state.probeReason || state.probedAt ? { probeReason: state.probeReason || state.reason } : {}),
  };
}
function history(home, name) {
  const file = path.join(home, '.claude', name);
  try {
    const fd = fs.openSync(file, 'r');
    try { const size = fs.fstatSync(fd).size, n = Math.min(size, 65536), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n);
      return b.toString().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}
function executable(name) {
  return (process.env.PATH || '').split(path.delimiter).some(dir => ['', '.cmd', '.exe'].some(ext => {
    try { fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK); return true; } catch { return false; }
  }));
}
const REPAIR_STEPS = ['node tools/lane-doctor.mjs --probe で停止原因を確認し、その場で修復する'];
const KEYSERVE_STEPS = ['1) node tools/keyserve-status.mjs で確認', '2) ~/.claude/enroll.env があれば node tools/onboarding-sync.mjs --force', '3) 無ければ依頼して待たず、当ターンで ListAgents → issuer PC（ORGIAST_ENROLL_ISSUER_PCS 登録PC=kim-PC 等。keyserve-status の 200 は issuer の証拠にならない）のセッションへ SendMessage し node tools/keyserve-enroll.mjs --pc <このPC> --ttl-hours 2 --json を即実行させ、返った1行コマンドを Claude が実行する（kim への通知は並行の保険）', '4) node tools/lane-doctor.mjs --probe で復旧確認。復旧するまで通常タスクに戻らない'];
function keyserveEnrolled(home, env = process.env) {
  const secret = env.ORGIAST_KEYSERVE_SECRET || readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET');
  return Boolean(secret && !isEnrollToken(secret));
}
// 手動停止と未診断の自動停止をルーティング候補から外す。
// quick と probe の両経路で、実績反映（applyRealLaneHealth）の後に必ず掛け直す。
export function applyDisabledLanes(health, home = laneHome(), now = Date.now()) {
  if (!health.lanes) return health;
  for (const [name, entry] of Object.entries(readDisabledEntries(home))) {
    const until = Number(entry?.until);
    const expired = Number.isFinite(until) && until <= now;
    const state = { alive: false, reason: expired ? 'disabled:expired' : 'disabled', ...(Number.isFinite(until) ? { until } : {}) };
    const targets = [name];
    if (name === 'gemini') targets.push('gemini-cli');
    if (name === 'openrouter') targets.push('openrouter-free', 'openrouter-code');
    for (const p of targets) {
      const lane = health.lanes[p];
      if (!lane || (isAutoDisabled(entry) && ['billing', 'quota_wait'].includes(lane.reason))) continue;
      health.lanes[p] = state;
    }
  }
  return health;
}
function orders(health, home = laneHome()) {
  health.implementOrder = ['codex', 'deepseek', 'glm', 'gemini-cli', 'openrouter'].filter(p => health.lanes[p]?.alive);
  // 旧 payment_required の扱いは維持し、billing は専用の日次通知と代替ルートに回す。
  const billing = readJson(path.join(repo, 'tools/provider-billing.json'));
  const needsUser = ([p, s]) => isLane(p) && /^(?:dead:)?(?:payment_required|oauth_consent|account_creation|physical_operation)$/.test(s.reason)
    && !(s.reason.includes('payment') && billing[p]?.autoTopUp === false);
health.substituted = Object.entries(health.lanes).filter(([p, s]) => isLane(p) && (s.reason === 'billing' || s.reason?.includes('payment') && billing[p]?.autoTopUp === false && health.lanes.openrouter?.alive
    || p === 'gemini' && s.reason === 'missing_key' && health.lanes.openrouter?.alive))
    .map(([provider]) => ({ provider, via: 'openrouter' }));
  for (const { provider, via } of health.substituted) health.lanes[provider].via = via;
  // 安い順。Gemini は恒久停止せず同列の受け皿。失敗・回数制限時だけ一時退避し、回復後に戻す。Claude 本体はこの順に含めない。
  health.askOrder = ['groq', 'deepseek', 'openrouter', 'gemini'].filter(p => {
    const lane = health.lanes[p];
    if (!lane) return false;
    // billing は via chain で解決できない（Google 側の残高不足を OpenRouter が肩代わりできない）
    if (lane.reason === 'billing') return false;
    return lane.alive || lane.via === 'openrouter' && health.lanes.openrouter?.alive;
  });
  health.deadNeedsUser = Object.entries(health.lanes).filter(needsUser)
    .map(([provider, s]) => ({ provider, reason: s.reason, tried: s.tried, fix: s.userFix || (s.reason.includes('payment') ? '無料枠・既存契約内の他AIレーンを実測して先に切り替える。追加費用案は代替不可の証拠と比較表がある場合だけ最後に提示。' : '本人アカウントで認証画面を開き OAuth 同意を完了する。') }));
  const missing = Object.entries(health.lanes).filter(([p, s]) => PROVIDERS.includes(p) && s.reason === 'missing_key' && s.via !== 'openrouter').map(([p]) => p);
  const reasons = [...(!health.askOrder.length ? ['ask_order_empty'] : []), ...(!health.implementOrder.length ? ['implement_order_empty'] : []), ...(missing.length ? [`missing_key:${missing.join(',')}`] : [])];
  const unenrolled = missing.length > 0 && !keyserveEnrolled(home);
  if (unenrolled) {
    reasons.push('keyserve_unenrolled');
    health.deadNeedsUser.push({ provider: 'keyserve', reason: 'keyserve_unenrolled', fix: 'kim-PC で enroll トークンを発行し、返信された1行コマンドを Claude が実行する。' });
  }
  health.repairFirst = { required: reasons.length > 0, reasons, steps: unenrolled ? KEYSERVE_STEPS : reasons.length ? REPAIR_STEPS : [] };
  return health;
}
function persist(file, value, health) {
  try { atomicJson(file, value); return true; } catch (e) { health.errors.push(`${path.basename(file)}: ${e.code || 'write_failed'}`); return false; }
}
export function laneDoctorQuick({ home = laneHome(), now = Date.now(), save = true, platform = process.platform, spawnImpl = spawnSync } = {}) {
  const dir = path.join(home, '.claude');
  const old = readJson(path.join(dir, 'lane-health.json'));
  const health = { ts: new Date(now).toISOString(), probedAt: old.probedAt || null, lanes: {}, implementOrder: [], askOrder: [], repairs: (old.repairs || []).filter(r => typeof r === 'string' && old.lanes?.codex?.alive), deadNeedsUser: [], errors: [], ignored: [] };
  const cooldown = readJson(path.join(dir, 'provider-cooldown.json')), routing = readJson(path.join(dir, 'routing-overrides.json'));
  const limits = [...history(home, 'provider-limit-history.jsonl'), ...history(home, 'codex-limit-history.jsonl').filter(x => !x.provider || x.provider === 'codex').map(x => ({ ...x, provider: 'codex' }))].filter(x => {
    if (time(x.until) > now + MAX_HISTORY_RESET_MS) {
      health.ignored.push({ provider: x.provider, reason: 'until_beyond_7d', until: x.until });
      return false;
    }
    return true;
  });
  const expiredBlocks = new Set();
  for (const [name, state] of [['provider-cooldown.json', cooldown], ['routing-overrides.json', routing.demote || {}]]) {
    const repairs = [], removed = {};
    for (const p of PROVIDERS) {
      const until = time(name.startsWith('routing') ? state[p]?.until ?? state[p] : state[p]?.until);
      if (state[p] !== undefined && Number.isFinite(until) && until <= now) { removed[p] = state[p]; delete state[p]; expiredBlocks.add(p); repairs.push({ provider: p, action: name.startsWith('routing') ? 'demote_removed' : 'cooldown_removed', detail: '期限切れ' }); }
    }
    if (repairs.length) {
      if (!save || persist(path.join(dir, name), name.startsWith('routing') ? routing : cooldown, health)) health.repairs.push(...repairs);
      else Object.assign(state, removed);
    }
  }
  const keys = { gemini: loadGeminiKey(home), deepseek: loadDeepseekKey(home), glm: loadEnvKey(home, 'zai.env', 'ZAI_API_KEY'), groq: loadEnvKey(home, 'groq.env', 'GROQ_API_KEY'), openrouter: loadEnvKey(home, 'openrouter.env', 'OPENROUTER_API_KEY'), mistral: loadEnvKey(home, 'openrouter.env', 'OPENROUTER_API_KEY'), grok: loadEnvKey(home, 'xai.env', 'XAI_API_KEY') };
  for (const p of [...PROVIDERS, ...OPTIONAL_PROVIDERS.filter(o => keys[o])]) {
    const configured = p === 'codex' ? codexAuthStatusAny(home, { platform, spawnImpl }).login : !!keys[p];
    const previous = { ...(old.lanes?.[p] || {}) }, evidence = probeHistory(previous);
    // A cached quota label/until alone is not provider-local evidence.
    if (/quota_wait|cooldown|usage_limit/.test(previous.reason || '') && !quotaFailure(previous.error)) {
      previous.alive = configured;
      previous.reason = configured ? 'configured:unprobed' : 'missing_key';
      delete previous.until;
    }
    const recent = limits.filter(x => x.provider === p && time(x.until) > now && !(time(evidence.lastProbeOkAt) >= time(x.t ?? x.ts ?? x.at))).at(-1);
    const blocked = cooldown[p] || recent;
    let state = { alive: configured, reason: configured ? 'configured:unprobed' : p === 'codex' ? 'dead:oauth_consent' : 'missing_key' };
const paymentFresh = old.lanes?.[p]?.reason === 'dead:payment_required' && Number.isFinite(time(old.lanes[p].probedAt)) && now - time(old.lanes[p].probedAt) < 86400_000;
    if (old.lanes?.[p]?.reason === 'billing' || paymentFresh || (old.lanes?.[p]?.reason === 'dead:physical_operation' && old.lanes?.[p]?.error)) state = { ...previous };
    else if (blocked && time(blocked.until) > now) state = { alive: false, reason: blocked.reason || 'cooldown', until: blocked.until };
    else if (routing.demote?.[p]) state = { alive: false, reason: 'demoted', until: routing.demote[p]?.until ?? routing.demote[p] };
    else if (configured && /cooldown|usage[_ ]?limit/i.test(evidence.probeReason || '') && (expiredBlocks.has(p) || !previous.until || time(previous.until) <= now)) state = { alive: false, reason: 'configured:unprobed' };
    else if (configured && old.lanes?.[p]?.reason === 'dead:payment_required') state = { alive: false, reason: 'configured:unprobed' };
    else if (configured && previous.reason === 'model_retired') state = { ...previous };
    else if (configured && freshProbe(old.lanes?.[p]?.probedAt, now) && !(old.lanes[p].until && time(old.lanes[p].until) <= now)) state = { ...previous };
    else if (configured && evidence.lastProbeOkAt && !/^(?:auth_ok:)?probe_ok(?::stale)?$|^native_ok$/.test(evidence.probeReason || '')) state = { alive: false, reason: 'probe_failed:stale' };
    else if (configured && evidence.lastProbeOkAt) state = { alive: true, reason: 'probe_ok:stale' };
    else if (configured && evidence.probedAt) state = previous.until && time(previous.until) <= now
      ? { alive: true, reason: 'probe_expired' } : { ...previous };
    health.lanes[p] = { ...state, ...evidence };
  }
  applyRealLaneHealth(health, home, now);
  // API key の生存と CLI の有無は別条件。CLI が無い場合は実装候補にしない。
  health.lanes['gemini-cli'] = directGeminiCliState(health.lanes.gemini, executable('gemini'));
  applyDisabledLanes(health, home, now);
orders(health, home);
  if (!health.lanes.deepseek.alive && health.lanes.deepseek.reason === 'dead:payment_required' && health.lanes.openrouter?.alive) health.lanes.deepseek.via = 'openrouter';
  if (save) { demoteBilling(health, home, now); persist(path.join(dir, 'lane-health.json'), health, health); }
  return health;
}
// WSL の列挙失敗はディストリ無しと決めつけない。
export function listWslDistros() {
  if (!wslInstalled()) return '';
  const r = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le', windowsHide: true, timeout: 15000 });
  return r.status === 0 ? String(r.stdout || '').replace(/\0/g, '').trim() : null;
}
// win32 かつ WSL ディストリが 0 件の PC では codex-do の WSL 経路が使えない。この場合に
// --allow-native を付けないと probe が必ず abort し、lane-health が ok にならない（§1.18.4）。
// 実機の distro 有無でテストが非決定的にならないよう、codex-do と同じ流儀で env 注入できる。
export function needsNativeCodexProbe({ platform = process.platform, env = process.env, spawn = spawnSync } = {}) {
  if (platform !== 'win32') return false;
  const fake = env.LANE_DOCTOR_WSL_PROBE;
  if (fake) return fake === 'absent';
  try {
    const listed = spawn('wsl', ['-l', '-q'], { windowsHide: true, encoding: 'utf16le', timeout: 15000 });
    if (listed.status !== 0) return true;
    const distros = String(listed.stdout || '').split(/\r?\n/).map(x => x.replace(/\0/g, '').trim()).filter(Boolean);
    return distros.length === 0;
  } catch { return true; }
}
export function nativeWriteProbeArgs({ repo, cwd, timeoutMs, instruction }) {
  // --kind を明示しないと codex-do が investigate と判定し llm-ask へ流れ、書き込み不能でレーン死亡と誤判定する（2026-10-22 実測）。
  return [path.join(repo, 'tools/codex-do.mjs'), instruction, '--cwd', cwd, '--kind', 'implement', '--force-native', '--no-fallback', '--no-escalate', '--timeout', String(Math.max(1, Math.floor(timeoutMs / 1000)))];
}
export const NATIVE_WRITE_PROBE_TIMEOUT_MS = 180_000;
// Codex の書き込み点検は固定フォルダーで行う。一時フォルダー（lane-codex-write-*）を毎回作ると、
// ChatGPT(Codex) アプリが新しいフォルダーとして「このフォルダーを信頼しますか？」を毎回出すため（2026-11-19 金さん指摘）。
// フォルダー自体は残し、中身だけ毎回前後で空にする。ORGIAST_LANE_PROBE_DIR で上書き可（テスト用）。
export function laneProbeWorkDir({ env = process.env, homedir = os.homedir() } = {}) {
  return env.ORGIAST_LANE_PROBE_DIR || path.join(homedir, 'gb-offload', 'lane-doctor-work');
}
export function resetLaneProbeWorkDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  return dir;
}
// Codex の書き込み結果を read-back の成否で評価する。exit code が 0 でなくても
// read-back が成功していれば生存と判定する（2026-11-18 PR#2331）。
export function nativeWriteProbeResult(result, readBackOk) {
  if (readBackOk) return { viaChain: false, code: 0, text: `WRITE_OK${result.code === 0 ? '' : ` exit=${result.code}`}` };
  return { viaChain: probeViaChain(result.text, 'codex'), code: 1, text: `書き込み確認失敗 ${result.text || ''}` };
}
export async function runNativeWriteProbe({ home, timeoutMs, workDir = laneProbeWorkDir() }) {
  const cwd = resetLaneProbeWorkDir(workDir);
  const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { cwd, env: { ...process.env, ORGIAST_HOME: home, CODEX_DO_CHEAP_FIRST: '0', CODEX_DO_SKIP_CURSOR_AGENT: '1' }, timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (e, stdout, stderr) => {
    const output = `${stdout || ''}\n${stderr || ''}`.trim();
    if (e?.killed || e?.signal) return resolve({ code: 1, timedOut: true, text: `タイムアウト(${Math.ceil(timeoutMs / 1000)}s) ${output}`.trim() });
    resolve({ code: e ? 1 : 0, text: output });
  }));
  try {
    const init = await run('git', ['init', '--quiet']);
    if (init.code) return { ...init, text: `git init 失敗 ${init.text || ''}`.trim() };
    const instruction = 'WRITE_OK.txt を作成し、内容を WRITE_OK にしてください。その後ファイルを読み返して確認してください。';
    const result = await run(process.execPath, nativeWriteProbeArgs({ repo, cwd, timeoutMs, instruction }));
    let ok = false;
    try { ok = fs.readFileSync(path.join(cwd, 'WRITE_OK.txt'), 'utf8').trim() === 'WRITE_OK'; } catch {}
    return nativeWriteProbeResult(result, ok);
  } finally { try { resetLaneProbeWorkDir(cwd); } catch {} }
}
export function runProbe(provider, { home, timeoutMs, dryRun = false, probeAutoDisabled = false, execFileImpl = execFile } = {}) {
  const args = provider === 'codex'
    ? [path.join(repo, 'tools/codex-do.mjs'), 'Reply with exactly: PONG. Do not modify any files.', '--cwd', repo, '--kind', 'implement', '--no-fallback', '--no-escalate', ...(needsNativeCodexProbe() ? ['--allow-native'] : []), ...(dryRun ? ['--dry-run'] : ['--timeout', String(Math.max(1, Math.floor(timeoutMs / 1000)))])]
    : [path.join(repo, 'tools/llm-ask.mjs'), '--provider', provider, 'Reply with exactly: PONG', '--max', '64', '--no-fallback'];
  const { CODEX_DO_SKIP_CURSOR_AGENT: _skipCursorAgent, ...baseEnv } = process.env;
  const env = { ...baseEnv, ORGIAST_HOME: home, CODEX_DO_CHEAP_FIRST: '0', ORGIAST_LANE_DOCTOR_PROBE_PROVIDER: probeAutoDisabled ? provider : '', ...(provider === 'codex' ? { CODEX_DO_SKIP_CURSOR_AGENT: '1' } : {}) };
  return new Promise(resolve => execFileImpl(process.execPath, args, { cwd: repo, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true }, (e, stdout, stderr) => resolve({ code: e ? e.code || 1 : 0, text: redactAll(`${stdout}\n${stderr}`) })));
}
export function notificationText(item, home) {
  if (item.reason === 'keyserve_unenrolled') {
    const hostname = os.hostname(), pc = validKeyservePcId(hostname) ? hostname : 'PC名要指定', user = os.userInfo().username;
    return `${hostname}（OSユーザー: ${user}）は keyserve 未登録のため安価AIレーンの鍵を取得できません。Claude が kim-PC 側で登録コマンドを発行します。対象PCでその1行を貼り付けて承認すると、Claude が復旧確認まで行います。`;
  }
  if (item.reason === 'billing' && item.provider !== 'gemini') return `${os.hostname()} の ${item.provider} が残高不足(402)。まず無料枠・既存契約内の他AIレーンを実測し、使える経路へ切り替えます。追加費用案は代替不可の証拠と比較表がある場合だけ最後に提示します`;
  if (item.tried) return `${item.provider} が停止しています（原因: WSL ディストリ不在・ネイティブ書き込み probe 失敗）。試した修復: ${item.tried}。残る操作: ${item.fix}`;
  if (item.provider === 'gemini') {
    let owner = '';
    for (const f of [path.join(home, '.claude/gemini.env'), path.join(home, '.gemini/.env')]) {
      try { const comments = fs.readFileSync(f, 'utf8').split('\n').filter(l => /^\s*#/.test(l)).join('\n'); owner = comments.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] || owner; } catch {}
    }
    owner ||= 'seisaku-team@orgiast.jp（TrackPlanner、未確認なら AI Studio で確認）';
    return `Gemini が残高不足(402)で停止しています（${item.reason}）。
まず無料枠・既存契約内の他AIレーンを実測し、使える経路へ切り替えます（成功未確認の経路を稼働済みと断定しません）。
残高・設定の読取確認: ${owner} で https://aistudio.google.com/billing
追加費用案は無料・既存経路が使えない実測理由を示せた場合だけ比較表の最後に提示します。
根拠: https://ai.google.dev/gemini-api/docs/billing`;
  }
  const urls = { codex: 'https://chatgpt.com/', deepseek: 'https://platform.deepseek.com/', glm: 'https://z.ai/', groq: 'https://console.groq.com/', openrouter: 'https://openrouter.ai/', mistral: 'https://console.mistral.ai/', grok: 'https://console.x.ai/' };
  // 所有アカウントはカタログを正本にする。固定文の「未確認」で送ると kim がどこで開くか分からない（2026-10-25 DeepSeek 停止通知）。
  const owner = catalog.find(s => s.id === item.provider)?.account;
  const account = item.provider === 'codex' ? codexAuthStatusAny(home, item.authOptions).email || 'kim@orgiast.jp（保存認証のアカウントは未確認）'
    : owner || '[ACCOUNT-UNKNOWN] 契約アカウント（tools/ai-subscription-catalog.json に account 未登録）';
  // URL は行末に置き、直後に日本語を続けない（Discord のリンク範囲が日本語まで伸びて壊れる）。
  return `${item.provider} が停止しています（${item.reason}）。
1. **${account}** で開く: ${urls[item.provider]}
2. 右上のアカウント表示が **${account}** か確認する。
3. ${item.reason.includes('payment') ? '無料枠・既存契約内の他AIレーンを実測して先に切り替える。追加費用案は代替不可の証拠と比較表がある場合だけ最後に提示。' : 'Codex を開きログインを選択する。ブラウザーで同じアカウントを選び、OAuth の同意内容を確認して許可する。'}
4. 完了後は Claude が lane-doctor --probe で復旧を確認します。`;
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 回数制限・課金切れ・クールダウン中は実APIへ probe しない（空いている枠をヘルスチェックが食い潰すのを防ぐ）。
// until がある間は待つ。until が無いときも直近1時間は叩かず、期限到来後に1回だけ確認して自動復帰する。
export function shouldSkipLiveProbe(state = {}, now = Date.now()) {
  const reason = String(state.reason || '');
  if (reason === 'missing_key' || reason === 'disabled') return true;
  if (!/^(?:billing|quota_wait|cooldown|demoted|daily_limit|lane_doctor_usage_limit)$/.test(reason)) return false;
  const until = Number(state.until);
  if (Number.isFinite(until) && until > now) return true;
  if (Number.isFinite(until) && until <= now) return false;
  const last = Math.max(Date.parse(state.probedAt) || 0, Number(state.real24h?.lastQuotaAt) || 0, Number(state.real24h?.lastBillingAt) || 0);
  // quota_wait は月次・週次リセットの可能性があり、1時間おきのprobeでは上限枠を無駄に消費する。
  // until が分からないときは6時間に1回まで（§1.18.4: 安いAIレーンの疎通probe節約）。
  const cooldownMs = reason === 'quota_wait' ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return Number.isFinite(last) && last > 0 && now - last < cooldownMs;
}
export async function laneDoctorProbe({ home = laneHome(), now = Date.now(), probe = runProbe, notify = notifyKim, budgetMs = 90_000, platform = process.platform, listWsl = listWslDistros, nativeWriteProbe = runNativeWriteProbe, nativeTimeoutMs = NATIVE_WRITE_PROBE_TIMEOUT_MS, spawnImpl = spawnSync, providers = [], probeRetries = 1 } = {}) {
  const started = Date.now(), dir = path.join(home, '.claude');
  const health = laneDoctorQuick({ home, now, save: false, platform, spawnImpl });
  const previous = readJson(path.join(dir, 'lane-health.json'));
  const probeBudget = Math.max(1, budgetMs - 5000);
  // 各 provider を並行実測し、一つの停止レーンで90秒枠を使い切らない。
  const probeProviders = providers.length ? providers : [...PROVIDERS, ...OPTIONAL_PROVIDERS.filter(o => health.lanes[o])];
  const disabled = readDisabledEntries(home);
  const autoProbes = new Set(probeProviders.filter(p => isAutoDisabled(disabled[p])));
  const results = await Promise.all(probeProviders.map(async p => {
    const state = health.lanes[p];
    const bypassDisabled = autoProbes.has(p) && state?.reason === 'disabled';
    if (!state || (!bypassDisabled && shouldSkipLiveProbe(state, now)) || (p === 'codex' && !codexAuthStatusAny(home, { platform, spawnImpl }).login)) return [p, null];
    if (p === 'codex') {
      const wslDistros = platform === 'win32' ? await listWsl() : undefined;
      if (platform === 'win32' && (wslDistros === '' || wslDistros == null)) {
        // 1回の起動失敗で即 down→kim 通知しない。一過性のスパウン失敗は短い再試行で吸収する（2026-11-07 実測: 06:57Z failure → 07:00Z same 経路で fixed。probeRetries=1 で合計2回実行）。
        let result;
        const failures = [];
        const attempts = 1 + Number(probeRetries ?? 1);
        for (let i = 0; i < attempts; i++) {
          if (i) await sleep(1500);
          try { result = await nativeWriteProbe({ home, timeoutMs: nativeTimeoutMs }); }
          catch { result = { code: 1, text: 'ネイティブ書き込み probe 起動失敗' }; }
          if (result.code === 0) break;
          failures.push(result.text || '(出力なし)');
          if (result.timedOut) break;
        }
        const probeErrorText = result.text || '';
        if (result.code !== 0) result.text = `ネイティブ書き込み probe ${failures.length}回失敗(最終) ${failures.map((text, i) => `${i + 1}回目: ${text}`).join(' / ')}`;
        return [p, { ...result, nativeRepair: true, probeErrorText, wslDistros }];
      }
      const dry = await probe(p, { home, timeoutMs: Math.min(15000, probeBudget), dryRun: true });
      const dryOk = dry.code === 0;
      // 再利用は成功結果だけ。失敗を30分使い回すと直後に直ったレーンが停止のまま残る（2026-10-25 実測: 直接実行は PONG なのに probe_failed）。
      if (!autoProbes.has(p) && dryOk && previous.lanes?.codex?.alive && previous.lanes.codex.viaChain !== true && freshProbe(previous.lanes.codex.probedAt, now)) return [p, { cached: previous.lanes.codex, wslDistros }];
      const full = await probe(p, { home, timeoutMs: Math.max(1, probeBudget - (Date.now() - started)) });
      return [p, { ...full, ...(dryOk ? { authOk: true } : {}), wslDistros }];
    }
    // dry 失敗（コールド起動が15秒上限を超える等）で即 probe_failed にしない。残り予算の本番 probe で判定する
    // （2026-11-06/07 連日再発: 直接実行は PONG・24h実績0失敗のレーンが dry タイムアウトで停止扱いになった）。
    return [p, { ...await probe(p, { home, timeoutMs: Math.max(1, probeBudget - (Date.now() - started)), probeAutoDisabled: autoProbes.has(p) }) }];
  }));
  // probe subprocess が cooldown を更新することがあるため、完了後に再読込する。
  const cooldown = readJson(path.join(dir, 'provider-cooldown.json')), routing = readJson(path.join(dir, 'routing-overrides.json'));
  let cooldownChanged = false, routingChanged = false;
  const recovered = new Set(), classifiedAutoProbes = new Set();
  for (const [p, result] of results) {
    if (!result) continue;
    if (result.cached && !result.cached.alive) { health.lanes[p] = { ...result.cached, ...probeHistory(result.cached) }; continue; }
    const rawText = result.text || '', text = laneErrorText(rawText, p), stamp = new Date(now).toISOString();
    const model = retiredModel(rawText, p);
    if (model) {
      health.lanes[p] = { ...probeHistory(previous.lanes?.[p]), alive: false, reason: 'model_retired', model, probedAt: stamp, viaChain: false, probeResult: 'fail', probeEvidence: `HTTP 404: ${model}`, billingProbeStreak: 0, probeReason: 'model_retired', error: `HTTP 404: ${model} is unavailable` };
      continue;
    }
    const viaChain = Boolean(result.viaChain || probeViaChain(rawText, p));
    if (viaChain) {
      health.lanes[p] = { ...probeHistory(previous.lanes?.[p]), alive: false, reason: 'probe_inconclusive', probedAt: stamp, viaChain: true, probeResult: 'inconclusive', billingProbeStreak: 0, error: text };
      continue;
    }
    const nativeRepair = 'codex: WSL 不在のため Windows ネイティブ(danger-full-access)に切替';
    if (result.nativeRepair && result.code === 0 && !health.repairs.includes(nativeRepair)) health.repairs.push(nativeRepair);
    if (result.code === 0 || result.cached?.alive) {
      if (!result.cached) recovered.add(p);
      if (autoProbes.has(p)) classifiedAutoProbes.add(p);
      health.lanes[p] = result.cached
        ? { ...result.cached, ...probeHistory(result.cached) }
        : { alive: true, reason: result.nativeRepair ? 'native_ok' : p === 'codex' ? 'auth_ok:probe_ok' : 'probe_ok', probedAt: stamp, viaChain: false, probeResult: 'alive', probeEvidence: 'exit 0', billingProbeStreak: 0, lastProbeOkAt: stamp, probeReason: result.nativeRepair ? 'native_ok' : p === 'codex' ? 'auth_ok:probe_ok' : 'probe_ok' };
      if (routing.demote?.[p] !== undefined) { delete routing.demote[p]; routingChanged = true; health.repairs.push({ provider: p, action: 'demote_removed', detail: '実測成功' }); }
      if (cooldown[p]) { delete cooldown[p]; cooldownChanged = true; health.repairs.push({ provider: p, action: 'cooldown_removed', detail: '実測成功' }); }
    } else {
      const billing = billingFailure(text) && !billingWithQuotaHint(text);
      const stats = health.lanes[p]?.real24h;
      const streak = billing ? (previous.lanes?.[p]?.billingProbeStreak || 0) + 1 : 0;
      const recentSuccess = stats && stats.billingCalls === 0 && stats.lastOkAt <= now && stats.lastOkAt >= now - 6 * 3600_000;
      const uncertain = billing && !autoProbes.has(p) && recentSuccess && streak < 2;
      const payment = billing && !uncertain;
      const limited = !billing && quotaFailure(text);
      // codex-do が利用枠クールダウンで保留(exit 75)した場合は WSL 問題ではなく枠切れ。クールダウン自体は既存のまま触らない。
      const deferred = /codex_cooldown/.test(text);
      const authText = text.split(/\r?\n/).filter(line => line.length <= 2000).join('\n');
      health.lanes[p] = { ...probeHistory(previous.lanes?.[p]), alive: false, reason: uncertain ? 'probe_inconclusive' : payment ? 'billing' : (limited || deferred) ? 'cooldown' : /HTTP\s*401|unauthorized|login required|token.*expired/i.test(authText) ? (p === 'codex' ? 'dead:oauth_consent' : 'auth_invalid') : /Read-only file system|EROFS/i.test(text) ? 'execution_unavailable:read_only' : 'probe_failed', probedAt: stamp, viaChain: false, probeResult: uncertain ? 'inconclusive' : 'fail', probeEvidence: `exit ${result.code}`, billingProbeStreak: streak, ...(result.authOk ? { authOk: true } : {}) };
      // 失敗の中身を必ず残す（2026-10-15 作業用011: 理由が記録されず原因を追えなかった）
      health.lanes[p].error = String(text || '').replace(/(sk-|eyJ)[A-Za-z0-9._-]{8,}/g, '$1***').replace(/\s+/g, ' ').trim().slice(-400);
      // native の失敗でも、認証・上限・課金が原因なら physical_operation（再起動が要る）と誤判定しない
      if (result.nativeRepair && health.lanes[p].reason === 'probe_failed') {
        if (result.timedOut) health.lanes[p].reason = 'probe_failed:timeout';
        else if (/blocked by read-only sandbox|sandbox:\s*read-only|Read-only file system|EROFS/i.test(text) || /spawn .*ENOENT|codex.*not found|is not recognized/i.test(text)) Object.assign(health.lanes[p], { reason: 'dead:physical_operation', tried: 'Windows ネイティブ(danger-full-access)でファイル作成・read-back', userFix: '管理者 PowerShell で wsl.exe --install --no-distribution を実行して Windows を再起動する。' });
      }
      const wslServiceFailure = p === 'codex' && /Wsl\/Service|ERROR_SERVICE_DISABLED|LxssManager|\bHCS\b|サービスは無効|cannot be started|要素が見つかりません/i.test(text);
      const missingWslWithShortError = p === 'codex' && String(result.probeErrorText ?? text).trim().length < 5 && (result.wslDistros == null || result.wslDistros === '');
      if (health.lanes[p].reason === 'probe_failed' && (wslServiceFailure || missingWslWithShortError)) Object.assign(health.lanes[p], {
        reason: 'dead:physical_operation',
        tried: 'Codex probe と WSL ディストリビューション列挙で WSL サービス状態を確認',
        userFix: '管理者 PowerShell で LxssManager サービスを開始するか、wsl.exe --install --no-distribution を実行して Windows を再起動する。'
      });
      if (deferred && cooldown[p]?.until) health.lanes[p].until = cooldown[p].until;
      if (limited && !payment) { const daily = isDailyQuotaResponse(429, text); const until = daily ? nextUtcMidnight(new Date(now)) : providerResetUntil(text, now); cooldown[p] = { until, at: now, reason: daily ? 'daily_limit' : 'lane_doctor_usage_limit' }; cooldownChanged = true; health.lanes[p].until = until; }
      if (autoProbes.has(p) && (payment || limited)) {
        if (limited && !deferred) health.lanes[p].reason = 'quota_wait';
        classifiedAutoProbes.add(p);
      }
      health.lanes[p].probeReason = health.lanes[p].reason;
    }
  }
  if (routingChanged && !persist(path.join(dir, 'routing-overrides.json'), routing, health)) health.repairs = health.repairs.filter(r => r.action !== 'demote_removed' || r.detail !== '実測成功');
  if (cooldownChanged && !persist(path.join(dir, 'provider-cooldown.json'), cooldown, health)) health.repairs = health.repairs.filter(r => r.action !== 'cooldown_removed' || r.detail !== '実測成功');
  health.probedAt = new Date(now).toISOString();
  applyRealLaneHealth(health, home, now, classifiedAutoProbes);
  health.lanes['gemini-cli'] = directGeminiCliState(health.lanes.gemini, executable('gemini'));
  // billing は既存の OpenRouter 代替経路を使う。設定済みだけの状態では解除しない。
  if (health.lanes.openrouter?.alive && freshProbe(health.lanes.openrouter.lastProbeOkAt, now)) {
    for (const provider of classifiedAutoProbes) {
      if (health.lanes[provider].reason === 'billing') recovered.add(provider);
    }
  }
  restoreExpiredDisabledLanes(health, home, now, recovered);
  applyDisabledLanes(health, home, now);
  orders(health, home);
  demoteBilling(health, home, now);
  await notifyLaneStops(health, { home, now, notify, budgetMs, started, platform, spawnImpl });
  persist(path.join(dir, 'lane-health.json'), health, health);
  return health;
}
export function demoteBilling(health, home, now = Date.now()) {
  const billing = Object.entries(health.lanes).filter(([p, s]) => isLane(p) && s.reason === 'billing');
  if (!billing.length) return;
  const file = path.join(home, '.claude/routing-overrides.json'), routing = readJson(file);
  routing.demote ||= {};
  for (const [p] of billing) routing.demote[p] = new Date(now + 86400_000).toISOString();
  persist(file, routing, health);
  const cooldownFile = path.join(home, '.claude/provider-cooldown.json'), cooldown = readJson(cooldownFile);
  for (const [p] of billing) cooldown[p] = { until: now + 86400_000, at: now, reason: 'billing' };
  persist(cooldownFile, cooldown, health);
}
export async function notifyLaneStops(health, { home = laneHome(), now = Date.now(), notify = notifyKim, budgetMs = 5000, started = Date.now(), platform = process.platform, spawnImpl = spawnSync } = {}) {
  const dir = path.join(home, '.claude');
  health.notifications = [];
  const notifiedFile = path.join(dir, 'lane-doctor-notified.json'), notified = readJson(notifiedFile);
  for (const item of [...health.deadNeedsUser, ...Object.entries(health.lanes).filter(([p, s]) => isLane(p) && s.reason === 'billing').map(([provider, state]) => ({ provider, reason: 'billing', error: state.error }))]) {
    if (item.reason === 'billing' ? String(notified[item.provider] || '').slice(0, 10) === new Date(now).toISOString().slice(0, 10) : now - time(notified[item.provider]) < 86400_000) { health.notifications.push({ provider: item.provider, delivered: 'deduped' }); continue; }
    // 送信前にdedupeを確保。永続化できない環境からは繰り返しDMを送らない。
    const before = notified[item.provider]; notified[item.provider] = new Date(now).toISOString();
    if (!persist(notifiedFile, notified, health)) { health.notifications.push({ provider: item.provider, delivered: 'none', reason: 'dedupe_write_failed' }); continue; }
    const remaining = budgetMs - (Date.now() - started);
    let timer;
    const delivery = remaining > 0 ? await Promise.race([notify(notificationText({ ...item, authOptions: { platform, spawnImpl } }, home), { home, webhookFallback: false, signal: AbortSignal.timeout(Math.max(1, remaining)) }).catch(() => ({ delivered: 'none', reason: 'notification_failed' })), new Promise(resolve => { timer = setTimeout(() => resolve({ delivered: 'unknown', reason: 'deadline' }), remaining); })]).finally(() => clearTimeout(timer)) : { delivered: 'none', reason: 'deadline' };
    health.notifications.push({ provider: item.provider, ...delivery });
    if (delivery.delivered === 'none') { if (before === undefined) delete notified[item.provider]; else notified[item.provider] = before; persist(notifiedFile, notified, health); }
  }
}
export function summarize(health) {
  const substituted = ([, s]) => !s.alive && s.via === 'openrouter' && health.lanes.openrouter?.alive;
  const alive = Object.entries(health.lanes).filter((entry) => entry[1].alive || substituted(entry)).map(([p,s]) => substituted([p, s]) ? `${p} ✅(OpenRouter経由)` : `${p} ✅${s.reason === 'probe_ok:stale' ? `(stale ${Math.floor((time(health.ts) - time(s.lastProbeOkAt)) / 60000)}m)` : ''}`).join(' ') || 'なし';
  const dead = Object.entries(health.lanes).filter((entry) => !entry[1].alive && !substituted(entry)).map(([p,s]) => {
    const reason = s.reason === 'probe_failed:stale' ? `probe_failed, 前回OK ${s.lastProbeOkAt?.slice(0, 10) || 'なし'}` : s.reason === 'model_retired' ? `model_retired: ${s.model}` : s.reason;
    const user = health.deadNeedsUser?.find(x => x.provider === p);
    const next = s.autoProbeStarted ? '自動再確認中' : Number.isFinite(time(s.until)) && time(s.until) > time(health.ts) ? `復帰予定 ${new Date(time(s.until)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/^\d{4}\//, '')} JST` : user ? `要対応: ${String(user.fix).replace(/\s+/g, ' ').slice(0, 80)}` : '自動再確認待ち';
    return `${p} ❌(${reason})(${next})`;
  }).join(' ') || 'なし';
  const summary = `生存: ${alive} ／ 停止: ${dead} ／ 修復: ${health.repairs.map(r => typeof r === 'string' ? r : `${r.provider} ${r.action}`).join(', ') || 'なし'}${health.errors.length ? ` ／ 保存エラー: ${health.errors.join(', ')}` : ''}`;
  return health.repairFirst?.required ? `${summary}\n🛑 安価AIレーン停止（${health.repairFirst.reasons.join(', ')}）: 絶対ルール — 最優先でこの場で修復する。修復（または人にしかできない操作の依頼送信）が済むまで通常タスクに着手しない。手順: ${health.repairFirst.steps.join(' ')}` : summary;
}

export function directGeminiCliState(gemini = {}, cliAvailable = true) {
  const state = { ...gemini, alive: Boolean(gemini.alive && cliAvailable), reason: cliAvailable ? gemini.reason : 'cli_missing' };
  // gemini の via=openrouter は llm-ask の代替経路。gemini-cli は GEMINI_API_KEY で直 API を呼ぶため継承しない。
  delete state.via;
  return state;
}
export async function main(args = process.argv.slice(2)) {
  const h = args.indexOf('--home'), home = h >= 0 ? args[h + 1] : laneHome();
  const p = args.indexOf('--provider'), providers = p >= 0 ? [args[p + 1]] : [];
  if (!home) throw new Error('--home requires a directory');
if (p >= 0 && !isLane(args[p + 1])) throw new Error('--provider requires a known provider');
  const result = args.includes('--probe') ? await laneDoctorProbe({ home, providers }) : laneDoctorQuick({ home, save: !args.includes('--read-only') });
  if (!args.includes('--probe') && !args.includes('--read-only')) await notifyLaneStops(result, { home });
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else { console.log(summarize(result)); console.log(JSON.stringify(result)); }
  if (result.errors.length) process.exitCode = 1;
}
if (isEntry(import.meta.url)) await main().catch(e => { console.error(redactAll(e.message)); process.exitCode = 1; });
