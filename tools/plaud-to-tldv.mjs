// Plaud API details are based on the MIT-licensed https://github.com/rsteckler/applaud project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { readEnvValue } from './env-kv.mjs';

export const REGION_BASES = Object.freeze({
  'aws:us-west-2': 'https://api.plaud.ai',
  'aws:eu-central-1': 'https://api-euc1.plaud.ai',
  'aws:ap-southeast-1': 'https://api-apse1.plaud.ai',
  // 東京。applaud の表には無いが、日本のアカウントの JWT は region=aws:ap-northeast-1 を
  // 持ち workspaceList の domain も api-apne1 を指す（2026-08-19 実機確認）。
  'aws:ap-northeast-1': 'https://api-apne1.plaud.ai',
});
const TLDV_BASE = 'https://pasta.tldv.io';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// tl;dv の公式ドキュメントは .ogg/.opus を挙げていないが、中継URL経由で実際に
// 取り込めることを実測で確認した(2026-08-19、21分の .ogg が正常に処理された)。
const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.mp4', '.wav', '.m4a', '.mkv', '.mov', '.avi', '.wma', '.flac', '.ogg', '.opus']);
const FIVE_MINUTES = 5 * 60;
const THREE_HOURS = 3 * 60 * 60;

export function selectPlaudCookies(setCookies, current = {}) {
  const selected = { ut: current.ut || '', urt: current.urt || '' };
  for (const header of setCookies || []) {
    const first = String(header).split(';', 1)[0];
    const match = first.match(/^\s*(pld_ut|pld_urt)=([^;]*)/i);
    if (!match || !match[2] || /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(String(header))) continue;
    selected[match[1].toLowerCase() === 'pld_ut' ? 'ut' : 'urt'] = match[2];
  }
  return selected;
}

export function epochToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 1e9) return undefined;
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// Plaud の duration が秒かミリ秒かは公開仕様が無い。start_time/end_time が
// 揃っている時はその差分と突き合わせて単位を実測で決め、無い時だけ閾値に頼る。
export function durationToSeconds(value, record = undefined) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const start = Number(record?.start_time);
  const end = Number(record?.end_time);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const span = end - start; // start_time と同じ単位
    // duration が span とほぼ一致 → 同じ単位。span*1000 に一致 → duration はミリ秒。
    if (Math.abs(n - span) <= Math.max(2, span * 0.05)) return start > 1e12 ? n / 1000 : n;
    if (Math.abs(n - span * 1000) <= Math.max(2000, span * 50)) return n / 1000;
  }
  return n > 1e5 ? n / 1000 : n;
}

export function meetsMinimumDuration(value, minMinutes = 5) {
  return durationToSeconds(value) >= Number(minMinutes) * 60;
}

export function extensionFromUrl(value) {
  try { return path.posix.extname(new URL(value).pathname).toLowerCase(); } catch { return ''; }
}

export function isTldvSupportedUrl(value) {
  return SUPPORTED_EXTENSIONS.has(extensionFromUrl(value));
}

export function regionFromRedirect(envelope) {
  if (Number(envelope?.status) !== -302) return undefined;
  const api = String(envelope?.data?.domains?.api || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!api) return undefined;
  const known = Object.entries(REGION_BASES).find(([, base]) => new URL(base).host.toLowerCase() === api)?.[0];
  if (known) return known;
  // Plaud が表に無いリージョンを増やしても止まらないよう、plaud.ai 配下のホストなら
  // そのまま base URL として受け入れる（region キーの代わりに URL を state に持つ）。
  return /^api[a-z0-9-]*\.plaud\.ai$/.test(api) ? `https://${api}` : undefined;
}

/** region キー、もしくは regionFromRedirect が返した生の base URL を解決する。 */
export function apiBaseFor(region) {
  if (REGION_BASES[region]) return REGION_BASES[region];
  if (typeof region === 'string' && /^https:\/\/api[a-z0-9-]*\.plaud\.ai$/.test(region)) return region;
  return REGION_BASES['aws:us-west-2'];
}

/** UT(JWT) の region クレームからリージョンを読む。リダイレクトを待たずに正しい API へ当てるため。 */
export function regionFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const region = String(payload.region || '');
    return REGION_BASES[region] ? region : '';
  } catch { return ''; }
}

