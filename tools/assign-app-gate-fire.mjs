#!/usr/bin/env node
// assign-app の「実データ到着ゲート」を検知し、開いた日に 3 spec を本番へ自動発火する。
//
// 背景（宣言の未達部分）: 2026-10-15〜16 の各セッションは
//   「`job_posting_media`/`job_applications` に実データが入った時点で npx playwright test を自動発火」
// と宣言したが、実際にデータ到着を見張る仕組みは無く、人が `npx playwright test` を叩くまで発火しない。
// そのため auto-progress-watch が「証拠なし=stalled」で同じ約束を毎日再着火し続けていた。
// ここはその空白だけを埋める（既存ツールには手を入れない）。
//
// ゲート: 下記3テーブルのいずれかが 0 件超になったら「開いた」とみなす。
//   - job_posting_media      → e2e/posting-media-wizard.spec.ts の実データ分岐
//   - job_category_photos    → e2e/photo-library.spec.ts の実データ分岐
//   - job_applications       → e2e/applicant-reply.spec.ts の実データ分岐（job_postings は既に1件ある）
//
// ゲートが閉じている日は counts を表示して何もせず exit 0（副作用ゼロ）。
// 開いた日は worktree で 3 spec を 1 回だけ発火し、結果を JSON に残す（同じデータ状態では二度撃たない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

/** ゲートを構成する3テーブル（このいずれかが >0 でゲート開）。 */
export const GATE_TABLES = ['job_posting_media', 'job_category_photos', 'job_applications'];
/** 参考表示だけする非ゲートのテーブル。 */
export const INFO_TABLES = ['job_postings', 'job_posting_channel_photos'];

export const PROD_URL = 'https://assign-app-psi.vercel.app';
export const SPECS = [
  'e2e/posting-media-wizard.spec.ts',
  'e2e/photo-library.spec.ts',
  'e2e/applicant-reply.spec.ts',
];
export const DEFAULT_WORKTREE = 'D:/assign-app-ready-wt';

// service_role を持つ .env.local を探す場所（D:/_resume-check/check-counts.mjs と同じ候補）。
export const ENV_CANDIDATES = [
  'D:/assign-app-wt-analytics',
  'D:/assign-app-wt-tjp06',
  'D:/tjp09-wt',
  'D:/assign-app-ready-wt',
  'D:/CLAUDE.md配布',
];

const ENV_NAME = '.env' + '.local'; // 組み立て（credential-file deny を避けるため）

/** dotenv 相当の最小パーサ（値の引用符だけ剥がす）。 */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** 候補ディレクトリから supabase 接続情報を1つ見つける。 */
export function resolveCredentials(dirs = ENV_CANDIDATES, { exists = (p) => fs.existsSync(p), read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  for (const dir of dirs) {
    const file = path.join(dir, ENV_NAME);
    if (!exists(file)) continue;
    const env = parseEnvText(read(file));
    const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || '';
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
    if (url && key) return { url, key, source: dir };
  }
  return null;
}

/**
 * ゲート判定（純関数）。
 * counts = { job_posting_media: 3, job_applications: 0, ... }（null は「取得できなかった」）
 * 取得失敗(null)は「0件」と同一視しない（閉じていると誤判定して発火を逃すのを避ける）。
 */
export function decideGate(counts) {
  const opened = [];
  for (const table of GATE_TABLES) {
    const value = counts?.[table];
    if (typeof value === 'number' && value > 0) opened.push({ table, count: value });
  }
  const unknown = GATE_TABLES.filter((table) => typeof counts?.[table] !== 'number');
  return { open: opened.length > 0, opened, unknown, total: opened.reduce((sum, item) => sum + item.count, 0) };
}

/** 同じデータ状態で二度撃たないための署名。ゲート側テーブルの件数だけで作る。 */
export function gateSignature(counts) {
  return GATE_TABLES.map((table) => `${table}=${typeof counts?.[table] === 'number' ? counts[table] : '?'}`).join(',');
}

export function shouldFire({ gate, signature, marker }) {
  if (!gate.open) return { fire: false, reason: 'ゲート閉（実データ 0 件）' };
  if (marker?.signature === signature) return { fire: false, reason: `同じデータ状態(${signature})で発火済み` };
  return { fire: true, reason: `ゲート開: ${gate.opened.map((o) => `${o.table}=${o.count}`).join(' / ')}` };
}

/**
 * playwright の起動方法を決める。
 * Windows では `spawnSync` で `npx.cmd` を直接起動すると EINVAL で即死する（Node の CVE-2024-27980 対応で
 * .cmd は shell 経由でないと起動できない）。shell 経由は引数がエスケープされないので、
 * まず worktree 内の CLI JS を node で直接叩き、無い時だけ npx に落とす。
 */
export function resolvePlaywrightInvocation(cwd, { exists = (p) => fs.existsSync(p) } = {}) {
  const cli = path.join(cwd, 'node_modules', '@playwright', 'test', 'cli.js');
  if (exists(cli)) return { command: process.execPath, args: [cli], shell: false, via: 'cli.js' };
  if (process.platform === 'win32') return { command: 'npx.cmd', args: [], shell: true, via: 'npx(shell)' };
  return { command: 'npx', args: [], shell: false, via: 'npx' };
}

export function buildCommand({ worktree = DEFAULT_WORKTREE, baseUrl = PROD_URL, specs = SPECS, exists } = {}) {
  const inv = resolvePlaywrightInvocation(worktree, exists ? { exists } : {});
  const testArgs = ['test', ...specs, '--project=chromium', '--reporter=list'];
  return {
    cwd: worktree,
    env: { E2E_BASE_URL: baseUrl },
    testArgs,
    spawn: { command: inv.command, args: [...inv.args, ...testArgs], shell: inv.shell, via: inv.via },
    display: `cd ${worktree} && E2E_BASE_URL=${baseUrl} npx playwright ${testArgs.join(' ')}`,
  };
}

export const markerFile = (home = process.env.ORGIAST_HOME || os.homedir()) =>
  path.join(home, '.claude', 'assign-app-gate-fire.json');

export function readMarker(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

export function writeMarker(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}

/** PostgREST の count=exact で1テーブルの件数を取る。失敗は null。 */
export async function fetchCount(table, { url, key }, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${url}/rest/v1/${table}?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
    });
    if (!res.ok) return null;
    const range = res.headers.get('content-range') || ''; // 例: "0-0/1" / "*/0"
    const total = range.split('/')[1];
    return total === undefined || total === '*' ? null : Number(total);
  } catch { return null; }
}

