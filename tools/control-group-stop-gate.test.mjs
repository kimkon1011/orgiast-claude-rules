import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  evaluateControlGroup,
  listGitChangedFiles,
  runControlGroup,
} from './control-group-stop-gate.mjs';

// 実在ファイルを参照せず、ソースと台帳のハッシュは同じ fixture から導出する。
const cwd = path.resolve('synthetic-control-group-repository');
const source = "export const inspect = () => ({ decision: 'block' });\n";
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture(names = ['sample-gate']) {
  const files = new Map();
  const changed = [];
  for (const name of names) {
    const gatePath = path.join(cwd, 'tools', `${name}.mjs`);
    files.set(gatePath, source);
    files.set(path.join(cwd, 'tools', `${name}.test.mjs`), '// injected test\n');
    changed.push(path.join('tools', `${name}.mjs`));
  }
  return {
    files,
    options: {
      cwd,
      ledgerLines: [],
      listChangedFiles: () => changed,
      readFile: (filename) => {
        if (!files.has(filename)) throw new Error('synthetic ENOENT');
        return files.get(filename);
      },
      existsFile: (filename) => files.has(filename),
    },
    record(name = names[0], verdict = 'killed', text = source) {
      return JSON.stringify({ name, sha256: hash(text), verdict, total: 1, at: '2026-09-23T00:00:00.000Z' });
    },
  };
}

test('git リポジトリでない: 一覧取得が投げる場合と空の場合は pass', () => {
  const { options } = fixture();
  const throwing = evaluateControlGroup({
    ...options,
    listChangedFiles: () => { throw new Error('not a git repository'); },
  });
  const empty = evaluateControlGroup({ ...options, listChangedFiles: () => [] });
  assert.deepEqual(throwing, { decision: 'pass' });
  assert.deepEqual(empty, { decision: 'pass' });
});

test('検出器以外と検出器のテストだけの変更は pass', () => {
  const { options } = fixture();
  const result = evaluateControlGroup({
    ...options,
    listChangedFiles: () => ['README.md', 'tools/sample-gate.test.mjs'],
  });
  assert.deepEqual(result, { decision: 'pass' });
});

test('隣に同名の test が無い検出器は pass', () => {
  const { files, options } = fixture();
  files.delete(path.join(cwd, 'tools', 'sample-gate.test.mjs'));
  assert.deepEqual(evaluateControlGroup(options), { decision: 'pass' });
});

test('name、現在の sha256、killed が一致すれば pass', () => {
  const f = fixture();
  const result = evaluateControlGroup({
    ...f.options,
    ledgerLines: [f.record()],
  });
  assert.deepEqual(result, { decision: 'pass' });
});

test('対照群: 同名の killed があっても検定後の書き換えで sha256 が変われば block', () => {
  const f = fixture();
  const ledgerLines = [f.record()];
  f.files.set(path.join(cwd, 'tools', 'sample-gate.mjs'), `${source}// changed after checking\n`);
  const result = evaluateControlGroup({ ...f.options, ledgerLines });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /sample-gate/);
  assert.match(result.reason, /未検定/);
  assert.match(result.reason, /node tools\/control-group-check\.mjs --gate sample-gate/);
});

