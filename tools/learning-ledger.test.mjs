import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpMemory, run } from './learning-ledger.mjs';

const memory = ({ count, status = 'ACTIVE', critical = false, body = '本文\n' } = {}) => `---\nname: fixture\nmetadata:\n  type: feedback\n${count === undefined ? '' : `  count: ${count}\n`}  status: ${status}\n${critical ? '  critical: true\n' : ''}---\n\n${body}`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-ledger-'));
  return { dir, write(name, text) { const file = path.join(dir, name); fs.writeFileSync(file, text); return file; } };
}

test('count 2→3でPROMOTEになる', () => {
  const source = memory({ count: 2, body: '変更しない本文\n' });
  const result = bumpMemory(source);
  assert.match(result.text, /count: 3/);
  assert.match(result.text, /status: PROMOTE/);
  assert.match(result.text, /変更しない本文/);
});

test('criticalはcount 1でPROMOTEになる', () => {
  const result = bumpMemory(memory({ count: 1 }), { critical: true });
  assert.match(result.text, /count: 2/);
  assert.match(result.text, /critical: true/);
  assert.match(result.text, /status: PROMOTE/);
});

test('PROMOTEDは一覧に出ない', () => {
  const f = fixture();
  f.write('done.md', memory({ count: 9, status: 'PROMOTED' }));
  const lines = [];
  const result = run(['--memory-dir', f.dir, '--list'], { out: (line) => lines.push(line), err: () => {} });
  assert.equal(result.targets.length, 0);
  assert.doesNotMatch(lines.join('\n'), /done\.md/);
});

test('壊れたfrontmatterをskipし件数式が合う', () => {
  const f = fixture();
  f.write('target.md', memory({ count: 3 }));
  f.write('excluded.md', memory({ count: 1 }));
  f.write('broken.md', '---\nname: broken\n本文');
  const lines = [], errors = [];
  run(['--memory-dir', f.dir, '--list'], { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  assert.match(errors.join('\n'), /skip: .*broken\.md/);
  assert.match(lines.at(-1), /走査 3 = 対象 1 \+ 対象外 1 \+ 解析不能 1/);
});

test('直下のmemory本体だけを走査する', () => {
  const f = fixture();
  f.write('feedback.md', memory({ count: 1 }));
  f.write('MEMORY.md', '索引');
  for (const type of ['project', 'reference', 'user']) {
    f.write(`${type}.md`, memory({ count: 3 }).replace('type: feedback', `type: ${type}`));
  }
  for (const name of ['index', 'index.bak-20260917', '.memory-body-backup-20260917', 'shared']) {
    const nested = path.join(f.dir, name);
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'broken.md'), '壊れたmemory');
  }
  const lines = [], errors = [];
  const result = run(['--memory-dir', f.dir, '--list'], { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  assert.equal(result.invalid, 0);
  assert.equal(result.scanned, 4);
  assert.equal(result.excluded, 4);
  assert.deepEqual(errors, []);
  assert.match(lines.at(-1), /走査 4 = 対象 0 \+ 対象外 4 \+ 解析不能 0/);
});

test('--dryでは書き込まない', () => {
  const f = fixture();
  const file = f.write('dry.md', memory({ count: 2 }));
  const before = fs.readFileSync(file, 'utf8');
  run(['--bump', file, '--dry'], { out: () => {}, err: () => {} });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('MEMORY.mdのバイト数・比率・常時ロード行数を表示する', () => {
  const f = fixture();
  const index = '- [一](one.md)\n- [二](two.md)';
  f.write('MEMORY.md', `# Memory\n\n## 常に効くルール\n${index}\n\n## ドメイン索引\n- [索引](index/x.md)\n`);
  f.write('one.md', memory({ count: 1 })); f.write('two.md', memory({ count: 1 }));
  const lines = [];
  run(['--memory-dir', f.dir, '--list'], { out: (line) => lines.push(line), err: () => {} });
  const bytes = fs.statSync(path.join(f.dir, 'MEMORY.md')).size;
  assert.match(lines.join('\n'), new RegExp(`自動ロード層: MEMORY.md ${bytes}B / 上限 24985B \\(${Math.round(bytes / 24985 * 100)}%\\) / 常に効くルール 2行`));
});

test('PROMOTEDだけを掃除候補にする', () => {
  const f = fixture();
  f.write('MEMORY.md', '## 常に効くルール\n- [済](done.md)\n- [現役](active.md)\n');
  f.write('done.md', memory({ count: 3, status: 'PROMOTED' })); f.write('active.md', memory({ count: 1 }));
  const lines = [];
  run(['--memory-dir', f.dir, '--list'], { out: (line) => lines.push(line), err: () => {} });
  assert.match(lines.join('\n'), /掃除候補: done\.md（PROMOTED だが常時ロードに残存）/);
  assert.doesNotMatch(lines.join('\n'), /掃除候補: active\.md/);
});

test('MEMORY.md無しでも落ちずqueueに状態を出す', () => {
  const f = fixture(); const queue = path.join(f.dir, 'queue', 'promotion.md'); const lines = [];
  run(['--memory-dir', f.dir, '--list', '--queue-out', queue], { out: (line) => lines.push(line), err: () => {} });
  assert.match(lines.join('\n'), /自動ロード層: MEMORY\.md なし/);
  assert.match(fs.readFileSync(queue, 'utf8'), /自動ロード層: MEMORY\.md なし\n掃除候補: 0件/);
});
