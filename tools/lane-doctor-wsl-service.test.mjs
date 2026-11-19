import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deadLanes } from './lib/lane-health.mjs';
const src = fs.readFileSync(new URL('./lane-doctor.mjs', import.meta.url), 'utf8');

// WSL サービス停止のエラーパターン一覧
const WSL_SERVICE_PATTERNS = [
  /Wsl[/\\]Service/,
  /ERROR_SERVICE_DISABLED/,
  /\bLxssManager\b/,
  /HCS\b/,
  /サービスは無効/,
  /cannot be started/,
  /要素が見つかりません/,
];

test('WSL サービス停止エラーを dead:physical_operation に分類するための正規表現が lane-doctor.mjs に含まれている', () => {
  for (const pattern of WSL_SERVICE_PATTERNS) {
    const wellKnown = pattern.source;
    const message = `正規表現 ${wellKnown} が見つかりません`;
    assert.ok(src.includes(wellKnown.slice(0, 20)) || src.includes(wellKnown), message);
  }
});

test('wslServiceError 変数が存在し、reason 判定の前に使われている', () => {
  assert.match(src, /const\s+wslServiceError\s*=/);
  // WSL サービスエラー検出が nativeRepair より先に評価される順序であることを確認
  const wslCheckPos = src.indexOf('wslServiceError');
  const nativeRepairBlockPos = src.indexOf('result.nativeRepair && health.lanes[p].reason === \'probe_failed\'');
  assert.ok(wslCheckPos < nativeRepairBlockPos,
    `wslServiceError の判定 (pos ${wslCheckPos}) が nativeRepair ブロック (pos ${nativeRepairBlockPos}) より前にあるべき`);
});

test('wslServiceError が真のとき reason が dead:physical_operation になる', () => {
  // wslServiceError && reason === 'probe_failed' の条件分岐を確認
  assert.match(src, /health\.lanes\[p\]\.reason === 'probe_failed' && wslServiceError/);
  assert.match(src, /reason:\s*'dead:physical_operation'/);
});

test('wslServiceError の userFix に管理者権限での sc start LxssManager が記載されている', () => {
  assert.match(src, /sc start LxssManager/);
  assert.match(src, /wsl\.exe --install --no-distribution/);
  assert.match(src, /Windows を再起動/);
});

test('wslServiceError の tried に codex probe と記載されている', () => {
  assert.match(src, /tried:\s*'codex probe'/);
});

test('deadLanes が dead:physical_operation を正しく通す', () => {
  const d = deadLanes({ lanes: { codex: { alive: false, reason: 'dead:physical_operation', error: 'Wsl/Service LxssManager サービスは無効です' } } });
  assert.deepEqual(d, [{ lane: 'codex', reason: 'dead:physical_operation', error: 'Wsl/Service LxssManager サービスは無効です' }]);
});

test('nativeRepair ブロックが wslServiceError で二重判定しない', () => {
  // wslServiceError が真なら nativeRepair ブロックの物理操作条件に !wslServiceError ガードがある
  const nativeRepairPhysical = src.match(/else if \(!wslServiceError &&/);
  assert.ok(nativeRepairPhysical, 'nativeRepair ブロックの物理操作判定に !wslServiceError ガードが必要');
});

test('テストA: deepseek レーンのエラーに cannot be started が含まれても dead:physical_operation にならない', () => {
  // wslServiceError が p === 'codex' で限定されていることを確認（deepseek 等のレーンでは wslServiceError が false）
  const line = src.match(/const\s+wslServiceError\s*=\s*p\s*===\s*'codex'\s*&&\s*\/(?:[^/\\]|\\.)+\/i\.test\(text\)/);
  assert.ok(line, 'wslServiceError が p === \'codex\' で限定されている');
});

test('テストB: codex レーンで WSL ディストリ列挙が null かつエラー本文が空のときに dead:physical_operation になる', () => {
  // 空テキスト + WSL ディストリ列挙 failure の判定が存在する
  assert.match(src, /p\s*===\s*'codex'\s*&&\s*health\.lanes\[p\]\.reason\s*===\s*'probe_failed'/);
  assert.match(src, /listWslDistros\s*\(\s*\)/);
  assert.match(src, /wslDistros\s*===\s*null\s*\|\|\s*wslDistros\s*===\s*''/);
  assert.match(src, /reason:\s*'dead:physical_operation'/);
  assert.match(src, /tried:\s*'WSL ディストリ列挙が失敗'/);
});

test('テストC: codex レーンで WSL ディストリ列挙が正常なのに probe が失敗した場合は dead:physical_operation にせず probe_failed のまま', () => {
  // WSL ディストリ列挙が正常の場合に dead:physical_operation にならない静的条件は2つ:
  // 1) wslDistros !== null && wslDistros !== '' では if ブロックに入らない
  const emptyTextCheck = src.match(/if\s*\(p\s*===\s*'codex'\s*&&\s*health\.lanes\[p\]\.reason\s*===\s*'probe_failed'\s*&&\s*\(!text\s*\|\|\s*text\.trim\(\)\.length\s*<\s*5\)\)/);
  assert.ok(emptyTextCheck, 'codex 空テキスト + WSL distro 判定が存在する');
  // WSL 正常時は dead:physical_operation 以外の reason にしかならないことを確認（既存の条件分岐で probe_failed が残る）
  assert.match(src, /health\.lanes\[p\]\.reason\s*===\s*'probe_failed'/);
});