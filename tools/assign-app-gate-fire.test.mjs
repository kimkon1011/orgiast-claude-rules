import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATE_TABLES,
  SPECS,
  buildCommand,
  collectCounts,
  decideGate,
  gateSignature,
  parseEnvText,
  readMarker,
  resolveCredentials,
  resolvePlaywrightInvocation,
  run,
  shouldFire,
  writeMarker,
} from './assign-app-gate-fire.mjs';

// import.meta.url → 実パスは必ず fileURLToPath（手組みの file:// 剥がしは POSIX で壊れる）。
function dirOf(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}

test('自分自身のパス解決が cwd に依存しない（fileURLToPath 回帰ガード）', (t) => {
  const before = dirOf(import.meta.url);
  assert.ok(path.isAbsolute(before), `not absolute: ${before}`);
  assert.ok(fs.existsSync(path.join(before, 'assign-app-gate-fire.mjs')));
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(os.tmpdir());
  assert.equal(dirOf(import.meta.url), before);
});

test('parseEnvText はコメント・export・引用符を落とす', () => {
  const env = parseEnvText([
    '# コメント',
    'NEXT_PUBLIC_SUPABASE_URL="https://x.supabase.co"',
    "SUPABASE_SERVICE_ROLE_KEY='svc-key'",
    'export SUPABASE_URL=https://y.supabase.co',
    '',
  ].join('\r\n'));
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, 'https://x.supabase.co');
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, 'svc-key');
  assert.equal(env.SUPABASE_URL, 'https://y.supabase.co');
});

test('resolveCredentials は url と service_role が揃う最初のディレクトリを採る', () => {
  const files = {
    [path.join('D:/a', '.env.local')]: 'NEXT_PUBLIC_SUPABASE_URL=https://a.supabase.co\n',
    [path.join('D:/b', '.env.local')]: 'NEXT_PUBLIC_SUPABASE_URL=https://b.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=k\n',
  };
  const creds = resolveCredentials(['D:/a', 'D:/b'], {
    exists: (p) => p in files,
    read: (p) => files[p],
  });
  assert.deepEqual(creds, { url: 'https://b.supabase.co', key: 'k', source: 'D:/b' });
  assert.equal(resolveCredentials(['D:/a'], { exists: (p) => p in files, read: (p) => files[p] }), null);
});

test('decideGate はゲート3テーブルのどれかが 0 件超で開く', () => {
  const closed = decideGate({ job_posting_media: 0, job_category_photos: 0, job_applications: 0 });
  assert.equal(closed.open, false);
  assert.deepEqual(closed.opened, []);

  const open = decideGate({ job_posting_media: 0, job_category_photos: 4, job_applications: 2 });
  assert.equal(open.open, true);
  assert.deepEqual(open.opened, [
    { table: 'job_category_photos', count: 4 },
    { table: 'job_applications', count: 2 },
  ]);
  assert.equal(open.total, 6);
});

test('取得失敗(null)は 0 件と同一視しない（unknown に残し、勝手に開かない）', () => {
  const gate = decideGate({ job_posting_media: null, job_category_photos: 0, job_applications: 0 });
  assert.equal(gate.open, false);
  assert.deepEqual(gate.unknown, ['job_posting_media']);
});

test('gateSignature はゲート3テーブルの件数だけで決まる（INFO テーブルに振り回されない）', () => {
  const a = gateSignature({ job_posting_media: 0, job_category_photos: 0, job_applications: 0, job_postings: 1 });
  const b = gateSignature({ job_posting_media: 0, job_category_photos: 0, job_applications: 0, job_postings: 99 });
  assert.equal(a, b);
  assert.notEqual(a, gateSignature({ job_posting_media: 1, job_category_photos: 0, job_applications: 0 }));
});

test('shouldFire は閉=撃たない / 開かつ未発火=撃つ / 同じ署名で発火済み=撃たない', () => {
  const gate = decideGate({ job_posting_media: 2, job_category_photos: 0, job_applications: 0 });
  const signature = gateSignature({ job_posting_media: 2, job_category_photos: 0, job_applications: 0 });
  assert.equal(shouldFire({ gate: decideGate({}), signature, marker: null }).fire, false);
  assert.equal(shouldFire({ gate, signature, marker: null }).fire, true);
  assert.equal(shouldFire({ gate, signature, marker: { signature } }).fire, false);
  assert.equal(shouldFire({ gate, signature, marker: { signature: 'old' } }).fire, true);
});

test('buildCommand は worktree で本番 URL に 3 spec を流す', () => {
  const cmd = buildCommand({ exists: () => true });
  assert.equal(cmd.cwd, 'D:/assign-app-ready-wt');
  assert.equal(cmd.env.E2E_BASE_URL, 'https://assign-app-psi.vercel.app');
  assert.equal(cmd.testArgs[0], 'test');
  assert.equal(cmd.testArgs.at(-2), '--project=chromium');
  assert.equal(cmd.testArgs.filter((a) => a.endsWith('.spec.ts')).length, SPECS.length);
  assert.ok(cmd.display.includes('npx playwright test e2e/posting-media-wizard.spec.ts'));
});

