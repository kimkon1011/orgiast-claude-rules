import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// gh-login-oneclick.ps1 は「kim の1クリック」で未push枝を着地させる唯一の経路なので、
// 一覧に書き忘れた枝を取りこぼすと成果が永久に着地しない（2026-10-22 に実際に起きた）。
// PowerShell を実行せずに、その保証が構造として残っていることだけを固定する。
const src = fs.readFileSync(path.join(import.meta.dirname, 'gh-login-oneclick.ps1'), 'utf8');

test('自動追加は前回実行時刻を基準にする（過去の枝を一斉 push しない）', () => {
  assert.match(src, /gh-login-oneclick\.state\.json/);
  assert.match(src, /lastRunUnix/);
  assert.match(src, /if \(\$sinceUnix -le 0\)/);
  // 初回は「何も追加しない」と明示していること
  assert.match(src, /初回のため一覧に無い枝の自動追加は行いません/);
});

test('自動追加の対象は auto/ 枝だけで、rescue/ や他の枝を巻き込まない', () => {
  assert.match(src, /for-each-ref refs\/heads\/auto/);
  assert.doesNotMatch(src, /for-each-ref refs\/heads\/rescue/);
  assert.doesNotMatch(src, /for-each-ref refs\/heads\/ /);
});

test('origin に既にある枝と一覧に既にある枝は二重に積まない', () => {
  assert.match(src, /\$seenBranch\.ContainsKey\(\$b\)/);
  assert.match(src, /\$remoteSet\.ContainsKey\(\$b\)/);
  assert.match(src, /ls-remote --heads origin 'refs\/heads\/auto\/\*'/);
});

test('main と同じ内容の枝は着地対象にしない', () => {
  assert.match(src, /git -C \$root diff --quiet "origin\/main\.\.\$b"/);
});

test('基準時刻は実行開始時に取り、完了時に書き戻す', () => {
  const startIdx = src.indexOf('$runStartedUnix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()');
  const useIdx = src.indexOf('$stateFile');
  const writeIdx = src.indexOf('lastRunUnix = $runStartedUnix');
  assert.ok(startIdx > 0, 'runStartedUnix の定義が無い');
  assert.ok(useIdx > 0, 'stateFile の定義が無い');
  assert.ok(writeIdx > 0, '基準時刻の書き戻しが無い');
  assert.ok(writeIdx > startIdx, '書き戻しは定義より後にあること');
});

test('一覧の行は <repo パス>|<ブランチ名> の2要素だけを対象にする', () => {
  assert.match(src, /\$parts\.Count -lt 2/);
  assert.match(src, /SKIP \(書式不正\)/);
});
