// -Dry は「表示のみ」を名乗る以上、副作用を1つも起こしてはならない。
// かつては Post しか抑止しておらず、検証のつもりの -Dry が runId を消費し
// タスクを本当に実行していた(2026-09-15 実測: thermal-guard-rollout-2026-09-14 を消費)。
// 同じ退行を二度と通さないため、副作用を持つ呼び出しが $Dry ガードの下にあることを固定する。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, 'fleet-poller.ps1'), 'utf8');

/** 指定文字列の直前 range 文字以内に $Dry ガードがあることを確かめる */
function guardedByDry(needle, range = 400) {
  const at = src.indexOf(needle);
  assert.ok(at > 0, `想定の呼び出しが見つからない: ${needle}`);
  const before = src.slice(Math.max(0, at - range), at);
  return /if \(\$Dry\)/.test(before);
}

test('-Dry は runId を消費しない(処理済み記録を書かない)', () => {
  assert.match(src, /if \(\$Dry\) \{ DrySkip "runId=\$runId の処理済み記録" \} else \{ Add-Content -Path \$procF -Value \$runId \}/);
});

test('-Dry は中央キューのタスク本体を実行しない', () => {
  assert.ok(guardedByDry('$res = & $WL[$task]'), 'タスク実行が $Dry ガードの外にある');
});

test('-Dry はスケジュールタスクを登録しない', () => {
  for (const installer of ['$fleetAgentInstaller *> $null', '$backupTaskInstaller *> $null', '$thermalGuard -Install *> $null']) {
    assert.ok(guardedByDry(installer), `自己修復の登録が $Dry ガードの外にある: ${installer}`);
  }
});

test('-Dry は PC管理表へ書き込まない', () => {
  assert.ok(guardedByDry("'tools\\fleet-sheet-report.mjs') '--specs' '--cloud'"), 'シート書き込みが $Dry ガードの外にある');
});

test('-Dry は設定ファイルの BOM を書き戻さない / 日次ガードを更新しない', () => {
  assert.ok(guardedByDry('[System.IO.File]::WriteAllText($bf'), 'BOM書き戻しが $Dry ガードの外にある');
  assert.ok(guardedByDry('Set-Content -Path $g -Value'), '日次ガード更新が $Dry ガードの外にある');
});
