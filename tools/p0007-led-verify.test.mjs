import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = join(__dirname, 'p0007-led-verify.mjs');

/**
 * ツールを実行して stdout を返す
 */
function run(...args) {
  const r = spawnSync('node', [TOOL_PATH, ...args], { encoding: 'utf-8' });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status };
}

describe('P-0007 LED事前設置 検証支援ツール', () => {

  it('--help で使用方法を表示する', () => {
    const r = run('--help');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /使用方法/);
  });

  it('--plan で検証計画書を出力する', () => {
    const r = run('--plan');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /P-0007 LED事前設置 効果検証計画書/);
    assert.match(r.stdout, /事前準備（オフサイト）/);
    assert.match(r.stdout, /当日設営/);
  });

  it('--plan でパネル枚数を指定できる', () => {
    const r = run('--plan', '12');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /12枚/);
    assert.match(r.stdout, /12枚×/);
  });

  it('--checklist でチェックリストを出力する', () => {
    const r = run('--checklist');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /検証チェックリスト/);
    assert.match(r.stdout, /事前準備（オフサイト）/);
    assert.match(r.stdout, /当日設営/);
    assert.match(r.stdout, /検証後/);
  });

  it('--estimate で時間見積もりを出力する', () => {
    const r = run('--estimate', '6');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /時間見積もり/);
    assert.match(r.stdout, /6枚/);
    assert.match(r.stdout, /削減時間/);
    assert.match(r.stdout, /目標30分達成/);
  });

  it('--estimate の既定は6枚', () => {
    const r = run('--estimate');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /6枚/);
  });

  it('--estimate でパネル枚数1枚でも30分以上削減できる', () => {
    const r = run('--estimate', '1');
    assert.equal(r.status, 0);
    // 1枚でも基準時間47分に対し事前配線あり15分で32分削減
    assert.match(r.stdout, /✅/);
  });

  it('--estimate で30分以上のケースが検出できる（12枚）', () => {
    const r = run('--estimate', '12');
    assert.equal(r.status, 0);
    // 12枚なら30分以上削減できるはず
    assert.match(r.stdout, /✅/);
  });

  it('--report で報告テンプレートを出力する', () => {
    const r = run('--report');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /検証結果報告/);
    assert.match(r.stdout, /計測結果/);
  });

  it('--all ですべてを出力する', () => {
    const r = run('--all');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /P-0007 LED事前設置 効果検証計画書/);
    assert.match(r.stdout, /検証チェックリスト/);
    assert.match(r.stdout, /検証結果報告/);
  });

  it('存在しないオプションはエラー終了する', () => {
    const r = run('--invalid');
    assert.equal(r.status, 1);
  });

  it('見積もり計算の値が正しい（6枚）', () => {
    const r = run('--estimate', '6');
    assert.equal(r.status, 0);
    // 削減時間が正の値であることを確認
    const match = r.stdout.match(/削減時間\s*\|\s*(\d+)分/);
    assert.ok(match, '削減時間の行が見つかりません');
    const savings = parseInt(match[1], 10);
    assert.ok(savings > 0, `削減時間が正の値ではありません: ${savings}`);
  });
});