/**
 * tl;dv に渡す中継URLを組む。理由は2つある。
 * 1) tl;dv は取得前に HEAD を打つが Plaud の署名URLは HEAD に 403 を返す(GET は 206)。
 *    素の署名URLを渡すと success:true が返るのに会議が作られない無言の失敗になる。
 * 2) tl;dv は約2077文字を超える URL を 400 で拒否する。署名URLは 1534 文字あり、
 *    埋め込むと超過する。そこで workspace token と fileId だけを載せ、署名URLは
 *    中継側が都度取り直す。workspace token は AES-256-GCM で暗号化して載せる
 *    (tl;dv 側のログに残っても悪用できないようにするため)。
 */
export function buildProxyUrl({ base, secret, apiBase, workspaceToken, fileId, ext, ttlSeconds = 7200, now = Date.now(), iv }) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const nonce = iv || crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const plain = JSON.stringify({ b: apiBase, w: workspaceToken, f: fileId, x: Math.floor(now / 1000) + ttlSeconds });
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const token = Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  return `${String(base).replace(/\/$/, '')}/a/${token}/audio.${ext}`;
}

/** 上流の拡張子から中継URLの拡張子を決める。ogg/opus だけは実測で切り替えたいので可変。 */
export function proxyExtensionFor(upstreamUrl, oggAs = 'ogg') {
  const ext = extensionFromUrl(upstreamUrl).replace('.', '') || 'mp3';
  return (ext === 'ogg' || ext === 'opus') ? oggAs : ext;
}

export function redactSecret(value) {
  const text = String(value ?? '');
  if (!text) return '(empty)';
  return `${text.slice(0, 3)}…(len=${text.length})`;
}

export function defaultState() {
  return { version: 1, session: { ut: '', utExp: 0, urt: '', urtExp: 0, region: 'aws:us-west-2', workspaceId: '', wt: '', wtExp: 0 }, firstSeenAt: 0, imported: {}, skipped: {}, lastRun: 0 };
}

export function mergeState(raw = {}, bootstrap = {}) {
  const base = defaultState();
  const session = raw.session && typeof raw.session === 'object' ? raw.session : {};
  return {
    ...base, ...raw, version: 1,
    session: { ...base.session, ...bootstrap, ...session },
    imported: raw.imported && typeof raw.imported === 'object' && !Array.isArray(raw.imported) ? raw.imported : {},
    skipped: raw.skipped && typeof raw.skipped === 'object' && !Array.isArray(raw.skipped) ? raw.skipped : {},
  };
}

export function shouldImport(record, state, options = {}) {
  if (!record?.id) return { import: false, reason: 'missing-id' };
  if (record.is_trash) return { import: false, reason: 'trash' };
  if (state?.imported?.[record.id]) return { import: false, reason: 'imported' };
  const seconds = durationToSeconds(record.duration, record);
  if (seconds < (options.minMinutes ?? 5) * 60) return { import: false, reason: 'too-short' };
  if (seconds > THREE_HOURS) return { import: false, reason: 'over-three-hours' };
  const iso = epochToIso(record.start_time);
  if (options.since && (!iso || Date.parse(iso) < options.since.getTime())) return { import: false, reason: 'before-since' };
  return { import: true };
}

export function readState(statePath, bootstrap = {}, now = Date.now()) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
    return { state: mergeState(raw, bootstrap), corruptPath: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: mergeState({}, bootstrap), corruptPath: '' };
    const corruptPath = `${statePath}.corrupt-${now}`;
    fs.renameSync(statePath, corruptPath);
    return { state: mergeState({}, bootstrap), corruptPath };
  }
}

export function writeStateAtomic(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  // Windows では上書き rename が EPERM で弾かれることがある(ウイルス対策や
  // インデクサが一瞬ハンドルを掴む)。取りこぼすと import 済みの記録が消えて
  // 二重投入を招くので、短い再試行 → コピーへのフォールバックまで面倒を見る。
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temp, statePath); return; } catch (error) {
      const retriable = error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EBUSY';
      if (!retriable) { try { fs.unlinkSync(temp); } catch {} throw error; }
      if (attempt >= 4) {
        try { fs.copyFileSync(temp, statePath); } finally { try { fs.unlinkSync(temp); } catch {} }
        return;
      }
      const until = Date.now() + 60; while (Date.now() < until) { /* 短い同期待機 */ }
    }
  }
}

