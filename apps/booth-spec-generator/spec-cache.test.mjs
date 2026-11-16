// spec-cache.test.mjs — spec-cache.mjs のテスト
// node:test + node:assert を使用、外部依存なし
// 実行: node apps/booth-spec-generator/spec-cache.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============================================================
// テスト用ユーティリティ
// ============================================================
let _compress, _decompress, _gc, _list, _save, _load;

// テスト前にモジュールを一度だけロード
async function ensureModule() {
  if (!_compress) {
    const mod = await import('./spec-cache.mjs');
    _compress = mod.compress;
    _decompress = mod.decompress;
    _gc = mod.gc;
    _list = mod.list;
    _save = mod.save;
    _load = mod.load;
  }
}

function tempCacheDir() {
  const dir = join(tmpdir(), `booth-spec-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rmDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

// ============================================================
// テスト用サンプルspec（3×3m ブース）
// ============================================================
const SAMPLE_FILE = fileURLToPath(new URL('../../tools/booth-3d/examples/sample-3x3-rebooth.json', import.meta.url));
const SAMPLE_SPEC = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'));

// 浮動小数点テスト用
const FLOAT_SPEC = {
  case_id: 'FLOAT-v1',
  title: '浮動小数点テスト',
  booth: { w_mm: 3000, d_mm: 3000, height_limit_mm: 2700, open_sides: ['front'], walls: ['back'] },
  items: [
    { asset_id: 'system_panel', w_mm: 2600.123, d_mm: 2400.456, h_mm: 40.789, t_mm: 40.012, pos_mm: [1500.567, 200.891, 0.123], count: 1 }
  ],
  views: ['top']
};

// 重複itemテスト用
const DUP_SPEC = {
  case_id: 'DUP-v1',
  title: '重複除去テスト',
  booth: { w_mm: 3000, d_mm: 3000, height_limit_mm: 2700, open_sides: ['front'], walls: ['back'] },
  items: [
    { asset_id: 'panel_display_450x900x790', w_mm: 450, d_mm: 900, h_mm: 790, t_mm: 50, pos_mm: [500, 1500, 0], count: 1 },
    { asset_id: 'panel_display_450x900x790', w_mm: 450, d_mm: 900, h_mm: 790, t_mm: 50, pos_mm: [500, 1500, 0], count: 1 },
    { asset_id: 'floor_panel',               w_mm: 3000, d_mm: 3000, h_mm: 50, t_mm: 50, pos_mm: [1500, 1500, 0], count: 1 }
  ],
  views: ['top']
};

// ============================================================
// テスト1: compress / decompress ラウンドトリップ（可逆性）
// ============================================================
describe('compress / decompress ラウンドトリップ', async () => {
  before(ensureModule);

  it('通常specの圧縮→復元で内容が一致する', () => {
    const compressed = _compress(SAMPLE_SPEC);
    assert.ok(compressed, '圧縮結果がnullでないこと');
    const restored = _decompress(compressed);
    assert.ok(restored, '復元結果がnullでないこと');

    assert.deepEqual(restored, SAMPLE_SPEC);
  });

  it('浮動小数点specで値が丸められる', () => {
    const compressed = _compress(FLOAT_SPEC);
    const restored = _decompress(compressed);
    const orig = FLOAT_SPEC.items[0].w_mm;
    const rest = restored.items[0].w_mm;
    assert.notEqual(rest, orig, '丸めが発生すること');
    assert.equal(rest, Math.round(orig * 100) / 100, '小数第2位まで');
  });

  it('重複itemが除去される', () => {
    const compressed = _compress(DUP_SPEC);
    assert.ok(compressed);
    assert.equal(compressed.items.length, 2, '重複除去で2件になること');
  });

  it('null/空フィールドが削除される', () => {
    const spec = JSON.parse(JSON.stringify(SAMPLE_SPEC));
    spec.items[0].extraField = null;
    const compressed = _compress(spec);
    assert.ok(compressed);
    assert.equal(compressed.items[0].extraField, undefined, 'nullフィールド削除');
  });

  it('スキーマ必須の空配列は残る', () => {
    const spec = { ...SAMPLE_SPEC, items: [], views: [], booth: { ...SAMPLE_SPEC.booth, open_sides: [], walls: [] } };
    const restored = _decompress(_compress(spec));
    assert.deepEqual(restored.items, []);
    assert.deepEqual(restored.views, []);
    assert.deepEqual(restored.booth.open_sides, []);
    assert.deepEqual(restored.booth.walls, []);
  });

  it('1mm未満だけ異なる座標を重複扱いしない', () => {
    const spec = structuredClone(SAMPLE_SPEC);
    spec.items = [
      { asset_id: 'same', pos_mm: [100.1, 200, 0] },
      { asset_id: 'same', pos_mm: [100.2, 200, 0] }
    ];
    assert.equal(_compress(spec).items.length, 2);
  });
});

// ============================================================
// テスト2: 圧縮でサイズが減少すること
// ============================================================
describe('compress サイズ削減', async () => {
  before(ensureModule);

  it('圧縮後のサイズが元より小さい', () => {
    const compressedSize = Buffer.byteLength(JSON.stringify(_compress(SAMPLE_SPEC)), 'utf8');
    const sourceSize = Buffer.byteLength(readFileSync(SAMPLE_FILE, 'utf8'), 'utf8');
    assert.ok(compressedSize < sourceSize, `圧縮後(${compressedSize}) < 元ファイル(${sourceSize})`);
  });

  it('浮動小数点specで圧縮効果がある', () => {
    const compressed = _compress(FLOAT_SPEC);
    assert.ok(JSON.stringify(compressed).length < JSON.stringify(FLOAT_SPEC).length, '浮動小数点丸めで圧縮効果');
  });
});

// ============================================================
// テスト3: GC 世代数制限
// ============================================================
describe('GC maxGenerations', async () => {
  let cacheDir;

  before(async () => {
    await ensureModule();
    cacheDir = tempCacheDir();
    mkdirSync(join(cacheDir, 'specs'), { recursive: true });

    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(cacheDir, 'specs', `GC-TEST-v${i}.json`), '{}', 'utf-8');
    }
    writeFileSync(join(cacheDir, 'index.json'), JSON.stringify({
      specs: Array.from({ length: 7 }, (_, i) => ({
        case_id: `GC-TEST-v${i + 1}`,
        title: `GCテスト v${i + 1}`,
        file: `GC-TEST-v${i + 1}.json`,
        createdAt: new Date(Date.now() - i * 86400000).toISOString(),
        size: 1000,
        compressedSize: 800
      }))
    }), 'utf-8');
  });

  after(() => rmDir(cacheDir));

  it('maxGenerations=3 で最新3件だけ残る', () => {
    const result = _gc(cacheDir, 30, 3);
    assert.equal(result.deleted, 4, 'v1〜v4削除');
    assert.equal(result.kept, 3, 'v5〜v7保持');

    const index = JSON.parse(readFileSync(join(cacheDir, 'index.json'), 'utf-8'));
    const remaining = index.specs.map(e => e.case_id);
    assert.ok(remaining.includes('GC-TEST-v5'));
    assert.ok(remaining.includes('GC-TEST-v6'));
    assert.ok(remaining.includes('GC-TEST-v7'));
    assert.ok(!remaining.includes('GC-TEST-v1'));
  });
});

// ============================================================
// テスト4: GC 日数制限
// ============================================================
describe('GC maxAgeDays', async () => {
  let cacheDir;

  before(async () => {
    await ensureModule();
    cacheDir = tempCacheDir();
    mkdirSync(join(cacheDir, 'specs'), { recursive: true });
    const now = Date.now();

    for (let i = 1; i <= 4; i++) {
      writeFileSync(join(cacheDir, 'specs', `OLD-v${i}.json`), '{}', 'utf-8');
    }
    writeFileSync(join(cacheDir, 'index.json'), JSON.stringify({
      specs: [
        { case_id: 'OLD-v1', title: '古い', file: 'OLD-v1.json', createdAt: new Date(now - 3 * 86400000).toISOString(), size: 500, compressedSize: 400 },
        { case_id: 'OLD-v2', title: '古い', file: 'OLD-v2.json', createdAt: new Date(now - 2 * 86400000).toISOString(), size: 500, compressedSize: 400 },
        { case_id: 'OLD-v3', title: '新しい', file: 'OLD-v3.json', createdAt: new Date(now - 0.3 * 86400000).toISOString(), size: 500, compressedSize: 400 },
        { case_id: 'OLD-v4', title: '新しい', file: 'OLD-v4.json', createdAt: new Date(now - 0.1 * 86400000).toISOString(), size: 500, compressedSize: 400 }
      ]
    }), 'utf-8');
  });

  after(() => rmDir(cacheDir));

  it('maxAgeDays=1 で1日超のspecが削除される', () => {
    const result = _gc(cacheDir, 1, 10);
    assert.equal(result.deleted, 2, 'v1,v2削除');
    assert.equal(result.kept, 2, 'v3,v4保持');

    const index = JSON.parse(readFileSync(join(cacheDir, 'index.json'), 'utf-8'));
    const ids = index.specs.map(e => e.case_id);
    assert.ok(ids.includes('OLD-v3'));
    assert.ok(ids.includes('OLD-v4'));
    assert.ok(!ids.includes('OLD-v1'));
  });
});

// ============================================================
// テスト5: save / load ラウンドトリップ
// ============================================================
describe('save / load ラウンドトリップ', async () => {
  let cacheDir;

  before(async () => {
    await ensureModule();
    cacheDir = tempCacheDir();
  });

  after(() => rmDir(cacheDir));

  it('保存→読み込みで内容が一致する', () => {
    const filePath = _save(cacheDir, SAMPLE_SPEC);
    assert.ok(existsSync(filePath), '保存ファイル存在');

    const loaded = _load(cacheDir, SAMPLE_SPEC.case_id);
    assert.ok(loaded, '読み込み結果非null');
    assert.equal(loaded.case_id, SAMPLE_SPEC.case_id);
    assert.equal(loaded.title, SAMPLE_SPEC.title);
    assert.deepEqual(loaded.booth, SAMPLE_SPEC.booth);
    assert.equal(loaded.items.length, SAMPLE_SPEC.items.length);
  });

  it('存在しない case_id は null', () => {
    assert.equal(_load(cacheDir, 'NOT-EXIST'), null);
  });

  it('空ディレクトリでは null', () => {
    const empty = join(cacheDir, 'empty');
    assert.equal(_load(empty, 'ANY'), null);
  });
});

// ============================================================
// テスト6: list
// ============================================================
describe('list', async () => {
  let cacheDir;

  before(async () => {
    await ensureModule();
    cacheDir = tempCacheDir();
    _save(cacheDir, SAMPLE_SPEC);
  });

  after(() => rmDir(cacheDir));

  it('保存したspecの一覧が取得できる', () => {
    const entries = _list(cacheDir);
    assert.ok(Array.isArray(entries), '配列');
    assert.ok(entries.length >= 1, '1件以上');

    const entry = entries.find(e => e.case_id === SAMPLE_SPEC.case_id);
    assert.ok(entry, '保存したエントリを含む');
    assert.equal(entry.title, SAMPLE_SPEC.title);
    assert.ok(entry.createdAt);
    assert.equal(typeof entry.size, 'number');
    assert.equal(typeof entry.compressedSize, 'number');
  });

  it('空のキャッシュでは空配列', () => {
    const entries = _list(join(cacheDir, 'nonexistent'));
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 0);
  });
});

// ============================================================
// テスト7: generate-spec.mjs --dry-run
// ============================================================
describe('generate-spec.mjs --dry-run', () => {
  it('dry-runでプロンプトとスケルトンが出力される', () => {
    const scriptPath = fileURLToPath(new URL('./generate-spec.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [
      scriptPath,
      '--client', 'テストクライアント',
      '--event', 'テスト展示会',
      '--budget', '300',
      '--size', '3x6',
      '--requirements', '商談重視',
      '--dry-run'
    ], { encoding: 'utf-8' });

    assert.ok(output.includes('アセンブルドプロンプト'), 'プロンプトセクション');
    assert.ok(output.includes('スペックスケルトン'), 'スケルトンセクション');
    assert.ok(output.includes('テストクライアント'), 'クライアント名');
    assert.ok(output.includes('テスト展示会'), 'イベント名');
    assert.ok(output.includes('300'), '予算');
  });

  it('batch生成で3件をキャッシュと出力先へ保存する', () => {
    const scriptPath = fileURLToPath(new URL('./generate-spec.mjs', import.meta.url));
    const outputDir = tempCacheDir();
    const cacheDir = join(outputDir, 'cache');
    try {
      execFileSync(process.execPath, [
        scriptPath,
        '--client', 'テストクライアント',
        '--budget', '200,300,500',
        '--size', '3x6',
        '--requirements', '商談重視・実機デモあり',
        '--batch',
        '--output', join(outputDir, 'spec-{case_id}.json')
      ], {
        encoding: 'utf8',
        env: { ...process.env, BOOTH_SPEC_CACHE_DIR: cacheDir }
      });

      const entries = JSON.parse(readFileSync(join(cacheDir, 'index.json'), 'utf8')).specs;
      assert.equal(entries.length, 3);
      for (const entry of entries) {
        const spec = JSON.parse(readFileSync(join(outputDir, `spec-${entry.case_id}.json`), 'utf8'));
        assert.deepEqual(Object.keys(spec).sort(), ['booth', 'case_id', 'items', 'title', 'views']);
        assert.ok(spec.items.length >= 6);
      }
    } finally {
      rmDir(outputDir);
    }
  });
});
