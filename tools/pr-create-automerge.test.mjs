import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const EXCEPTIONS = {
  'stall-sweeper.mjs': '停滞作業の退避 PR は人のレビュー前提（本文に明記）',
  'gas-master-sync.mjs': '別リポジトリ（BOOTH_REPO）宛てで auto-merge.yml が無い',
};

test('tools の PR 作成経路には automerge ラベルまたは理由付き例外がある', () => {
  const toolsDir = new URL('./', import.meta.url);
  const violations = [];
  for (const file of readdirSync(toolsDir).sort()) {
    if (!file.endsWith('.mjs') || file.endsWith('.test.mjs')) continue;
    // コメントは同じ長さの空白に置換して、行番号と空行境界を保持する。
    const source = readFileSync(new URL(file, toolsDir), 'utf8')
      .replace(/^[\t ]*\/\/[^\r\n]*/gm, (line) => ' '.repeat(line.length));
    const calls = /\[\s*(['"])pr\1\s*,\s*(['"])create\2|\bgh\s+pr\s+create\b/g;
    for (const match of source.matchAll(calls)) {
      if (EXCEPTIONS[file]) continue;
      // 配列を定義した直後にラベルを追加する経路も、次の空行まで検査する。
      const statement = source.slice(match.index).split(/\r?\n[\t ]*\r?\n/, 1)[0];
      if (statement.includes('automerge')) continue;
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${line}: --label automerge を付けるか、理由付きで例外リストに追加する`);
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});