test('survived だけなら block し、検出力と負例追加を理由に書く', () => {
  const f = fixture();
  const result = evaluateControlGroup({
    ...f.options,
    ledgerLines: [f.record('sample-gate', 'survived')],
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /テストに検出力が無い。落ちるべき入力で落ちることを1件足せ/);
  assert.match(result.reason, /node tools\/control-group-check\.mjs --gate sample-gate/);
});

test('unmutatable だけなら block し、検定できないと書く', () => {
  const f = fixture();
  const result = evaluateControlGroup({
    ...f.options,
    ledgerLines: [f.record('sample-gate', 'unmutatable')],
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /検定できない/);
  assert.match(result.reason, /unmutatable/);
});

test('台帳が空または未指定なら block', () => {
  const f = fixture();
  for (const ledgerLines of [[], '', undefined, null]) {
    const result = evaluateControlGroup({ ...f.options, ledgerLines });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /sample-gate/);
  }
});

test('台帳が存在しない場合も I/O 境界を通して block', () => {
  const f = fixture();
  const result = runControlGroup({
    ...f.options,
    ledgerPath: path.join(cwd, 'missing-ledger.jsonl'),
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /sample-gate/);
});

test('複数の未検定検出器を全部示し、検定済みの検出器は理由に含めない', () => {
  const f = fixture(['first-gate', 'second-guard', 'third-check', 'done-gate']);
  const result = evaluateControlGroup({
    ...f.options,
    ledgerLines: [f.record('done-gate')],
  });
  assert.equal(result.decision, 'block');
  for (const name of ['first-gate', 'second-guard', 'third-check']) {
    assert.ok(result.reason.includes(`${name}:`));
    assert.ok(result.reason.includes(`node tools/control-group-check.mjs --gate ${name}`));
  }
  assert.equal(result.reason.includes('done-gate'), false);
});

test('sha256 が同じでも別名の killed は証跡にならない', () => {
  const f = fixture();
  const result = evaluateControlGroup({
    ...f.options,
    ledgerLines: [f.record('other-gate')],
  });
  assert.equal(result.decision, 'block');
});

test('JSONL の壊れた行は無視し、正常な一致行を利用する', () => {
  const f = fixture();
  const result = evaluateControlGroup({
    ...f.options,
    ledgerLines: `broken JSON\nnull\n{}\n${f.record()}\n`,
  });
  assert.deepEqual(result, { decision: 'pass' });
  const malformedOnly = evaluateControlGroup({
    ...f.options,
    ledgerLines: 'broken JSON\nnull\n{}\n',
  });
  assert.equal(malformedOnly.decision, 'block');
});

test('baseline_failing と timeout は検定済みにならない', () => {
  const f = fixture();
  for (const verdict of ['baseline_failing', 'timeout']) {
    const result = evaluateControlGroup({
      ...f.options,
      ledgerLines: [f.record('sample-gate', verdict)],
    });
    assert.equal(result.decision, 'block');
    assert.ok(result.reason.includes(verdict));
  }
});

test('ファイル操作の例外と cwd 未指定は pass にする', () => {
  const f = fixture();
  for (const overrides of [
    { readFile: () => { throw new Error('read failed'); } },
    { existsFile: () => { throw new Error('exists failed'); } },
    { cwd: undefined },
  ]) {
    const result = evaluateControlGroup({ ...f.options, ...overrides });
    assert.deepEqual(result, { decision: 'pass' });
  }
  const result = runControlGroup({
    ...f.options,
    ledgerPath: path.join(cwd, 'ledger.jsonl'),
    existsFile: () => true,
    readFile: () => { throw new Error('ledger read failed'); },
  });
  assert.deepEqual(result, { decision: 'pass' });
});

test('I/O 境界は指定された cwd と台帳を使う', () => {
  const f = fixture();
  const ledgerPath = path.join(cwd, 'injected-ledger.jsonl');
  f.files.set(ledgerPath, f.record() + '\n');
  let receivedCwd;
  const result = runControlGroup({
    ...f.options,
    ledgerPath,
    listChangedFiles: (value) => {
      receivedCwd = value;
      return ['tools/sample-gate.mjs'];
    },
  });
  assert.deepEqual(result, { decision: 'pass' });
  assert.equal(receivedCwd, cwd);
});

test('Git の NUL 区切りを解析し、未追跡・空白・日本語・rename を扱う', () => {
  let received;
  const stdout = [
    ' M tools/first-gate.mjs',
    '?? tools/new folder/日本語-check.mjs',
    'R  tools/renamed-guard.mjs',
    'tools/old-guard.mjs',
    ' D tools/deleted-gate.mjs',
    '',
  ].join('\0');
  const files = listGitChangedFiles(cwd, (command, args, options) => {
    received = { command, args, options };
    return { status: 0, stdout };
  });
  assert.deepEqual(files, [
    'tools/first-gate.mjs',
    'tools/new folder/日本語-check.mjs',
    'tools/renamed-guard.mjs',
  ]);
  assert.equal(received.command, 'git');
  assert.deepEqual(received.args, [
    '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ]);
  assert.equal(received.options.windowsHide, true);
});

test('Git の非ゼロ終了は空の変更一覧と混同せず評価境界で pass', () => {
  const f = fixture();
  const listChangedFiles = (value) => listGitChangedFiles(value, () => ({
    status: 128,
    stdout: '',
  }));
  assert.throws(() => listChangedFiles(cwd), /git status/);
  const result = evaluateControlGroup({ ...f.options, listChangedFiles });
  assert.deepEqual(result, { decision: 'pass' });
});