export function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) || 0;
  } catch { return 0; }
}

export function getSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers?.raw === 'function') return headers.raw()['set-cookie'] || [];
  const combined = headers?.get?.('set-cookie');
  return combined ? combined.split(/,(?=\s*pld_(?:ut|urt)=)/i) : [];
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchWithRetry(url, init = {}, fetchImpl = fetch) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (response.status < 500 || attempt === 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; if (attempt === 1) throw error; }
    await sleep(1000);
  }
  throw lastError;
}

function parseArgs(argv) {
  const options = { dryRun: false, minMinutes: 5, backfill: false, since: null, limit: 10, doctor: false, json: false, verbose: false, allowUnsupported: false, proxyExt: 'ogg' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--backfill') options.backfill = true;
    else if (arg === '--doctor') options.doctor = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    // tl;dv の対応拡張子ゲートを外して投入する検証用。Plaud の .ogg/.opus を
    // tl;dv 側がデコードできるかを実測するために使う。
    else if (arg === '--allow-unsupported') options.allowUnsupported = true;
    else if (arg === '--proxy-ext') options.proxyExt = String(argv[++i] || 'ogg').toLowerCase();
    else if (arg === '--min-minutes') options.minMinutes = Number(argv[++i]);
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--since') {
      const value = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('--since は YYYY-MM-DD 形式で指定してください');
      options.since = new Date(`${value}T00:00:00.000Z`);
    } else throw new Error(`不明なオプション: ${arg}`);
  }
  if (!Number.isFinite(options.minMinutes) || options.minMinutes < 0) throw new Error('--min-minutes は0以上の数値で指定してください');
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit は1以上の整数で指定してください');
  return options;
}

function logger(options) {
  return {
    info(message) { if (!options.json) console.error(`[plaud-to-tldv] ${message}`); },
    verbose(message) { if (options.verbose && !options.json) console.error(`[plaud-to-tldv] ${message}`); },
    warn(message) { if (!options.json) console.error(`[plaud-to-tldv] 警告: ${message}`); },
  };
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) fs.unlinkSync(lockPath);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  try { return fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') throw new Error('別の plaud-to-tldv が実行中です'); throw error; }
}

function releaseLock(lockPath, fd) {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}
}

function envelopeError(body, label) {
  if (Number(body?.status) === 0) return;
  const error = new Error(`${label}失敗: status=${body?.status ?? '不明'} ${body?.msg || ''}`.trim());
  error.envelope = body;
  throw error;
}

/**
 * WT(workspace token) の失効を表す封筒か。Plaud は exp を待たずに古い WT を
 * 無効化することがある(別クライアントが mint し直した時など)ので、exp だけを
 * 見ていると -419 で落ちる。実測で確認したコード/文言を拾う。
 */
export function isWorkspaceTokenExpired(error) {
  const status = Number(error?.envelope?.status);
  if (status === -419) return true;
  const msg = String(error?.envelope?.msg || error?.message || '');
  return /workspace token (expired|invalid)/i.test(msg);
}