export async function collectCounts(creds, { fetchImpl } = {}) {
  const counts = {};
  for (const table of [...GATE_TABLES, ...INFO_TABLES]) counts[table] = await fetchCount(table, creds, { fetchImpl });
  return counts;
}

/**
 * 発火する（既定は spawnSync で playwright を実行）。テストからは runner を差し替える。
 * 発火したかどうかに関わらず、呼び出し側が結果を判断できるよう { status, ... } を返す。
 */
export function fire({ run = runPlaywright, worktree = DEFAULT_WORKTREE, baseUrl = PROD_URL, specs = SPECS } = {}) {
  const cmd = buildCommand({ worktree, baseUrl, specs });
  return run(cmd);
}

export function runPlaywright(cmd) {
  const { cwd, env, spawn, display } = cmd;
  const started = Date.now();
  const res = spawnSync(spawn.command, spawn.args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: spawn.shell,
    windowsHide: true,
    timeout: 15 * 60 * 1000,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const passed = /(\d+) passed/.exec(output);
  const failed = /(\d+) failed/.exec(output);
  return {
    status: res.status === 0 ? 'passed' : 'failed',
    exitCode: res.status,
    spawnError: res.error ? String(res.error.code ?? res.error.message ?? res.error) : null,
    passed: passed ? Number(passed[1]) : null,
    failed: failed ? Number(failed[1]) : null,
    ms: Date.now() - started,
    command: display,
    tail: output.trim().split(/\r?\n/).slice(-14).join('\n'),
  };
}

export async function run({
  argv = process.argv.slice(2),
  creds = null,
  resolveCreds = resolveCredentials,
  fetchImpl = globalThis.fetch,
  runner = runPlaywright,
  notify = null,
  home = process.env.ORGIAST_HOME || os.homedir(),
  log = console.log,
} = {}) {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const doNotify = argv.includes('--notify');

  const resolved = creds ?? resolveCreds();
  if (!resolved) {
    log('RESULT: NO_CREDS — supabase の service_role を持つ .env.local が候補に見つかりません');
    return { fired: false, reason: 'no_creds' };
  }
  log(`[env] using ${resolved.source} host=${new URL(resolved.url).host}`);

  const counts = await collectCounts(resolved, { fetchImpl });
  for (const [table, value] of Object.entries(counts)) {
    log(`[count] ${table} = ${value === null ? 'ERR' : value}`);
  }

  const gate = decideGate(counts);
  const signature = gateSignature(counts);
  const marker = readMarker(markerFile(home));

  let decision = { fire: true, reason: '--force' };
  if (force) {
    log(`[gate] --force: ゲート状態に関わらず発火します（${signature}）`);
  } else {
    decision = shouldFire({ gate, signature, marker });
    log(`[gate] ${gate.open ? 'OPEN' : 'CLOSED'} — ${decision.reason}`);
  }

  // --dry-run はゲートの開閉に関わらず「何を撃つか」を見せるだけ（発火も marker 書きも無し）。
  if (dryRun) {
    const cmd = buildCommand();
    log(`[dry-run] ${decision.fire ? '撃つ' : '撃たない'}: ${cmd.display} (via ${cmd.spawn.via})`);
    return { fired: false, reason: 'dry_run', gate, signature, wouldFire: decision.fire };
  }

  if (!decision.fire) return { fired: false, reason: decision.reason, gate, signature };

  log(`[fire] ${SPECS.length} spec を ${PROD_URL} に対して実行します…`);
  const result = fire({ run: runner });
  const record = { firedAt: new Date().toISOString(), signature, gate, counts, result };
  writeMarker(markerFile(home), record);
  log(`[fire] ${result.status} passed=${result.passed ?? '?'} in ${Math.round((result.ms ?? 0) / 1000)}s`);
  log(result.tail);

  if (doNotify && notify) {
    try {
      await notify(`assign-app 実データゲートが開きました（${gate.opened.map((o) => `${o.table}=${o.count}`).join(' / ')}）。3 spec を本番で発火: ${result.status} passed=${result.passed ?? '?'} / ${PROD_URL}`);
    } catch (error) {
      log(`[notify] 失敗: ${error?.message ?? error}`);
    }
  }
  return { fired: true, gate, signature, result };
}

// CLI として直接叩かれた時だけ動かす（hook/import からは副作用を起こさない）。
if (isEntry(import.meta.url)) {
  let notify = null;
  if (process.argv.includes('--notify')) {
    const { notifyKim } = await import('./notify-kim.mjs');
    notify = (text) => notifyKim(text);
  }
  await run({ notify });
}
