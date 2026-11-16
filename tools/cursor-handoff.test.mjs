import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeIndex } from './onboarding-sync.mjs';
import { QUEUED_LABEL, RUNNING_LABEL, DONE_LABEL, run } from './cursor-handoff.mjs';

const sentence = 'リポジトリのコード修正（数行の軽い修正を除く）は自分で実装せず、tools/cursor-handoff.mjs でcursor-agentラベルのissueを立ててCursorに回し、自分はできたPRの確認だけをする';

const baseArgs = [
  '--repo', 'kimkon1011/example',
  '--title', 'ボタンの文言を直す',
  '--body', '目的: 文言を直す\n受け入れ条件: 表示が新しい\n触る範囲: src/App.tsx\nテスト: npm test',
  '--from', 'kim@orgiast.jp / kim-PC / sess-1',
];

test('--dry-run は gh を呼ばず、ラベルと依頼元と本文を出す', () => {
  let spawned = false;
  const lines = [];
  const result = run([...baseArgs, '--dry-run'], {
    spawnImpl: () => { spawned = true; return { status: 0, stdout: '', stderr: '' }; },
    stdout: (line) => lines.push(line),
  });
  assert.equal(spawned, false);
  assert.equal(result.dryRun, true);
  const text = lines.join('\n');
  assert.match(text, /issue は作りません/);
  assert.match(text, /repo: kimkon1011\/example/);
  assert.match(text, /kim@orgiast\.jp \/ kim-PC \/ sess-1/);
  assert.match(text, new RegExp(`issue-label: ${QUEUED_LABEL}`));
  assert.match(text, new RegExp(RUNNING_LABEL));
  assert.match(text, new RegExp(DONE_LABEL));
  assert.match(text, /目的: 文言を直す/);
  assert.match(text, /Closes #<この issue の番号>/);
});

test('--body-file の dry-run も gh を呼ばない', () => {
  const file = path.join(os.tmpdir(), `cursor-handoff-body-${process.pid}.md`);
  fs.writeFileSync(file, '目的: ファイルから読む\nテスト: node --test tools/cursor-handoff.test.mjs\n');
  try {
    let spawned = false;
    const lines = [];
    run(['--repo', 'octo/demo', '--title', '読む', '--body-file', file, '--from', 'cr@orgiast.jp / cr-PC / s', '--dry-run'], {
      spawnImpl: () => { spawned = true; return { status: 0, stdout: '', stderr: '' }; },
      stdout: (line) => lines.push(line),
    });
    assert.equal(spawned, false);
    assert.match(lines.join('\n'), /目的: ファイルから読む/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('gh が無いときは理由を出して止める', () => {
  assert.throws(() => run(baseArgs, {
    spawnImpl: () => ({ status: null, error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }),
  }), /gh が見つかりません/);
});

test('gh が未認証のときは issue を作らず理由を出す', () => {
  const calls = [];
  assert.throws(() => run(baseArgs, {
    spawnImpl: (cmd, args) => {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'gh version 2.62.0\n', stderr: '' };
      if (args[0] === 'auth') return { status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
      return { status: 0, stdout: '', stderr: '' };
    },
  }), /gh が未認証です/);
  assert.equal(calls.some((args) => args[0] === 'issue'), false);
});

test('認証済みならラベルを補い、cursor-agent の issue を作る', () => {
  const calls = [];
  const lines = [];
  const result = run(baseArgs, {
    stdout: (line) => lines.push(line),
    spawnImpl: (cmd, args) => {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'gh version 2.62.0\n', stderr: '' };
      if (args[0] === 'auth') return { status: 0, stdout: '', stderr: 'Logged in to github.com' };
      if (args[0] === 'label' && args[1] === 'list') return { status: 0, stdout: '[{"name":"bug"}]', stderr: '' };
      if (args[0] === 'label' && args[1] === 'create') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'issue') {
        const file = args[args.indexOf('--body-file') + 1];
        assert.match(fs.readFileSync(file, 'utf8'), /依頼元: kim@orgiast\.jp/);
        return { status: 0, stdout: 'https://github.com/kimkon1011/example/issues/12\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
  });
  assert.equal(result.url, 'https://github.com/kimkon1011/example/issues/12');
  assert.deepEqual(lines, [result.url]);
  const creates = calls.filter((args) => args[0] === 'label' && args[1] === 'create').map((args) => args[2]);
  assert.deepEqual(creates, [QUEUED_LABEL, RUNNING_LABEL, DONE_LABEL]);
  const issue = calls.find((args) => args[0] === 'issue');
  assert.equal(issue[issue.indexOf('--label') + 1], QUEUED_LABEL);
  assert.equal(issue.includes(RUNNING_LABEL), false);
});

test('共通ルールの索引に Cursor レーンの一文がある', () => {
  const onboarding = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const template = fs.readFileSync(new URL('../CLAUDE.md.template', import.meta.url), 'utf8');
  const doc = fs.readFileSync(new URL('../docs/cursor-lane.md', import.meta.url), 'utf8');
  assert.ok(onboarding.includes(sentence));
  assert.ok(makeIndex(onboarding).includes(sentence));
  assert.ok(template.includes(sentence));
  for (const label of [QUEUED_LABEL, RUNNING_LABEL, DONE_LABEL]) assert.ok(doc.includes(label));
  assert.match(doc, /Closes #N/);
  assert.match(doc, /毎時/);
});
