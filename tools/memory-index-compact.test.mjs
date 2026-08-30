import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertInvariants, assertMoveInvariants, cleanupOldBackups, compactMemory, extractHookSet, extractLinkSet, extractTitleSet, moveHooks, run } from './memory-index-compact.mjs';

function fixture(index, bodies) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-'));
  const file = path.join(directory, 'MEMORY.md');
  fs.writeFileSync(file, index);
  for (const [name, content] of Object.entries(bodies)) fs.writeFileSync(path.join(directory, name), content);
  return { directory, file };
}

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

test('move-hooks: hook を本文へ追記し、索引のリンクとタイトルを保つ', () => {
  const item = fixture('- [Project: Alpha](alpha.md) — 大事な要約\n', { 'alpha.md': '---\nname: alpha\n---\n\n# Alpha\n' });
  const before = fs.readFileSync(item.file, 'utf8');
  const result = moveHooks(before, { directory: item.directory });
  fs.writeFileSync(item.file, result.text);
  for (const [file, body] of result.bodies) fs.writeFileSync(file, body);
  assert.equal(result.text, '- [Project: Alpha](alpha.md)\n');
  assert.match(fs.readFileSync(path.join(item.directory, 'alpha.md'), 'utf8'), /## 索引の要約\n- 大事な要約/);
  assert.deepEqual(extractTitleSet(result.text), extractTitleSet(before));
  assertMoveInvariants(before, fs.readFileSync(item.file, 'utf8'), result.records);
});

test('move-hooks: 正規化後の hook が既存なら本文を変更しない', () => {
  const body = '# Alpha\n\nこれは　既に\n転記済みです。\n';
  const item = fixture('- [Project: Alpha](alpha.md) — これは 既に 転記済みです。\n', { 'alpha.md': body });
  const result = moveHooks(fs.readFileSync(item.file, 'utf8'), { directory: item.directory });
  assert.equal(result.transferredCount, 1);
  assert.equal(result.bodies.get(path.join(item.directory, 'alpha.md')), body);
  assert.equal(Buffer.compare(Buffer.from(body), fs.readFileSync(path.join(item.directory, 'alpha.md'))), 0);
  assert.equal(result.text, '- [Project: Alpha](alpha.md)\n');
});

test('move-hooks: wikilink だけでも本文へ転記する', () => {
  const item = fixture('- [Project: Alpha](alpha.md) [[related_slug]]\n', { 'alpha.md': '# Alpha\n' });
  const result = moveHooks(fs.readFileSync(item.file, 'utf8'), { directory: item.directory });
  assert.match(result.bodies.get(path.join(item.directory, 'alpha.md')), /- \[\[related_slug\]\]/);
  assert.equal(result.text, '- [Project: Alpha](alpha.md)\n');
});

test('move-hooks: 1行の2エントリを個別に分解する', () => {
  const item = fixture('- [Project: A](a.md) — one ／ [Project: B](b.md) — two\n', { 'a.md': '# A\n', 'b.md': '# B\n' });
  const result = moveHooks(fs.readFileSync(item.file, 'utf8'), { directory: item.directory });
  assert.equal(result.entryCount, 2);
  assert.equal(result.records.length, 2);
  assert.equal(result.text, '- [Project: A](a.md) ／ [Project: B](b.md)\n');
});

test('move-hooks: リンク先が無ければエントリ名付きで throw する', () => {
  const item = fixture('- [Project: Missing](missing.md) — hook\n', {});
  assert.throws(() => moveHooks(fs.readFileSync(item.file, 'utf8'), { directory: item.directory }), /Project: Missing.*missing\.md/);
});

test('move-hooks: --dry-run は索引と本文を1バイトも変更しない', () => {
  const item = fixture('- [Project: Alpha](alpha.md) — hook\n', { 'alpha.md': '# Alpha\n' });
  const indexBefore = fs.readFileSync(item.file);
  const bodyFile = path.join(item.directory, 'alpha.md');
  const bodyBefore = fs.readFileSync(bodyFile);
  run(['--move-hooks', '--dry-run', '--file', item.file]);
  assert.equal(Buffer.compare(indexBefore, fs.readFileSync(item.file)), 0);
  assert.equal(Buffer.compare(bodyBefore, fs.readFileSync(bodyFile)), 0);
});

test('move-hooks: 転記後の本文を壊すと read-back verify が失敗する', () => {
  const item = fixture('- [Project: Alpha](alpha.md) — full hook [[slug]]\n', { 'alpha.md': '# Alpha\n' });
  const before = fs.readFileSync(item.file, 'utf8');
  const result = moveHooks(before, { directory: item.directory });
  fs.writeFileSync(path.join(item.directory, 'alpha.md'), '# broken\n');
  assert.throws(() => assertMoveInvariants(before, result.text, result.records), { code: 'INVARIANT_FAILED' });
});

test('move-hooks: 追記0件かつ索引不変なら --apply でもバックアップを作らない', () => {
  const item = fixture('- [Project: Alpha](alpha.md)\n', { 'alpha.md': '# Alpha\n' });
  const before = fs.readFileSync(item.file);
  run(['--move-hooks', '--apply', '--file', item.file]);
  assert.equal(Buffer.compare(before, fs.readFileSync(item.file)), 0);
  assert.deepEqual(fs.readdirSync(item.directory).sort(), ['MEMORY.md', 'alpha.md']);
});

test('--min-bytes はしきい値以下のファイルを変更せずスキップする', () => {
  const item = fixture('- [Project: Alpha](alpha.md) — hook\n', { 'alpha.md': '# Alpha\n' });
  const indexBefore = fs.readFileSync(item.file);
  const bodyBefore = fs.readFileSync(path.join(item.directory, 'alpha.md'));
  run(['--move-hooks', '--apply', '--min-bytes', String(indexBefore.length), '--file', item.file]);
  assert.equal(Buffer.compare(indexBefore, fs.readFileSync(item.file)), 0);
  assert.equal(Buffer.compare(bodyBefore, fs.readFileSync(path.join(item.directory, 'alpha.md'))), 0);
  assert.deepEqual(fs.readdirSync(item.directory).sort(), ['MEMORY.md', 'alpha.md']);
});

test('v2 索引は変更せず正常にスキップする', () => {
  const input = '<!-- MEMORY-INDEX v2 split -->\n- [Pin](alpha.md)\n';
  const item = fixture(input, { 'alpha.md': '# Alpha\n' });
  const result = run(['--apply', '--file', item.file]);
  assert.equal(result.reason, 'v2-index');
  assert.equal(fs.readFileSync(item.file, 'utf8'), input);
  assert.deepEqual(fs.readdirSync(item.directory).sort(), ['MEMORY.md', 'alpha.md']);
});

test('--all-projects は複数の MEMORY.md を処理する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-home-'));
  const projects = path.join(home, '.claude', 'projects');
  for (const name of ['one', 'two']) {
    const memory = path.join(projects, name, 'memory');
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'MEMORY.md'), `- [Project: ${name}](${name}.md) — hook ${name}\n`);
    fs.writeFileSync(path.join(memory, `${name}.md`), `# ${name}\n`);
  }
  // os.homedir() は Windows では USERPROFILE を見るので、HOME だけ差し替えると
  // 実ホームの MEMORY.md を --apply してしまう。両方を一時ホームへ向ける。
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./memory-index-compact.mjs', import.meta.url)), '--move-hooks', '--apply', '--all-projects'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(child.status, 0, child.stderr);
  for (const name of ['one', 'two']) {
    assert.equal(fs.readFileSync(path.join(projects, name, 'memory', 'MEMORY.md'), 'utf8'), `- [Project: ${name}](${name}.md)\n`);
    assert.match(fs.readFileSync(path.join(projects, name, 'memory', `${name}.md`), 'utf8'), new RegExp(`hook ${name}`));
  }
});

