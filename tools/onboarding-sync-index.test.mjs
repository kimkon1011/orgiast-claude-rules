// 索引生成の回帰テスト。
// 実文書の絶対ルールは `**🛑 上限（この原則より優先・絶対）**: …` のように強調記号が絵文字の前に来る。
// 旧実装は行頭パターンを `**🔴` だけ許容していたため、実データで 🛑/⚙️/🔁 の3種が索引から落ちていた
// (実測: 5行中1行しか残らなかった)。既存テストは裸の `🔴 …` 形式しか再現しておらず検出できなかった。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'onboarding-sync.mjs');

const MARKS = ['🔴', '🛑', '⚙️', '🔁'];
const bodyLines = [
  '# 見出し',
  '最初の文。捨てられる二番目。',
  '**🔴 最上位原則: ユーザーの手作業を極限まで減らす**: 本文',
  '**🛑 上限（この原則より優先・絶対）**: 本文',
  '## 次の節',
  '**⚙️ 設計時点から手間ゼロを織り込む**: 本文',
  '**🔁 配布物は貼り替え不要にする**: 本文',
];

function runWith(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-index-'));
  const target = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const url = `data:text/markdown;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
  const result = spawnSync(process.execPath, [script, '--force', `--target=${target}`], {
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_ONBOARDING_URL: url, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_REPO: path.join(home, 'absent') },
  });
  return { result, home, target };
}

test('索引は強調記号付きの絶対ルール行(**🛑 など)を落とさない', () => {
  const { result, target } = runWith(bodyLines.join('\r\n'));
  assert.equal(result.status, 0, result.stderr);
  const output = fs.readFileSync(target, 'utf8');
  for (const mark of MARKS) assert.ok(output.includes(mark), `${mark} の絶対ルール行が索引から落ちている`);
  assert.ok(!output.includes('捨てられる二番目'), '見出し直後の1文目以降まで残っている');
});

test('ラベル形式が日付でない既存マーカーでも置換され、ブロックが二重にならない', () => {
  // 日付形式に固定すると、別形式で導入されたPCで置換に失敗し末尾追記になってブロックが二重化する。
  const before = '個人ルール\r\n<!-- BEGIN: オージャスト共通ルール (手動 v3) -->\r\n旧本文\r\n<!-- END: オージャスト共通ルール -->\r\n末尾\r\n';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-index-marker-'));
  const target = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, before);
  const url = `data:text/markdown;base64,${Buffer.from(bodyLines.join('\r\n'), 'utf8').toString('base64')}`;
  const result = spawnSync(process.execPath, [script, '--force', `--target=${target}`], {
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_ONBOARDING_URL: url, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_REPO: path.join(home, 'absent') },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = fs.readFileSync(target, 'utf8');
  assert.equal(output.match(/<!-- BEGIN: オージャスト共通ルール/g).length, 1, 'ブロックが二重になっている');
  assert.ok(!output.includes('旧本文'), '旧ブロックが置換されていない');
  assert.ok(output.startsWith('個人ルール'), 'マーカー外の個人ルールが失われた');
  assert.ok(output.includes('末尾'), 'マーカー外の末尾が失われた');
});
