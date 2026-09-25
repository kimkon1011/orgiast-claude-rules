import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatYen, formatDays, priceOf, render, estimate, main } from './ai-advisory-service.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('./ai-advisory-service-catalog.json', import.meta.url), 'utf8'));
const docUrl = new URL('../docs/ai-advisory-service-packages.md', import.meta.url);
const usage = '使い方: node tools/ai-advisory-service.mjs [--write|--check|--estimate <id,id,...>]\n';
const drift = 'drift: docs/ai-advisory-service-packages.md が生成物と一致しません。--write で再生成してください。\n';
const nonempty = (value) => assert.ok(typeof value === 'string' && value.trim().length > 0);

function withCli(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-advisory-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'docs'));
    for (const file of ['ai-advisory-service.mjs', 'is-entry.mjs', 'ai-advisory-service-catalog.json']) {
      fs.copyFileSync(new URL(file, import.meta.url), path.join(dir, 'tools', file));
    }
    const doc = path.join(dir, 'docs', 'ai-advisory-service-packages.md');
    fs.copyFileSync(docUrl, doc);
    const run = (...args) => {
      const result = spawnSync(process.execPath, [path.join(dir, 'tools', 'ai-advisory-service.mjs'), ...args], {
        cwd: os.tmpdir(), encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    };
    return fn({ dir, doc, run });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('カタログ: 全idが重複しない', () => {
  const ids = [...catalog.packages, ...catalog.options].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});
test('カタログ: トップレベル必須キーが存在', () => {
  for (const key of ['purpose', 'priceAsOf', 'priceStatus', 'priceStatusNote', 'dayRateYen', 'dayRateBasis', 'pricingMethod', 'costNote', 'packages', 'options']) {
    assert.ok(Object.hasOwn(catalog, key), key);
  }
});
test('カタログ: 価格はdraft', () => assert.equal(catalog.priceStatus, 'draft'));
test('カタログ: 基準日はYYYY-MM-DD', () => assert.match(catalog.priceAsOf, /^\d{4}-\d{2}-\d{2}$/));
test('カタログ: 人日単価は正の整数', () => assert.ok(Number.isInteger(catalog.dayRateYen) && catalog.dayRateYen > 0));
test('カタログ: 各パッケージの工数・期間・成果物・前提・除外・文字列', () => {
  assert.ok(catalog.packages.length > 0);
  for (const pkg of catalog.packages) {
    for (const key of ['effortDays', 'durationWeeks']) assert.ok(Number.isFinite(pkg[key]) && pkg[key] > 0);
    for (const key of ['deliverables', 'prerequisites', 'excludes']) {
      assert.ok(Array.isArray(pkg[key]) && pkg[key].length >= 1);
      pkg[key].forEach(nonempty);
    }
    for (const key of ['id', 'name', 'objective', 'targetCustomer', 'effortBasis']) nonempty(pkg[key]);
  }
});
test('カタログ: 各オプションの工数と単位が有効', () => {
  assert.ok(catalog.options.length > 0);
  for (const option of catalog.options) {
    assert.ok(Number.isFinite(option.effortDays) && option.effortDays > 0);
    for (const key of ['id', 'name', 'unit', 'note']) nonempty(option[key]);
  }
});
test('formatYen: 0・正数・負数の3桁区切り', () => {
  for (const [input, expected] of [[0, '0'], [80000, '80,000'], [40000, '40,000'], [1234567, '1,234,567'], [-1000, '-1,000']]) assert.equal(formatYen(input), expected);
});
test('formatDays: 余分な末尾0を付けない', () => {
  for (const [input, expected] of [[1, '1'], [0.5, '0.5'], [2, '2']]) assert.equal(formatDays(input), expected);
});
test('priceOf: 円未満を切り捨てる', () => {
  assert.equal(priceOf({ effortDays: 0.5 }, 101), 50);
  assert.equal(priceOf({ effortDays: 1.25 }, 99), 123);
});
test('estimate: 単一パッケージの明細と合計', () => {
  const pkg = catalog.packages[0];
  const result = estimate(catalog, [pkg.id]);
  assert.deepEqual(result, {
    lines: [{ id: pkg.id, name: pkg.name, effortDays: pkg.effortDays, yen: pkg.effortDays * catalog.dayRateYen, kind: 'package' }],
    totalDays: pkg.effortDays, totalYen: pkg.effortDays * catalog.dayRateYen,
  });
});
test('estimate: パッケージとオプションの合計・指定順', () => {
  const result = estimate(catalog, ['extra-online', 'assessment']);
  assert.deepEqual(result.lines.map((line) => [line.id, line.kind]), [['extra-online', 'option'], ['assessment', 'package']]);
  assert.equal(result.totalDays, 3);
  assert.equal(result.totalYen, 240000);
});
test('estimate: 未知idを混ぜてもthrow', () => assert.throws(() => estimate(catalog, ['assessment', 'nope']), { message: '未知の id: nope' }));
test('render: 先頭は生成元コメント', () => assert.equal(render(catalog).split('\n')[0], '<!-- このファイルは tools/ai-advisory-service.mjs --write が生成する。手で編集しない。 -->'));
test('render: 価格注意書きを含む', () => assert.ok(render(catalog).includes(`> ⚠️ ${catalog.priceStatusNote}`)));
test('render: 全パッケージとオプションの名前を含む', () => {
  for (const item of [...catalog.packages, ...catalog.options]) assert.ok(render(catalog).includes(item.name));
});
test('render: 決定的で入力を変更しない', () => {
  const before = structuredClone(catalog);
  assert.equal(render(catalog), render(catalog));
  estimate(catalog, ['assessment']);
  assert.deepEqual(catalog, before);
});
test('render: 末尾改行はちょうど1つ', () => {
  assert.match(render(catalog), /\n$/);
  assert.doesNotMatch(render(catalog), /\n\n$/);
});
test('render: 成果物1件なら「ほか0件」を付けない', () => {
  const copy = structuredClone(catalog);
  copy.packages[0].deliverables = ['単一成果物'];
  assert.ok(render(copy).includes('| assessment | AI活用診断（1day） | 1 | 80,000 | 1週間 | 単一成果物 |'));
  assert.ok(!render(copy).includes('ほか0件'));
});
test('CLI: --check 一致でexit 0', () => withCli(({ run }) => {
  const result = run('--check');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'OK: docs/ai-advisory-service-packages.md は最新\n');
  assert.equal(result.stderr, '');
}));
test('CLI: --check 改変でexit 1', () => withCli(({ doc, run }) => {
  fs.appendFileSync(doc, '改変\n');
  const result = run('--check');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, drift);
  assert.equal(result.stdout, '');
}));
test('CLI: --check 欠損でexit 1', () => withCli(({ doc, run }) => {
  fs.unlinkSync(doc);
  const result = run('--check');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, drift);
}));
test('CLI: --check CRLFでもexit 0', () => withCli(({ doc, run }) => {
  fs.writeFileSync(doc, render(catalog).replace(/\n/g, '\r\n'), 'utf8');
  assert.equal(run('--check').status, 0);
}));
test('CLI: 見積全文とexit 0', () => withCli(({ run }) => {
  const result = run('--estimate', 'assessment,extra-online');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `見積: AI活用診断（1day） ほか1件\n- assessment AI活用診断（1day）: 1 人日 / 80,000 円\n- extra-online 追加オンライン伴走（月4回）: 2 人日 / 160,000 円\n合計: 3 人日 / 240,000 円\n※ ${catalog.priceStatusNote}\n`);
}));
test('CLI: 未知idはexit 2', () => withCli(({ run }) => {
  const result = run('--estimate', 'nope');
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '未知の id: nope\n');
  assert.equal(result.stdout, '');
}));
test('CLI: 引数なしは3行でexit 0', () => withCli(({ run }) => {
  const result = run();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `パッケージ 5件 / オプション 3件\n1人日単価: 80,000 円 (assumed)\n${catalog.priceStatusNote}\n`);
  assert.equal(result.stderr, '');
}));
test('CLI: --write はdocsディレクトリを再作成しUTF-8で生成', () => withCli(({ dir, doc, run }) => {
  fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true });
  const result = run('--write');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '生成: docs/ai-advisory-service-packages.md\n');
  assert.equal(result.stderr, '');
  assert.equal(fs.readFileSync(doc, 'utf8'), render(catalog));
  assert.equal(run('--check').status, 0);
}));
test('CLI: 不正引数は使い方を出してexit 2', () => withCli(({ run }) => {
  for (const args of [['--unknown'], ['--estimate'], ['--estimate', ''], ['--estimate', '--check'], ['--write', '--check'], ['--estimate', 'assessment', 'extra-online']]) {
    const result = run(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stderr, usage);
    assert.equal(result.stdout, '');
  }
}));
test('CLI: 単一見積は「ほか」を付けない', () => withCli(({ run }) => {
  const result = run('--estimate', 'assessment');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.split('\n')[0], '見積: AI活用診断（1day）');
}));
test('estimate: 空配列・重複idも入力順の明細として扱う', () => {
  assert.deepEqual(estimate(catalog, []), { lines: [], totalDays: 0, totalYen: 0 });
  const result = estimate(catalog, ['assessment', 'assessment']);
  assert.equal(result.lines.length, 2);
  assert.equal(result.totalYen, 160000);
});
test('estimate: 円未満は明細ごとに切り捨てて合算', () => {
  const copy = structuredClone(catalog);
  copy.dayRateYen = 101;
  const result = estimate(copy, ['extra-onsite', 'extra-onsite']);
  assert.equal(result.totalDays, 1);
  assert.equal(result.totalYen, 100);
});
test('mainは関数としてexportされる', () => assert.equal(typeof main, 'function'));
test('実リポジトリの生成docにdriftがない', () => assert.equal(fs.readFileSync(docUrl, 'utf8').replace(/\r\n/g, '\n'), render(catalog)));