test('--file と --all-projects の同時指定を拒否する', () => {
  const item = fixture('- [Project: Alpha](alpha.md)\n', { 'alpha.md': '# Alpha\n' });
  assert.throws(() => run(['--move-hooks', '--apply', '--file', item.file, '--all-projects']), /同時に指定できません/);
});

test('14日より古いバックアップだけを削除する', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cleanup-'));
  const oldFile = path.join(directory, 'MEMORY.md.bak-old');
  const newFile = path.join(directory, 'MEMORY.md.bak-new');
  const oldDirectory = path.join(directory, '.memory-body-backup-old');
  const newDirectory = path.join(directory, '.memory-body-backup-new');
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(newFile, 'new');
  fs.mkdirSync(oldDirectory);
  fs.mkdirSync(newDirectory);
  const now = Date.now();
  const old = new Date(now - 15 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, old, old);
  fs.utimesSync(oldDirectory, old, old);
  assert.equal(cleanupOldBackups(directory, { now }), 2);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(oldDirectory), false);
  assert.equal(fs.existsSync(newFile), true);
  assert.equal(fs.existsSync(newDirectory), true);
});

test('--dry-run では古いバックアップを掃除しない', () => {
  const item = fixture('- [Project: Alpha](alpha.md) — hook\n', { 'alpha.md': '# Alpha\n' });
  const oldBackup = path.join(item.directory, 'MEMORY.md.bak-old');
  fs.writeFileSync(oldBackup, 'old');
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldBackup, old, old);
  run(['--move-hooks', '--dry-run', '--file', item.file]);
  assert.equal(fs.existsSync(oldBackup), true);
});
