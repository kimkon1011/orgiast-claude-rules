import test from 'node:test';
import assert from 'node:assert/strict';
import { findRescueTodos, sweepFile, sweepLines } from './rescue-todo-sweep.mjs';

const todo = (number, branch, repo = '/repo') => `${number}. [ ] rescue ブランチ \`${branch}\` に退避した変更のレビューが必要（${repo}; abcdef1234567）`;

test('covered-in-main の行だけを置換し、他の内容を変えない', () => {
  const input = `# 見出し\n\n${todo(1, 'rescue/done')}\n${todo(2, 'rescue/unique')}\n3. [ ] 通常 TODO\n`;
  const result = sweepLines(input, new Map([
    ['rescue/done', { status: 'covered-in-main' }],
    ['rescue/unique', { status: 'unique' }],
  ]), { date: '2026-10-22' });
  const replaced = '1. ~~rescue ブランチ `rescue/done` に退避した変更のレビューが必要（/repo; abcdef1234567）~~ → ✅ 2026-10-22 rescue-review-scan: covered-in-main（main に取り込み済み・マージ不要）';
  assert.equal(result.text, `# 見出し\n\n${replaced}\n${todo(2, 'rescue/unique')}\n3. [ ] 通常 TODO\n`);
  assert.deepEqual(result.swept, [{ branch: 'rescue/done', status: 'covered-in-main' }]);
  assert.deepEqual(result.kept, ['rescue/unique']);
  assert.ok(!result.text.includes(`1. [ ] rescue ブランチ`));
  assert.match(result.text, /rescue\/done.*covered-in-main/);
});

test('CRLF と置換対象外の行を byte 単位で保つ', () => {
  const input = `前置き  \r\n${todo(7, 'rescue/done')}\r\n\t後続\r\n`;
  const result = sweepLines(input, { 'rescue/done': { status: 'covered' } }, { date: '2026-10-22' });
  assert.equal(result.text.split('\r\n').length, input.split('\r\n').length);
  assert.equal(result.text.replace(/^.*covered（main に取り込み済み・マージ不要）/m, todo(7, 'rescue/done')), input);
  assert.equal(/(^|[^\r])\n/.test(result.text), false);
});

test('2回目は冪等で changed=false', () => {
  const first = sweepLines(todo(1, 'rescue/done'), { 'rescue/done': { status: 'duplicate' } }, { date: '2026-10-22' });
  const second = sweepLines(first.text, { 'rescue/done': { status: 'duplicate' } }, { date: '2026-10-22' });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('取り消し線付きと ✅ 付きの行は検出しない', () => {
  const input = `~~${todo(1, 'rescue/old')}~~\n${todo(2, 'rescue/check')} ✅ 済み\n`;
  assert.deepEqual(findRescueTodos(input), []);
});

test('unique・error・scan に無い枝は kept に残す', () => {
  const input = [todo(1, 'rescue/u'), todo(2, 'rescue/e'), todo(3, 'rescue/missing')].join('\n');
  const result = sweepLines(input, {
    'rescue/u': { status: 'unique' },
    'rescue/e': { status: 'error' },
  }, { date: '2026-10-22' });
  assert.equal(result.changed, false);
  assert.deepEqual(result.kept, ['rescue/u', 'rescue/e', 'rescue/missing']);
});

test('unique は names が全てノイズの場合だけ noise-only として掃除する', () => {
  const input = [todo(1, 'rescue/noise'), todo(2, 'rescue/mixed'), todo(3, 'rescue/unknown'), todo(4, 'rescue/empty')].join('\n');
  const first = sweepLines(input, {
    'rescue/noise': { status: 'unique', names: ['tools/handoff-audit-knowledge.json'] },
    'rescue/mixed': { status: 'unique', names: ['tools/a.mjs', 'tools/handoff-audit-knowledge.json'] },
    'rescue/unknown': { status: 'unique' },
    'rescue/empty': { status: 'unique', names: [] },
  }, { date: '2026-10-24' });
  assert.deepEqual(first.swept, [{ branch: 'rescue/noise', status: 'noise-only' }]);
  assert.deepEqual(first.kept, ['rescue/mixed', 'rescue/unknown', 'rescue/empty']);
  assert.match(first.text, /rescue\/noise.*noise-only（台帳・実行時成果物のみでレビュー不要）/);
  assert.ok(first.text.includes(todo(2, 'rescue/mixed')));
  assert.ok(first.text.includes(todo(3, 'rescue/unknown')));
  assert.ok(first.text.includes(todo(4, 'rescue/empty')));

  const second = sweepLines(first.text, {
    'rescue/noise': { status: 'unique', names: ['tools/handoff-audit-knowledge.json'] },
  }, { date: '2026-10-24' });
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('複数 repo は repo ごとに1回だけ scan する', () => {
  const input = [todo(1, 'rescue/a', '/one'), todo(2, 'rescue/b', '/one'), todo(3, 'rescue/c', '/two')].join('\n');
  const calls = [];
  let written = '';
  const result = sweepFile('/tmp/next-session.md', {
    date: '2026-10-22',
    readFile: () => input,
    writeFile: (_file, text) => { written = text; },
    isDirectory: () => true,
    scan: ({ repo, main }) => {
      calls.push({ repo, main });
      return repo === '/one'
        ? [{ branch: 'rescue/a', status: 'covered' }, { branch: 'rescue/b', status: 'unique' }]
        : [{ branch: 'rescue/c', status: 'ignored-only' }];
    },
  });
  assert.deepEqual(calls, [{ repo: '/one', main: 'origin/main' }, { repo: '/two', main: 'origin/main' }]);
  assert.deepEqual(result.swept, [{ branch: 'rescue/a', status: 'covered' }, { branch: 'rescue/c', status: 'ignored-only' }]);
  assert.deepEqual(result.kept, ['rescue/b']);
  assert.match(written, /rescue\/a.*covered/);
  assert.match(written, /rescue\/c.*ignored-only/);
});
