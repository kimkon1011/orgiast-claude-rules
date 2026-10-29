import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assetBaseId, loadSources, roundTo } from './asset-naming.mjs';
import { checkNaming } from './build-library.mjs';
import { buildAssertion, parseArgs as parseFetchArgs } from './fetch-stl.mjs';
import { defaultBlenderPath, pickLatestZip } from './ensure-blender.mjs';
import { generateKeyPairSync } from 'node:crypto';

test('stl-sources.json: 23 件・id/name/slug が重複しない・必須項目がある', () => {
  const sources = loadSources();
  assert.equal(sources.length, 23);
  for (const field of ['id', 'name', 'slug']) {
    assert.equal(new Set(sources.map((s) => s[field])).size, 23, `${field} が重複`);
  }
  for (const s of sources) {
    assert.match(s.id, /^[A-Za-z0-9_-]{20,}$/, `id 形式: ${s.id}`);
    assert.ok(s.name.endsWith('.stl'), s.name);
    assert.match(s.slug, /^[a-z0-9_]+$/);
    assert.ok(['box', 'length', 'panel'].includes(s.kind), `${s.name}: kind`);
    assert.ok('slidePage' in s, `${s.name}: slidePage キーが必要（未確認は null）`);
    if (s.mode) assert.ok(['cluster', 'grid', 'loose'].includes(s.mode));
  }
});

test('asset_id 命名: トラスは最長辺を長さに・ステージはパネル寸法・箱は W×D×H', () => {
  assert.equal(assetBaseId('truss300_silver', 'length', [330, 330, 2400]), 'truss300_silver_L2400');
  assert.equal(assetBaseId('truss300_silver', 'length', [2400, 330, 330]), 'truss300_silver_L2400');
  assert.equal(assetBaseId('stage_panel', 'panel', [989, 1000, 589], 50), 'stage_panel_1000x1000');
  assert.equal(assetBaseId('logo_box', 'box', [500, 900, 820]), 'logo_box_500x900x820');
  assert.equal(assetBaseId('logo_box', 'box', [504, 896, 824]), 'logo_box_500x900x820');
  assert.equal(roundTo(985, 10), 990);
  assert.equal(roundTo(975, 50), 1000);
  assert.throws(() => assetBaseId('Bad Slug', 'box', [1, 2, 3]), /slug/);
  assert.throws(() => assetBaseId('x', 'box', [1, 2]), /dims/);
  assert.throws(() => assetBaseId('x', 'cube', [1, 2, 3]), /kind/);
});

test('命名検査: Python が付けた asset_id と JS の規則の差異を検出する', () => {
  const sources = loadSources();
  const src = sources.find((s) => s.slug === 'logo_box');
  const good = [{ asset_id: 'logo_box_500x900x820', source_file: src.name, dims_mm: [500, 900, 820] }];
  assert.deepEqual(checkNaming(good, sources), []);
  const suffixed = [{ asset_id: 'logo_box_500x900x820_2', source_file: src.name, dims_mm: [500, 900, 820] }];
  assert.deepEqual(checkNaming(suffixed, sources), []);
  const bad = [{ asset_id: 'logo_box_1x1x1', source_file: src.name, dims_mm: [500, 900, 820] }];
  assert.equal(checkNaming(bad, sources).length, 1);
});

test('fetch-stl: 引数解析と DWD の JWT 組み立て（鍵の中身を出さない）', () => {
  assert.ok(parseFetchArgs([]).out.endsWith('stl'));
  assert.equal(parseFetchArgs(['--out', 'x']).out.endsWith('x'), true);
  assert.throws(() => parseFetchArgs(['--bogus']), /unknown option/);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = buildAssertion({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: pem }, 'user@example.com', 1000);
  const [h, p, sig] = jwt.split('.');
  assert.ok(sig.length > 100);
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.sub, 'user@example.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive');
  assert.equal(claims.exp - claims.iat, 3600);
});

test('ensure-blender: 配布一覧から最新の 5.2.x windows-x64 zip を選ぶ', () => {
  const html = '<a href="blender-5.2.1-windows-x64.zip">a</a><a href="blender-5.2.10-windows-x64.zip">b</a><a href="blender-5.2.3-linux-x64.tar.xz">c</a><a href="blender-5.2.9-windows-arm64.zip">d</a>';
  assert.equal(pickLatestZip(html), 'blender-5.2.10-windows-x64.zip');
  assert.equal(pickLatestZip('<a href="x">'), null);
  assert.ok(defaultBlenderPath('/home/u').endsWith('blender.exe'));
});

// Blender 依存の確認。Blender が無い環境（CI 等）では「合格」でも「skip」でもなく、
// 測定不能（exit 2 相当）として TODO 表示＋診断メッセージで明示する。
export function measureBlender(env = process.env) {
  const exe = env.BOOTH3D_BLENDER || defaultBlenderPath();
  if (!existsSync(exe)) return { status: 'unmeasurable', exitCode: 2, reason: `Blender が見つからない: ${exe}` };
  const r = spawnSync(exe, ['-b', '--python-expr', 'import bpy; print("BLENDER_OK", bpy.app.version_string)'], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  const m = /BLENDER_OK (\S+)/.exec(r.stdout ?? '');
  if (r.status !== 0 || !m) return { status: 'failed', exitCode: 1, reason: `Blender が起動しない (exit ${r.status})` };
  return { status: 'ok', exitCode: 0, version: m[1] };
}

test('Blender ヘッドレス起動（無い環境では測定不能 exit 2 相当を明示）', (t) => {
  const m = measureBlender();
  if (m.status === 'unmeasurable') {
    t.diagnostic(`測定不能(exit 2 相当): ${m.reason}。Blender 依存の検証は未実施`);
    t.todo(`測定不能(exit 2 相当): ${m.reason}`);
    return;
  }
  assert.equal(m.status, 'ok', m.reason);
  assert.match(m.version, /^5\.2\./);
});
