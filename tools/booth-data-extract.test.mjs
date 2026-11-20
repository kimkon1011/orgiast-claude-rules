// booth-data-extract.test.mjs — X-0093 抽出ツールのユニットテスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, getFieldNamesFromSchema, extractFields, parseInput, evaluateFilter } from './booth-data-extract.mjs';

describe('parseArgs', () => {
  it('デフォルト値をパースする', () => {
    const opts = parseArgs([]);
    assert(!opts.input);
    assert(!opts.schema);
    assert(!opts.filter);
  });

  it('--input をパースする', () => {
    const opts = parseArgs(['--input', 'data.json', '--schema', 'booth']);
    assert.strictEqual(opts.input, 'data.json');
    assert.strictEqual(opts.schema, 'booth');
  });

  it('--fields をパースする', () => {
    const opts = parseArgs(['--fields', 'boothId,width,depth']);
    assert.strictEqual(opts.fields, 'boothId,width,depth');
  });

  it('--filter をパースする', () => {
    const opts = parseArgs(['--filter', 'boothType=="島ブース"']);
    assert.strictEqual(opts.filter, 'boothType=="島ブース"');
  });

  it('--out をパースする', () => {
    const opts = parseArgs(['--out', 'extracted.json']);
    assert.strictEqual(opts.out, 'extracted.json');
  });

  it('--help をパースする', () => {
    const opts = parseArgs(['--help']);
    assert(opts.help);
  });
});

describe('getFieldNamesFromSchema', () => {
  const testSchemas = {
    schemas: {
      test_booth: {
        fields: {
          boothId: { type: 'string' },
          width: { type: 'number' },
          cost: { type: 'number', optional: true },
        }
      }
    }
  };

  it('スキーマからフィールド名一覧を返す', () => {
    const names = getFieldNamesFromSchema('test_booth', testSchemas);
    assert.strictEqual(names.length, 3);
    assert(names.includes('boothId'));
    assert(names.includes('width'));
    assert(names.includes('cost'));
  });

  it('存在しないスキーマは空配列を返す', () => {
    const names = getFieldNamesFromSchema('nonexistent', testSchemas);
    assert.strictEqual(names.length, 0);
  });
});

describe('extractFields', () => {
  it('指定フィールドだけを抽出する', () => {
    const record = { boothId: 'B001', width: 6, depth: 3, cost: 500000, notes: '備考' };
    const result = extractFields(record, ['boothId', 'width', 'depth']);
    assert.strictEqual(Object.keys(result).length, 3);
    assert.strictEqual(result.boothId, 'B001');
    assert.strictEqual(result.width, 6);
    assert.strictEqual(result.depth, 3);
    assert(!('cost' in result));
    assert(!('notes' in result));
  });

  it('存在しないフィールドはスキップする', () => {
    const record = { boothId: 'B001' };
    const result = extractFields(record, ['boothId', 'nonexistent']);
    assert.strictEqual(Object.keys(result).length, 1);
    assert.strictEqual(result.boothId, 'B001');
  });

  it('空のレコードを処理する', () => {
    const record = {};
    const result = extractFields(record, ['boothId']);
    assert.strictEqual(Object.keys(result).length, 0);
  });
});

describe('parseInput', () => {
  it('JSON配列をパースする', () => {
    const input = '[{"boothId":"B001"},{"boothId":"B002"}]';
    const records = parseInput(input);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].boothId, 'B001');
    assert.strictEqual(records[1].boothId, 'B002');
  });

  it('valuesキーを含むオブジェクトをパースする', () => {
    const input = '{"values":[{"boothId":"B001"},{"boothId":"B002"}]}';
    const records = parseInput(input);
    assert.strictEqual(records.length, 2);
  });

  it('単一オブジェクトを配列にラップする', () => {
    const input = '{"boothId":"B001","width":6}';
    const records = parseInput(input);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].boothId, 'B001');
  });

  it('改行区切りJSONをパースする', () => {
    const input = '{"boothId":"B001"}\n{"boothId":"B002"}\n';
    const records = parseInput(input);
    assert.strictEqual(records.length, 2);
  });

  it('空文字列は空配列を返す', () => {
    assert.strictEqual(parseInput('').length, 0);
    assert.strictEqual(parseInput('   ').length, 0);
  });

  it('複数の配列キーを試行する', () => {
    const input = '{"results":[{"id":1},{"id":2}]}';
    const records = parseInput(input);
    assert.strictEqual(records.length, 2);
  });
});

describe('evaluateFilter', () => {
  it('== フィルターで一致するレコードを通す', () => {
    assert(evaluateFilter({ boothType: '島ブース' }, 'boothType=="島ブース"'));
  });

  it('== フィルターで不一致のレコードを通さない', () => {
    assert(!evaluateFilter({ boothType: '壁面ブース' }, 'boothType=="島ブース"'));
  });

  it('!== フィルター', () => {
    assert(evaluateFilter({ boothType: '壁面ブース' }, 'boothType!=="島ブース"'));
    assert(!evaluateFilter({ boothType: '島ブース' }, 'boothType!=="島ブース"'));
  });

  it('> フィルター（数値比較）', () => {
    assert(evaluateFilter({ cost: 600000 }, 'cost>500000'));
    assert(!evaluateFilter({ cost: 400000 }, 'cost>500000'));
  });

  it('< フィルター（数値比較）', () => {
    assert(evaluateFilter({ cost: 400000 }, 'cost<500000'));
    assert(!evaluateFilter({ cost: 600000 }, 'cost<500000'));
  });

  it('空フィルターはすべて通過させる', () => {
    assert(evaluateFilter({ boothId: 'B001' }, ''));
    assert(evaluateFilter({}, ''));
  });

  it('不明なフィルター形式は通過させる', () => {
    assert(evaluateFilter({ boothId: 'B001' }, 'weird==format'));
  });
});

describe('実データエッジケース', () => {
  it('materials配列を保持する', () => {
    const record = { boothId: 'B001', materials: ['アルミフレーム', 'アクリルパネル', 'LED'] };
    const result = extractFields(record, ['boothId', 'materials']);
    assert.strictEqual(result.boothId, 'B001');
    assert(Array.isArray(result.materials));
    assert.strictEqual(result.materials.length, 3);
    assert.strictEqual(result.materials[0], 'アルミフレーム');
  });

  it('欠損フィールドがあるレコードでエラーにならない', () => {
    const record = { boothId: 'B001' };
    const result = extractFields(record, ['boothId', 'width', 'cost']);
    assert.strictEqual(Object.keys(result).length, 1);
    assert.strictEqual(result.boothId, 'B001');
  });

  it('値を文字列として比較する == フィルター', () => {
    assert(evaluateFilter({ boothId: '261121KNM' }, 'boothId=="261121KNM"'));
  });
});