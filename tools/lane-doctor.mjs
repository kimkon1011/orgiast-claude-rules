#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { codexAuthStatus } from './codex-auth-status.mjs';
import { loadEnvKey, loadGeminiKey, loadDeepseekKey } from './codex-do.mjs';
import { providerResetUntil } from './codex-cooldown.mjs';
import { notifyKim } from './notify-kim.mjs';
import { redactAll } from './lib/redact.mjs';

export const PROVIDERS = ['codex', 'gemini', 'deepseek', 'glm', 'groq', 'openrouter'];
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
function orders(health) {
  health.implementOrder = ['codex', 'deepseek', 'glm', 'gemini-cli'].filter(p => health.lanes[p]?.alive);
  health.askOrder = ['gemini', 'deepseek', 'groq', 'openrouter'].filter(p => health.lanes[p]?.alive);
  health.deadNeedsUser = Object.entries(health.lanes).filter(([p, s]) => PROVIDERS.includes(p) && /^(?:dead:)?(?:payment_required|oauth_consent|account_creation|physical_operation)$/.test(s.reason))
    .map(([provider, s]) => ({ provider, reason: s.reason, fix: s.reason.includes('payment') ? '請求設定でオートチャージ ON。手動チャージは禁止ルール。' : '本人アカウントで認証画面を開き OAuth 同意を完了する。' }));
  return health;
}
function persist(file, value, health) {
  try { atomicJson(file, value); return true; } catch (e) { health.errors.push(`${path.basename(file)}: ${e.code || 'write_failed'}`); return false; }
}
export function laneDoctorQuick({ home = laneHome(), now = Date.now(), save = true } = {}) {
  const dir = path.join(home, '.claude');
  const old = readJson(path.join(dir, 'lane-health.json'));
  const health = { ts: new Date(now).toISOString(), probedAt: old.probedAt || null, lanes: {}, implementOrder: [], askOrder: [], repairs: [], deadNeedsUser: [], errors: [], ignored: [] };
  const cooldown = readJson(path.join(dir, 'provider-cooldown.json')), routing = readJson(path.join(dir, 'routing-overrides.json'));
  const limits = [...history(home, 'provider-limit-history.jsonl'), ...history(home, 'codex-limit-history.jsonl').map(x => ({ ...x, provider: 'codex' }))].filter(x => {
    if (time(x.until) > now + MAX_HISTORY_RESET_MS) {
      health.ignored.push({ provider: x.provider, reason: 'until_beyond_7d', until: x.until });
      return false;
    }
    return true;
  });
  for (const [name, state] of [['provider-cooldown.json', cooldown], ['routing-overrides.json', routing.demote || {}]]) {
    const repairs = [], removed = {};
    for (const p of PROVIDERS) {
      const until = time(name.startsWith('routing') ? state[p]?.until ?? state[p] : state[p]?.until);
      if (state[p] !== undefined && Number.isFinite(until) && until <= now) { removed[p] = state[p]; delete state[p]; repairs.push({ provider: p, action: name.startsWith('routing') ? 'demote_removed' : 'cooldown_removed', detail: '期限切れ' }); }
    }
    if (repairs.length) {
      if (persist(path.join(dir, name), name.startsWith('routing') ? routing : cooldown, health)) health.repairs.push(...repairs);
      else Object.assign(state, removed);
    }
  }
  const keys = { gemini: loadGeminiKey(home), deepseek: loadDeepseekKey(home), glm: loadEnvKey(home, 'zai.env', 'ZAI_API_KEY'), groq: loadEnvKey(home, 'groq.env', 'GROQ_API_KEY'), openrouter: loadEnvKey(home, 'openrouter.env', 'OPENROUTER_API_KEY') };
  for (const p of PROVIDERS) {
    const configured = p === 'codex' ? codexAuthStatus(home).login : !!keys[p];
    const previous = old.lanes?.[p] || {}, evidence = probeHistory(previous);
    const recent = limits.filter(x => x.provider === p && time(x.until) > now && !(time(evidence.lastProbeOkAt) >= time(x.t ?? x.ts ?? x.at))).at(-1);
    const blocked = cooldown[p] || recent;
    let state = { alive: configured, reason: configured ? 'configured:unprobed' : p === 'codex' ? 'dead:oauth_consent' : 'missing_key' };
    if (old.lanes?.[p]?.reason === 'dead:payment_required') state = { ...old.lanes[p] };
    else if (blocked && time(blocked.until) > now) state = { alive: false, reason: blocked.reason || 'cooldown', until: blocked.until };
    else if (routing.demote?.[p]) state = { alive: false, reason: 'demoted', until: routing.demote[p]?.until ?? routing.demote[p] };
    else if (configured && freshProbe(old.lanes?.[p]?.probedAt, now) && !(old.lanes[p].until && time(old.lanes[p].until) <= now)) state = { ...old.lanes[p] };
    else if (configured && evidence.lastProbeOkAt) state = { alive: true, reason: 'probe_ok:stale' };
    else if (configured && evidence.probedAt) state = previous.until && time(previous.until) <= now
      ? { alive: true, reason: 'probe_expired' } : { ...previous };
    health.lanes[p] = { ...state, ...evidence };
  }
  // API key の生存と CLI の有無は別条件。CLI が無い場合は実装候補にしない。
  health.lanes['gemini-cli'] = { ...health.lanes.gemini, alive: health.lanes.gemini.alive && executable('gemini'), reason: executable('gemini') ? health.lanes.gemini.reason : 'cli_missing' };
  orders(health);
  if (save) persist(path.join(dir, 'lane-health.json'), health, health);
  return health;
}
export function runProbe(provider, { home, timeoutMs, dryRun = false } = {}) {
  const args = provider === 'codex'
    ? [path.join(repo, 'tools/codex-do.mjs'), 'Reply with exactly: PONG. Do not modify any files.', '--cwd', repo, '--no-fallback', '--no-escalate', ...(dryRun ? ['--dry-run'] : ['--timeout', String(Math.max(1, Math.floor(timeoutMs / 1000)))])]
    : [path.join(repo, 'tools/llm-ask.mjs'), '--provider', provider, 'Reply with exactly: PONG', '--max', '10', '--no-fallback'];
  return new Promise(resolve => execFile(process.execPath, args, { cwd: repo, env: { ...process.env, ORGIAST_HOME: home }, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true }, (e, stdout, stderr) => resolve({ code: e ? e.code || 1 : 0, text: redactAll(`${stdout}\n${stderr}`) })));
}
export function notificationText(item, home) {
  if (item.provider === 'gemini') {
    let owner = '未確認';
    for (const f of [path.join(home, '.claude/gemini.env'), path.join(home, '.gemini/.env')]) {
      try { const comments = fs.readFileSync(f, 'utf8').split('\n').filter(l => /^\s*#/.test(l)).join('\n'); owner = comments.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] || owner; } catch {}
    }
    return `Gemini が停止しています（${item.reason}）。1. https://aistudio.google.com/ を kim@orgiast.jp で開く。2. 右上のアカウントが kim@orgiast.jp であることを確認（使用キーの所有アカウント: ${owner}）。3. 使用キーに対応するプロジェクトの請求・残高設定を開く。4. オートチャージ ON を推奨（手動チャージは禁止ルール）。必要なら支払い方法を登録し、自動補充の金額・しきい値を確認して保存する。5. 保存後は Claude が lane-doctor --probe で復旧を確認します。`;
  }
  const urls = { codex: 'https://chatgpt.com/', deepseek: 'https://platform.deepseek.com/', glm: 'https://z.ai/', groq: 'https://console.groq.com/', openrouter: 'https://openrouter.ai/' };
  const account = item.provider === 'codex' ? codexAuthStatus(home).email || 'kim@orgiast.jp（保存認証のアカウントは未確認）' : '契約したアカウント（キー所有者は未確認）';
  return `${item.provider} が停止しています（${item.reason}）。1. ${urls[item.provider]} を ${account} で開く。2. アカウント表示を確認する。3. ${item.reason.includes('payment') ? '請求設定を開き支払い方法を確認し、オートチャージ ON を設定して保存する（手動チャージは禁止ルール）。' : 'Codex を開きログインを選択する。ブラウザーで同じアカウントを選び、OAuth の同意内容を確認して許可する。'}4. 完了後は Claude が lane-doctor --probe で復旧を確認します。`;
}
export async function laneDoctorProbe({ home = laneHome(), now = Date.now(), probe = runProbe, notify = notifyKim, budgetMs = 90_000 } = {}) {
  const started = Date.now(), dir = path.join(home, '.claude');
  const health = laneDoctorQuick({ home, now, save: false });
  const previous = readJson(path.join(dir, 'lane-health.json'));
  const probeBudget = Math.max(1, budgetMs - 5000);
  // 各 provider を並行実測し、一つの停止レーンで90秒枠を使い切らない。
  const results = await Promise.all(PROVIDERS.map(async p => {
    if (health.lanes[p].reason === 'missing_key' || (p === 'codex' && !codexAuthStatus(home).login)) return [p, null];
    if (p === 'codex') {
      const dry = await probe(p, { home, timeoutMs: Math.min(15000, probeBudget), dryRun: true });
      if (dry.code !== 0) return [p, dry];
      if (freshProbe(previous.lanes?.codex?.probedAt, now)) return [p, { cached: previous.lanes.codex }];
    }
    return [p, { ...await probe(p, { home, timeoutMs: Math.max(1, probeBudget - (Date.now() - started)) }), ...(p === 'codex' ? { authOk: true } : {}) }];
  }));
  // probe subprocess が cooldown を更新することがあるため、完了後に再読込する。
  const cooldown = readJson(path.join(dir, 'provider-cooldown.json')), routing = readJson(path.join(dir, 'routing-overrides.json'));
  let cooldownChanged = false, routingChanged = false;
  for (const [p, result] of results) {
    if (!result) continue;
    if (result.cached && !result.cached.alive) { health.lanes[p] = { ...result.cached, ...probeHistory(result.cached) }; continue; }
    const text = result.text || '', stamp = new Date(now).toISOString();
    if (result.code === 0 || result.cached?.alive) {
      health.lanes[p] = result.cached
        ? { ...result.cached, ...probeHistory(result.cached) }
        : { alive: true, reason: p === 'codex' ? 'auth_ok:probe_ok' : 'probe_ok', probedAt: stamp, lastProbeOkAt: stamp, probeReason: p === 'codex' ? 'auth_ok:probe_ok' : 'probe_ok' };
      if (routing.demote?.[p] !== undefined) { delete routing.demote[p]; routingChanged = true; health.repairs.push({ provider: p, action: 'demote_removed', detail: '実測成功' }); }
      if (cooldown[p]) { delete cooldown[p]; cooldownChanged = true; health.repairs.push({ provider: p, action: 'cooldown_removed', detail: '実測成功' }); }
    } else {
      const payment = /HTTP\s*402\b|credits are depleted|insufficient/i.test(text);
      const limited = /HTTP\s*429\b|usage limit|RESOURCE_EXHAUSTED|rate.limit/i.test(text);
      health.lanes[p] = { ...probeHistory(previous.lanes?.[p]), alive: false, reason: payment ? 'dead:payment_required' : limited ? 'cooldown' : /HTTP\s*401|unauthorized|login required|token.*expired/i.test(text) ? (p === 'codex' ? 'dead:oauth_consent' : 'auth_invalid') : /Read-only file system|EROFS/i.test(text) ? 'execution_unavailable:read_only' : 'probe_failed', probedAt: stamp, ...(result.authOk ? { authOk: true } : {}) };
      health.lanes[p].probeReason = health.lanes[p].reason;
      if (limited && !payment) { const until = providerResetUntil(text, now); cooldown[p] = { until, at: now, reason: 'lane_doctor_usage_limit' }; cooldownChanged = true; health.lanes[p].until = until; }
    }
  }
  if (routingChanged && !persist(path.join(dir, 'routing-overrides.json'), routing, health)) health.repairs = health.repairs.filter(r => r.action !== 'demote_removed' || r.detail !== '実測成功');
  if (cooldownChanged && !persist(path.join(dir, 'provider-cooldown.json'), cooldown, health)) health.repairs = health.repairs.filter(r => r.action !== 'cooldown_removed' || r.detail !== '実測成功');
  health.probedAt = new Date(now).toISOString();
  health.lanes['gemini-cli'] = { ...health.lanes.gemini, alive: health.lanes.gemini.alive && executable('gemini') };
  orders(health);
  health.notifications = [];
  const notifiedFile = path.join(dir, 'lane-doctor-notified.json'), notified = readJson(notifiedFile);
  for (const item of health.deadNeedsUser) {
    if (now - time(notified[item.provider]) < 86400_000) { health.notifications.push({ provider: item.provider, delivered: 'deduped' }); continue; }
    // 送信前にdedupeを確保。永続化できない環境からは繰り返しDMを送らない。
    const before = notified[item.provider]; notified[item.provider] = new Date(now).toISOString();
    if (!persist(notifiedFile, notified, health)) { health.notifications.push({ provider: item.provider, delivered: 'none', reason: 'dedupe_write_failed' }); continue; }
    const remaining = budgetMs - (Date.now() - started);
    let timer;
    const delivery = remaining > 0 ? await Promise.race([notify(notificationText(item, home), { home, webhookFallback: false, signal: AbortSignal.timeout(Math.max(1, remaining)) }).catch(() => ({ delivered: 'none', reason: 'notification_failed' })), new Promise(resolve => { timer = setTimeout(() => resolve({ delivered: 'unknown', reason: 'deadline' }), remaining); })]).finally(() => clearTimeout(timer)) : { delivered: 'none', reason: 'deadline' };
    health.notifications.push({ provider: item.provider, ...delivery });
    if (delivery.delivered === 'none') { if (before === undefined) delete notified[item.provider]; else notified[item.provider] = before; persist(notifiedFile, notified, health); }
  }
  persist(path.join(dir, 'lane-health.json'), health, health);
  return health;
}
export function summarize(health) {
  const alive = Object.entries(health.lanes).filter(([,s]) => s.alive).map(([p,s]) => `${p} ✅${s.reason === 'probe_ok:stale' ? `(stale ${Math.floor((time(health.ts) - time(s.lastProbeOkAt)) / 60000)}m)` : ''}`).join(' ') || 'なし';
  const dead = Object.entries(health.lanes).filter(([,s]) => !s.alive).map(([p,s]) => `${p} ❌(${s.reason})`).join(' ') || 'なし';
  return `生存: ${alive} ／ 停止: ${dead} ／ 修復: ${health.repairs.map(r => `${r.provider} ${r.action}`).join(', ') || 'なし'}${health.errors.length ? ` ／ 保存エラー: ${health.errors.join(', ')}` : ''}`;
}
export async function main(args = process.argv.slice(2)) {
  const h = args.indexOf('--home'), home = h >= 0 ? args[h + 1] : laneHome();
  if (!home) throw new Error('--home requires a directory');
  const result = args.includes('--probe') ? await laneDoctorProbe({ home }) : laneDoctorQuick({ home });
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else { console.log(summarize(result)); console.log(JSON.stringify(result)); }
  if (result.errors.length) process.exitCode = 1;
}
if (isEntry(import.meta.url)) await main().catch(e => { console.error(redactAll(e.message)); process.exitCode = 1; });
