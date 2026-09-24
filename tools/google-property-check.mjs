#!/usr/bin/env node
/**
 * google-property-check.mjs — Google 系プロパティ(GA4 / Search Console / Tag Manager)の
 * 「kim@orgiast.jp 配下に何が存在するか」を **API に直接照会して** 確定する読み取り専用ツール。
 *
 * なぜ要るか: 「Claude の履歴 / memory に無い」は外部システムの不在の証拠にならない
 * （人が Web UI で作ったものは transcript に一切残らない）。存在/不在を語る唯一の証拠は
 * そのシステムへの直接照会なので、その照会を 1 コマンドに固定する。
 *
 * 方式: サービスアカウント + ドメイン全体の委任(DWD)で kim@orgiast.jp を代理。
 *       依存パッケージなし（Node 18+ の fetch と標準 crypto で JWT を自己署名）。
 *
 * 使い方:
 *   node tools/google-property-check.mjs                 # 人間向けレポート
 *   node tools/google-property-check.mjs --json          # 機械可読 JSON
 *   node tools/google-property-check.mjs --key <path> --subject <mail>
 *
 * 終了コード: 0 = 照会を完走（プロパティ 0 件でも 0。不在も「結果」なので失敗ではない）
 *             2 = 設定エラー（SA キーが無い / JSON が壊れている）
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_KEY =
  process.env.GOOGLE_SA_KEY ??
  'C:/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json';
const DEFAULT_SUBJECT = process.env.GOOGLE_IMPERSONATE ?? 'kim@orgiast.jp';

const b64url = (v) => Buffer.from(v).toString('base64url');

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      out.flags.add('h');
      continue;
    }
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    if (name === 'json' || name === 'help' || name === 'h') out.flags.add(name);
    else out[name] = argv[++i];
  }
  return out;
}

/** DWD: SA 秘密鍵で JWT を自己署名し、kim@orgiast.jp を sub に入れてアクセストークンに交換する。 */
async function getToken({ key, subject, scope, signal }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: subject,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(key.private_key, 'base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=' +
      encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' +
      jwt,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) {
    const err = new Error(json.error_description || json.error || `token HTTP ${res.status}`);
    err.tokenError = true;
    err.detail = json;
    throw err;
  }
  return json.access_token;
}