function authHeaders(token, extra = {}) {
  return { accept: 'application/json', 'user-agent': USER_AGENT, authorization: `Bearer ${token}`, ...extra };
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${label} HTTP ${response.status}`);
    error.status = response.status; error.body = body;
    throw error;
  }
  return body;
}

function makePlaudClient(state, persist, log, fetchImpl = fetch) {
  async function call(endpoint, init, label, allowRedirect = true) {
    const base = apiBaseFor(state.session.region);
    const response = await fetchWithRetry(`${base}${endpoint}`, init, fetchImpl);
    const body = await responseJson(response, label);
    const redirectedRegion = regionFromRedirect(body);
    if (allowRedirect && redirectedRegion && redirectedRegion !== state.session.region) {
      state.session.region = redirectedRegion; persist(); log.info(`Plaud リージョンを ${redirectedRegion} に切り替えました`);
      return call(endpoint, init, label, false);
    }
    envelopeError(body, label);
    return { response, body };
  }
  return { call };
}

function needsRefresh(exp) { return !Number(exp) || Number(exp) <= Math.floor(Date.now() / 1000) + FIVE_MINUTES; }

function plainDateName(name) {
  return !name || /^\s*(?:\d{4}[-_.年]\d{1,2}[-_.月]\d{1,2}日?)[ T_-]*(?:\d{1,2}[:時]\d{2}(?::\d{2})?分?)?\s*(?:\.[^.]+)?$/i.test(name);
}

function meetingName(record, iso) {
  // fullname は S3 のキー(ハッシュ.ogg)で、人が付けた題名は filename の方。
  const raw = String(record.filename || '').trim();
  if (!plainDateName(raw)) return raw;
  const date = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `Plaud録音 ${parts}`;
}

async function refreshTokens(state, client, persist, fetchImpl) {
  let response;
  let body;
  for (let regionAttempt = 0; regionAttempt < 2; regionAttempt += 1) {
    const base = apiBaseFor(state.session.region);
    response = await fetchWithRetry(`${base}/auth/refresh-user-token`, {
      method: 'POST', headers: { accept: 'application/json', 'user-agent': USER_AGENT, cookie: `pld_ut=${state.session.ut}; pld_urt=${state.session.urt}`, 'content-type': 'application/json' }, body: '{}',
    }, fetchImpl);
    body = await responseJson(response, 'UT更新');
    const redirectedRegion = regionFromRedirect(body);
    if (regionAttempt === 0 && redirectedRegion && redirectedRegion !== state.session.region) {
      state.session.region = redirectedRegion;
      persist();
      continue;
    }
    envelopeError(body, 'UT更新');
    break;
  }
  const tokens = selectPlaudCookies(getSetCookies(response.headers), state.session);
  state.session.ut = tokens.ut; state.session.urt = tokens.urt;
  state.session.utExp = jwtExp(tokens.ut); state.session.urtExp = jwtExp(tokens.urt);
  state.session.wt = ''; state.session.wtExp = 0;
  persist();
}

async function listWorkspaces(state, client) {
  const { body } = await client.call('/team-app/workspaces/list?need_personal_workspace=true', { headers: authHeaders(state.session.ut) }, 'workspace一覧');
  return body?.data?.workspaces || [];
}

async function issueWorkspaceToken(state, client, workspaceId) {
  const { body } = await client.call(`/user-app/auth/workspace/token/${encodeURIComponent(workspaceId)}`, { method: 'POST', headers: authHeaders(state.session.ut, { 'content-type': 'application/json' }), body: '{}' }, 'WT発行');
  const token = body?.data?.workspace_token;
  if (!token) throw new Error('WT発行レスポンスに workspace_token がありません');
  return token;
}

async function ensureWorkspace(state, client, persist) {
  let workspaces;
  if (!state.session.workspaceId) {
    workspaces = await listWorkspaces(state, client);
    state.session.workspaceId = (workspaces.find((item) => String(item.workspace_type) === '0') || workspaces[0])?.workspace_id || '';
    if (!state.session.workspaceId) throw new Error('Plaud workspace が見つかりません');
    persist();
  }
  if (!needsRefresh(state.session.wtExp)) return;
  try {
    state.session.wt = await issueWorkspaceToken(state, client, state.session.workspaceId);
  } catch (error) {
    if (error.status === 401) throw error;
    workspaces = await listWorkspaces(state, client);
    state.session.workspaceId = (workspaces.find((item) => String(item.workspace_type) === '0') || workspaces[0])?.workspace_id || '';
    state.session.wt = await issueWorkspaceToken(state, client, state.session.workspaceId);
  }
  state.session.wtExp = jwtExp(state.session.wt); persist();
}

/** WT を使う呼び出しを、失効時に mint し直して1度だけ再試行する。 */
async function withFreshWorkspaceToken(state, client, persist, run) {
  try {
    return await run();
  } catch (error) {
    if (!isWorkspaceTokenExpired(error)) throw error;
    state.session.wt = ''; state.session.wtExp = 0;
    await ensureWorkspace(state, client, persist);
    return run();
  }
}

async function listRecordings(state, client) {
  const all = [];
  for (let page = 0; page < 20; page += 1) {
    const skip = page * 50;
    const { body } = await client.call(`/file/simple/web?skip=${skip}&limit=50&is_trash=2&sort_by=start_time&is_desc=true`, { headers: authHeaders(state.session.wt) }, '録音一覧');
    const items = body?.data_file_list || [];
    all.push(...items);
    if (!items.length || all.length >= Number(body?.data_file_total || 0)) break;
  }
  return all;
}

async function tldvRequest(apiKey, endpoint, init = {}, fetchImpl = fetch) {
  const response = await fetchWithRetry(`${TLDV_BASE}${endpoint}`, { ...init, headers: { 'x-api-key': apiKey, ...init.headers } }, fetchImpl);
  return { response, body: await response.json().catch(() => ({})) };
}

function bootstrapValues() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const plaudFile = path.join(claudeDir, 'plaud.env');
  return {
    apiKey: process.env.TLDV_API_KEY || readEnvValue(path.join(claudeDir, 'tldv.env'), 'TLDV_API_KEY'),
    session: {
      ut: process.env.PLAUD_UT || readEnvValue(plaudFile, 'PLAUD_UT'),
      urt: process.env.PLAUD_URT || readEnvValue(plaudFile, 'PLAUD_URT'),
      region: process.env.PLAUD_REGION || readEnvValue(plaudFile, 'PLAUD_REGION') || 'aws:us-west-2',
      workspaceId: process.env.PLAUD_WORKSPACE_ID || readEnvValue(plaudFile, 'PLAUD_WORKSPACE_ID'),
    },
    proxyBase: process.env.PLAUD_PROXY_BASE || readEnvValue(plaudFile, 'PLAUD_PROXY_BASE'),
    proxySecret: process.env.PLAUD_PROXY_SECRET || readEnvValue(plaudFile, 'PLAUD_PROXY_SECRET'),
    statePath: path.join(claudeDir, 'plaud-to-tldv-state.json'),
  };
}

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const log = logger(options);
  const config = dependencies.config || bootstrapValues();
  if (!config.apiKey) { console.error('TLDV_API_KEY がありません。~/.claude/tldv.env に TLDV_API_KEY=... を保存してください。'); return 2; }
  const statePath = config.statePath;
  const lockPath = `${statePath}.lock`;
  let lockFd;
  try { lockFd = acquireLock(lockPath); } catch (error) { console.error(error.message); return 1; }
  try {
    const loaded = readState(statePath, config.session);
    const state = loaded.state;
    if (loaded.corruptPath) log.warn(`壊れた state を ${loaded.corruptPath} に退避しました`);
    if (!state.session.ut) {
      console.error('PLAUD_UT がありません。web.plaud.ai にログインし、Cookie の pld_ut を ~/.claude/plaud.env に保存してください。'); return 2;
    }
    // JWT の region クレームが最も確実な接続先。-302 リダイレクトを待たずに合わせる。
    if (!state.session.utExp) state.session.utExp = jwtExp(state.session.ut);
    const tokenRegion = regionFromToken(state.session.ut);
    if (tokenRegion && tokenRegion !== state.session.region) { state.session.region = tokenRegion; }
    const persist = () => writeStateAtomic(statePath, state);
    const fetchImpl = dependencies.fetch || fetch;
    const client = makePlaudClient(state, persist, log, fetchImpl);
    if (needsRefresh(state.session.utExp)) {
      if (!state.session.urt) {
        // URT(30日) が無いアカウントでは UT を自力更新できない。無音で腐らせず明示的に止める。
        console.error('Plaud の pld_ut が期限切れで、更新用の pld_urt もありません。web.plaud.ai で pld_ut を取り直して ~/.claude/plaud.env を更新してください。');
        return 1;
      }
      await refreshTokens(state, client, persist, fetchImpl);
    }
    await ensureWorkspace(state, client, persist);

    if (options.doctor) {
      const { response, body } = await tldvRequest(config.apiKey, '/v1alpha1/meetings?limit=1', {}, fetchImpl);
      if (!response.ok) throw new Error(`tl;dv キー疎通失敗 HTTP ${response.status}: ${body?.message || body?.error || ''}`);
      const result = { ok: true, tldv: 'ok', plaud: 'ok', workspaceId: state.session.workspaceId };
      console.log(options.json ? JSON.stringify(result) : 'doctor: tl;dv=ok Plaud=ok');
      return 0;
    }

    const records = await withFreshWorkspaceToken(state, client, persist, () => listRecordings(state, client));
    const firstRun = !state.firstSeenAt;
    if (firstRun && !options.backfill) {
      const now = Date.now();
      for (const record of records) if (record?.id) state.skipped[record.id] = { reason: 'first-seen', at: now };
      state.firstSeenAt = now; state.lastRun = now; persist();
      const summary = { imported: 0, skipped: records.length, failed: 0 };
      if (options.json) console.log(JSON.stringify(summary));
      else { log.info(`初回実行のため既存録音 ${records.length} 件を seen として記録しました。過去分を入れる場合は --backfill --since 2026-08-01 を指定してください。`); console.log(`imported=0 skipped=${records.length} failed=0`); }
      return 0;
    }
    if (firstRun) state.firstSeenAt = Date.now();

    const summary = { imported: 0, skipped: 0, failed: 0 };
    let attempted = 0;
    for (const record of records) {
      const decision = shouldImport(record, state, options);
      if (!decision.import) {
        summary.skipped += 1;
        if (record?.id && decision.reason !== 'imported') state.skipped[record.id] = { reason: decision.reason, at: Date.now() };
        if (decision.reason === 'over-three-hours') log.warn(`${record.filename || record.id} は3時間超のため除外しました`);
        continue;
      }
      if (attempted >= options.limit) { summary.skipped += 1; continue; }
      attempted += 1;
      try {
        const { body: urlBody } = await withFreshWorkspaceToken(state, client, persist, () => client.call(`/file/temp-url/${encodeURIComponent(record.id)}`, { headers: authHeaders(state.session.wt) }, '音声URL取得'));
        const tempUrl = urlBody.temp_url;
        // 中継が設定されていれば、tl;dv に渡すのは中継URL。素の署名URLは HEAD で
        // 403 になり取り込まれないため、設定がある限りこちらを優先する。
        const useProxy = Boolean(config.proxyBase && config.proxySecret);
        const targetUrl = useProxy
          ? buildProxyUrl({ base: config.proxyBase, secret: config.proxySecret, apiBase: apiBaseFor(state.session.region), workspaceToken: state.session.wt, fileId: record.id, ext: proxyExtensionFor(tempUrl, options.proxyExt) })
          : tempUrl;
        if (!options.allowUnsupported && !isTldvSupportedUrl(targetUrl)) {
          const extension = extensionFromUrl(targetUrl) || '(拡張子なし)';
          log.warn(`${record.filename || record.id}: 非対応拡張子 ${extension}`);
          state.skipped[record.id] = { reason: `unsupported-extension:${extension}`, at: Date.now() }; summary.skipped += 1; continue;
        }
        const happenedAt = epochToIso(record.start_time);
        const payload = { name: meetingName(record, happenedAt), url: targetUrl };
        if (happenedAt) payload.happenedAt = happenedAt;
        if (options.dryRun) payload.dryRun = true;
        const { response, body } = await tldvRequest(config.apiKey, '/v1alpha1/meetings/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, fetchImpl);
        if (!response.ok || !body.success) throw new Error(`tl;dv import失敗 HTTP ${response.status}: ${body.message || ''}`);
        summary.imported += 1;
        if (!options.dryRun) { state.imported[record.id] = { jobId: body.jobId || '', name: payload.name, at: Date.now() }; persist(); }
        log.verbose(`${payload.name} を import しました jobId=${body.jobId || ''}`);
      } catch (error) { summary.failed += 1; log.warn(`${record.filename || record.id}: ${error.message}`); }
    }
    if (!options.dryRun) { state.lastRun = Date.now(); persist(); }
    console.log(options.json ? JSON.stringify(summary) : `imported=${summary.imported} skipped=${summary.skipped} failed=${summary.failed}`);
    return summary.failed ? 1 : 0;
  } catch (error) {
    if (error?.status === 401) console.error('Plaud 認証が失効しました。plaud.ai に再ログインして pld_ut / pld_urt を取り直し、~/.claude/plaud.env を更新してください。');
    else console.error(`plaud-to-tldv 失敗: ${error.message}`);
    return 1;
  } finally { releaseLock(lockPath, lockFd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run();
}
