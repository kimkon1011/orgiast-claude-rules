import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from './memory-index-split.mjs';
import { verify } from './memory-index-split-verify.mjs';

const splitScript = fileURLToPath(new URL('./memory-index-split.mjs', import.meta.url));
const verifyScript = fileURLToPath(new URL('./memory-index-split-verify.mjs', import.meta.url));

function fixture({ memory = '# MEMORY\n', files = {}, domains = {}, pins } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-split-'));
  fs.writeFileSync(path.join(directory, 'MEMORY.md'), memory);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  const domainsFile = path.join(directory, 'domains.json');
  fs.writeFileSync(domainsFile, JSON.stringify(domains));
  let pinsFile;
  if (pins !== undefined) {
    pinsFile = path.join(directory, 'pins.txt');
    fs.writeFileSync(pinsFile, pins);
  }
  return { directory, domainsFile, pinsFile };
}

function args(item, mode = '--apply') {
  return ['--dir', item.directory, '--domains', item.domainsFile, ...(item.pinsFile ? ['--pins', item.pinsFile] : []), mode];
}

function generatedSnapshot(directory) {
  const result = new Map([['MEMORY.md', fs.readFileSync(path.join(directory, 'MEMORY.md'))]]);
  for (const name of fs.readdirSync(path.join(directory, 'index')).sort()) result.set(`index/${name}`, fs.readFileSync(path.join(directory, 'index', name)));
  return result;
}

test('生成して独立 verify が通り、2回目は1バイトも変わらない', () => {
  const item = fixture({
    memory: '- [手修正タイトル](feedback_alpha.md)\n',
    files: {
      'feedback_alpha.md': '---\nname: alpha\ndescription: alpha description\n---\n',
      'project_beta.md': '---\nname: beta\ndescription: beta description\n---\n',
    },
    domains: { 'feedback_alpha.md': 'verify', 'project_beta.md': 'apps' },
    pins: 'feedback_alpha.md\n',
  });
  const first = run(args(item));
  assert.equal(first.changed, true);
  assert.deepEqual(verify(item.directory).problems, []);
  const before = generatedSnapshot(item.directory);
  const second = run(args(item));
  assert.equal(second.changed, false);
  const after = generatedSnapshot(item.directory);
  assert.deepEqual(after, before);
});

test('未分類があると書き込み前に停止し MEMORY.md を維持する', () => {
  const original = '# untouched\n';
  const item = fixture({ memory: original, files: { 'feedback_missing.md': '---\ndescription: missing\n---\n' }, domains: {} });
  assert.throws(() => run(args(item)), /未分類.*feedback_missing\.md/s);
  assert.equal(fs.readFileSync(path.join(item.directory, 'MEMORY.md'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(item.directory, 'index')), false);
});

test('タイトルは既存 MEMORY、既存サブ索引、description の優先順で決める', () => {
  const item = fixture({
    memory: '- [MEMORYのタイトル](feedback_one.md)\n',
    files: {
      'feedback_one.md': '---\ndescription: 説明一\n---\n',
      'feedback_two.md': '---\ndescription: 説明二\n---\n',
      'feedback_three.md': '---\ndescription: 新規の説明です。後半はタイトルに不要\n---\n',
    },
    domains: { 'feedback_one.md': 'infra', 'feedback_two.md': 'infra', 'feedback_three.md': 'infra' },
  });
  fs.mkdirSync(path.join(item.directory, 'index'));
  fs.writeFileSync(path.join(item.directory, 'index', 'infra.md'), '- [手修正したサブ索引タイトル](../feedback_two.md)\n');
  run(args(item));
  const index = fs.readFileSync(path.join(item.directory, 'index', 'infra.md'), 'utf8');
  assert.match(index, /\[MEMORYのタイトル\]\(\.\.\/feedback_one\.md\)/);
  assert.match(index, /\[手修正したサブ索引タイトル\]\(\.\.\/feedback_two\.md\)/);
  assert.match(index, /\[新規の説明です。\]\(\.\.\/feedback_three\.md\)/);
});

test('--backups は別ディレクトリでも新しいバックアップのタイトルを使う', () => {
  const item = fixture({
    files: { 'feedback_a.md': '---\ndescription: fallback\n---\n' },
    domains: { 'feedback_a.md': 'verify' },
  });
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-backups-'));
  fs.writeFileSync(path.join(backups, 'MEMORY.md.bak-20260101-000000'), '- [過去タイトル](feedback_a.md)\n');
  run([...args(item), '--backups', backups]);
  assert.match(fs.readFileSync(path.join(item.directory, 'index', 'verify.md'), 'utf8'), /\[過去タイトル\]/);
});

test('CRLF+BOM を MEMORY.md とサブ索引で維持する', () => {
  const item = fixture({
    memory: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# OLD\r\n')]),
    files: { 'feedback_alpha.md': '---\ndescription: Alpha\n---\n' },
    domains: { 'feedback_alpha.md': 'verify' },
  });
  run(args(item));
  for (const file of [path.join(item.directory, 'MEMORY.md'), path.join(item.directory, 'index', 'verify.md')]) {
    const content = fs.readFileSync(file);
    assert.deepEqual([...content.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const body = content.subarray(3).toString('utf8');
    assert.match(body, /\r\n/);
    assert.doesNotMatch(body.replaceAll('\r\n', ''), /\n/);
  }
});

test('独立 verify CLI が取りこぼし、重複、壊れリンクを個別に検出する', () => {
  const cases = [
    ['取りこぼし', '# V\n', /取りこぼし/],
    ['重複', '- [A](../feedback_a.md)\n- [A2](../feedback_a.md)\n', /重複/],
    ['壊れリンク', '- [A](../feedback_a.md)\n- [X](../missing.md)\n', /壊れリンク/],
  ];
  for (const [label, indexBody, expected] of cases) {
    const item = fixture({ files: { 'feedback_a.md': '---\ndescription: A\n---\n' }, domains: { 'feedback_a.md': 'verify' } });
    run(args(item));
    fs.writeFileSync(path.join(item.directory, 'index', 'verify.md'), indexBody);
    const child = spawnSync(process.execPath, [verifyScript, '--dir', item.directory], { encoding: 'utf8' });
    assert.notEqual(child.status, 0, label);
    assert.match(`${child.stdout}\n${child.stderr}`, expected, label);
  }
});

test('CLI は --dry-run を既定としファイルを書き換えない', () => {
  const item = fixture({ files: { 'feedback_a.md': '---\ndescription: A\n---\n' }, domains: { 'feedback_a.md': 'verify' } });
  const before = fs.readFileSync(path.join(item.directory, 'MEMORY.md'));
  const child = spawnSync(process.execPath, [splitScript, '--dir', item.directory, '--domains', item.domainsFile], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(fs.readFileSync(path.join(item.directory, 'MEMORY.md')).equals(before));
  assert.equal(fs.existsSync(path.join(item.directory, 'index')), false);
});
