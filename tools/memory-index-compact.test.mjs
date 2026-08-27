import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertInvariants, compactMemory, extractHookSet, extractLinkSet, extractTitleSet } from './memory-index-compact.mjs';

test('各エントリのタイトル、hook、既存リンクを保ったまま全角スラッシュで畳む', () => {
  const input = '- [User: オージャスト経営者](user_role.md) — 100億円計画\n- [User: スマホは Galaxy S24 Ultra](user_smartphone.md) [[phone-note]] — iOS前提ガイド禁止\n';
  const result = compactMemory(input);
  assert.equal(result.text, '- [User: オージャスト経営者](user_role.md) — 100億円計画 ／ [User: スマホは Galaxy S24 Ultra](user_smartphone.md) [[phone-note]] — iOS前提ガイド禁止\n');
  assert.deepEqual(extractLinkSet(result.text), extractLinkSet(input));
  assert.deepEqual(extractTitleSet(result.text), extractTitleSet(input));
  assert.deepEqual(extractHookSet(result.text), extractHookSet(input));
});

test('hook がないエントリには区切りを補わない', () => {
  const input = '- [Project: Alpha](alpha.md)\n- [Project: Beta](beta.md) — beta hook\n';
  assert.equal(compactMemory(input).text, '- [Project: Alpha](alpha.md) ／ [Project: Beta](beta.md) — beta hook\n');
});

test('hook 内の全角スラッシュをエントリ境界と誤認しない', () => {
  const input = '- [Project: Alpha](alpha.md) — 営業 ／ 制作\n- [Project: Beta](beta.md) — beta hook\n';
  const result = compactMemory(input);
  assert.deepEqual(extractHookSet(result.text), extractHookSet(input));
});

test('連結後が240文字を超えるペアは畳まない', () => {
  const input = `- [Project: Alpha](alpha.md) — ${'a'.repeat(100)}\n- [Project: Beta](beta.md) — ${'b'.repeat(100)}\n`;
  const result = compactMemory(input);
  assert.equal(result.text, input);
  assert.equal(result.notCompacted.over240Characters, 1);
});

test('3エントリ連続でも先頭2件だけを畳む', () => {
  const input = '- [Project: A](a.md) — one\n- [Project: B](b.md) — two\n- [Project: C](c.md) — three\n';
  const result = compactMemory(input);
  assert.equal(result.text, '- [Project: A](a.md) — one ／ [Project: B](b.md) — two\n- [Project: C](c.md) — three\n');
  assert.equal(result.after.lines, 2);
});

test('空行をまたいで別セクションのエントリを畳まない', () => {
  const input = '- [Project: A](a.md) — one\n\n- [Project: B](b.md) — two\n';
  const result = compactMemory(input);
  assert.equal(result.text, input);
  assert.equal(result.notCompacted.differentSection, 1);
});

test('3不変条件のいずれかを壊した候補は拒否する', () => {
  const before = '- [Reference: Discord ID](discord.md) [[extra]] — 715210673642012733\n';
  assert.throws(() => assertInvariants(before, '- [Reference: ID](discord.md)\n'), { code: 'INVARIANT_FAILED' });
});

test('不変条件違反はプロセスの exit 1 になる', () => {
  const script = `import { assertInvariants } from ${JSON.stringify(new URL('./memory-index-compact.mjs', import.meta.url).href)}; assertInvariants('- [User: A](a.md) — hook\\n', '- [User: B](a.md)\\n');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /不変条件が壊れました/);
});

test('目標未達でも内容を削らず正常終了相当の結果を返す', () => {
  const input = '# MEMORY\n\n- [Project: A](a.md) — one\n';
  const result = compactMemory(input, { target: 1 });
  assert.equal(result.targetReached, false);
  assert.equal(result.text, input);
});