// Windows では spawnSync('npx.cmd', args) が shell 無しで EINVAL 即死する（実測 2026-10-17）。
// 起動方法の解決を固定する回帰ガード。
test('resolvePlaywrightInvocation は CLI JS 優先・無ければ npx（win は shell 経由）', () => {
  const local = resolvePlaywrightInvocation('D:/w', { exists: () => true });
  assert.equal(local.shell, false);
  assert.equal(local.command, process.execPath);
  assert.ok(local.args[0].endsWith(path.join('node_modules', '@playwright', 'test', 'cli.js')));
  assert.equal(local.via, 'cli.js');

  const fallback = resolvePlaywrightInvocation('D:/w', { exists: () => false });
  assert.equal(fallback.shell, process.platform === 'win32');
  assert.equal(fallback.command, process.platform === 'win32' ? 'npx.cmd' : 'npx');
});

test('collectCounts は content-range の分母を件数として読む', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    headers: { get: () => (url.includes('job_posting_media') ? '0-0/3' : '*/0') },
  });
  const counts = await collectCounts({ url: 'https://x.supabase.co', key: 'k' }, { fetchImpl });
  assert.equal(counts.job_posting_media, 3);
  assert.equal(counts.job_applications, 0);
  assert.equal(Object.keys(counts).length >= GATE_TABLES.length, true);
});

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fire-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('run: ゲート閉なら何も撃たず・marker も書かない', async (t) => {
  const home = tempHome(t);
  let calls = 0;
  const out = await run({
    argv: [],
    creds: { url: 'https://x.supabase.co', key: 'k', source: 'test' },
    fetchImpl: async () => ({ ok: true, headers: { get: () => '*/0' } }),
    runner: () => { calls += 1; return { status: 'passed' }; },
    home,
    log: () => {},
  });
  assert.equal(out.fired, false);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'assign-app-gate-fire.json')), false);
});

test('run: ゲート開なら 1 回撃ち、同じ署名の 2 回目は撃たない', async (t) => {
  const home = tempHome(t);
  let calls = 0;
  const fetchImpl = async (url) => ({
    ok: true,
    headers: { get: () => (url.includes('job_posting_media') ? '0-0/2' : '*/0') },
  });
  const runner = () => { calls += 1; return { status: 'passed', passed: 4, ms: 1234, tail: 'ok', command: 'x' }; };
  const common = { creds: { url: 'https://x.supabase.co', key: 'k', source: 'test' }, fetchImpl, runner, home, log: () => {} };

  const first = await run({ ...common, argv: [] });
  assert.equal(first.fired, true);
  assert.equal(calls, 1);

  const marker = readMarker(path.join(home, '.claude', 'assign-app-gate-fire.json'));
  assert.equal(marker.signature, gateSignature({ job_posting_media: 2, job_category_photos: 0, job_applications: 0 }));
  assert.equal(marker.result.passed, 4);

  const second = await run({ ...common, argv: [] });
  assert.equal(second.fired, false);
  assert.equal(calls, 1);
});

test('run: --dry-run はコマンドを出すだけで撃たない', async (t) => {
  const home = tempHome(t);
  let calls = 0;
  const logs = [];
  const out = await run({
    argv: ['--dry-run'],
    creds: { url: 'https://x.supabase.co', key: 'k', source: 'test' },
    fetchImpl: async (url) => ({ ok: true, headers: { get: () => (url.includes('job_applications') ? '0-0/5' : '*/0') } }),
    runner: () => { calls += 1; },
    home,
    log: (line) => logs.push(line),
  });
  assert.equal(out.fired, false);
  assert.equal(calls, 0);
  assert.equal(out.wouldFire, true);
  assert.ok(logs.some((l) => l.startsWith('[dry-run] 撃つ: cd D:/assign-app-ready-wt')));
  assert.equal(fs.existsSync(path.join(home, '.claude', 'assign-app-gate-fire.json')), false);
});

test('run: ゲート閉でも --dry-run は「撃たない」と判断根拠を見せる', async (t) => {
  const home = tempHome(t);
  const logs = [];
  const out = await run({
    argv: ['--dry-run'],
    creds: { url: 'https://x.supabase.co', key: 'k', source: 'test' },
    fetchImpl: async () => ({ ok: true, headers: { get: () => '*/0' } }),
    runner: () => { throw new Error('must not run'); },
    home,
    log: (line) => logs.push(line),
  });
  assert.equal(out.wouldFire, false);
  assert.ok(logs.some((l) => l.startsWith('[dry-run] 撃たない: cd D:/assign-app-ready-wt')));
});

test('run: 資格情報が無ければ no_creds で静かに終わる', async () => {
  const out = await run({
    argv: [],
    creds: null,
    resolveCreds: () => null,
    fetchImpl: async () => { throw new Error('must not call'); },
    home: os.tmpdir(),
    log: () => {},
  });
  assert.equal(out.fired, false);
  assert.equal(out.reason, 'no_creds');
});

test('writeMarker/readMarker は往復し、壊れた JSON は null', (t) => {
  const home = tempHome(t);
  const file = path.join(home, '.claude', 'assign-app-gate-fire.json');
  writeMarker(file, { signature: 's', firedAt: 'now' });
  assert.deepEqual(readMarker(file), { signature: 's', firedAt: 'now' });
  fs.writeFileSync(file, '{壊れている');
  assert.equal(readMarker(file), null);
});