async function apiGet(url, token, signal) {
  const res = await fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 応答は raw として保持 */
  }
  if (!res.ok) {
    const err = new Error(`${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
    err.httpStatus = res.status;
    err.detail = json;
    throw err;
  }
  return json;
}

/**
 * 各プロパティ種別の照会定義。
 * `pick` は API 応答から「人が読める 1 行」を取り出す関数。
 */
const CHECKS = [
  {
    id: 'ga4',
    label: 'GA4 (Analytics Admin API v1beta)',
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    url: 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200',
    pageKey: 'accountSummaries',
    pick: (a) => ({
      title: a.displayName ?? '(no name)',
      detail: `${a.account ?? ''} / properties=${(a.propertySummaries ?? []).length}`,
      children: (a.propertySummaries ?? []).map((p) => ({
        title: p.displayName ?? '(no name)',
        detail: p.property ?? '',
      })),
    }),
  },
  {
    id: 'searchconsole',
    label: 'Search Console (Search Console API v3)',
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    url: 'https://searchconsole.googleapis.com/webmasters/v3/sites',
    pageKey: 'siteEntry',
    pick: (s) => ({ title: s.siteUrl ?? '(no url)', detail: `permission=${s.permissionLevel ?? '?'}` }),
    children: [],
  },
  {
    id: 'gtm',
    label: 'Tag Manager (Tag Manager API v2)',
    scope: 'https://www.googleapis.com/auth/tagmanager.readonly',
    url: 'https://tagmanager.googleapis.com/tagmanager/v2/accounts',
    pageKey: 'account',
    pick: (a) => ({
      title: a.name ?? '(no name)',
      detail: `${a.accountId ?? ''} ${a.path ?? ''}`.trim(),
    }),
    children: [],
  },
];

/**
 * API の返却順は保証されない（Search Console の sites は実測で毎回シャッフルされる）。
 * 一次証拠として前回実行と diff できるよう、title→detail で決定的に並べ替える。
 */
function sortItems(items) {
  return [...items]
    .sort((a, b) => {
      const t = String(a.title ?? '').localeCompare(String(b.title ?? ''));
      return t !== 0 ? t : String(a.detail ?? '').localeCompare(String(b.detail ?? ''));
    })
    .map((it) => ({ ...it, children: sortItems(it.children ?? []) }));
}

async function runCheck(check, { key, subject, timeoutMs, signal }) {
  const result = { id: check.id, label: check.label, scope: check.scope, ok: false, items: [] };
  try {
    const token = await getToken({ key, subject, scope: check.scope, signal });
    result.auth = 'ok';
    const body = await apiGet(check.url, token, signal);
    const list = body?.[check.pageKey] ?? [];
    result.ok = true;
    result.items = sortItems(list.map(check.pick));
    result.count = result.items.length;
  } catch (e) {
    result.ok = false;
    result.auth = e.tokenError ? 'failed' : 'ok';
    result.error = e.message;
    result.errorKind = e.tokenError
      ? 'scope_not_delegated' // Admin Console で DWD にこのスコープが未登録
      : e.httpStatus === 403
        ? 'forbidden_no_access' // トークンは取れたが kim がその API への権限を持たない
        : e.httpStatus === 401
          ? 'unauthorized'
          : 'error';
    if (e.detail) result.errorDetail = e.detail?.error ?? e.detail;
  }
  return result;
}

function renderHuman(report) {
  const L = [];
  L.push(`google-property-check  subject=${report.subject}  sa=${report.sa}`);
  L.push(`照会時刻: ${report.checkedAt}`);
  L.push('');
  for (const r of report.results) {
    const mark = r.ok ? 'OK ' : 'NG ';
    L.push(`[${mark}] ${r.label}`);
    if (!r.ok) {
      L.push(`       scope: ${r.scope}`);
      L.push(`       error(${r.errorKind}): ${r.error}`);
      if (r.errorKind === 'scope_not_delegated') {
        L.push('       => DWD にこのスコープが未登録。Admin Console で SA client_id に追加が要る');
      } else if (r.errorKind === 'forbidden_no_access') {
        L.push('       => トークンは取得済み = DWD 正常。kim 自身がこの API の権限を持っていない');
      }
      L.push('');
      continue;
    }
    L.push(`       scope: ${r.scope}`);
    L.push(`       件数: ${r.count}`);
    for (const it of r.items) {
      L.push(`       - ${it.title}${it.detail ? `  (${it.detail})` : ''}`);
      for (const c of it.children ?? []) {
        L.push(`           * ${c.title}${c.detail ? `  (${c.detail})` : ''}`);
      }
    }
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || args.flags.has('h')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }

  const keyPath = args.key ?? DEFAULT_KEY;
  const subject = args.subject ?? DEFAULT_SUBJECT;
  if (!fs.existsSync(keyPath)) {
    console.error(`SA key not found: ${keyPath}`);
    return 2;
  }
  let key;
  try {
    key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (e) {
    console.error(`SA key is not valid JSON: ${keyPath} (${e.message})`);
    return 2;
  }
  if (!key.client_email || !key.private_key) {
    console.error(`SA key missing client_email/private_key: ${keyPath}`);
    return 2;
  }

  const timeoutMs = Number(args.timeout ?? 25000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs * CHECKS.length + 5000);

  const results = [];
  for (const check of CHECKS) {
    results.push(await runCheck(check, { key, subject, timeoutMs, signal: ctrl.signal }));
  }
  clearTimeout(timer);

  const report = {
    tool: 'google-property-check',
    subject,
    sa: key.client_email,
    keyPath,
    checkedAt: new Date().toISOString(),
    results,
  };

  if (args.flags.has('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderHuman(report));
  return 0;
}

// os / path は将来の出力先オプション用に import 済み（未使用警告を避けるため明示的に触る）
void os;
void path;

export {
  parseArgs,
  getToken,
  apiGet,
  runCheck,
  renderHuman,
  sortItems,
  CHECKS,
  DEFAULT_KEY,
  DEFAULT_SUBJECT,
};

// 直接実行されたときだけ走らせる（テストから import しても main が動かないように）
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`fatal: ${e.stack ?? e.message}`);
      process.exit(1);
    });
}
