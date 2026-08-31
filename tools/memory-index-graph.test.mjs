import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KEEP, analyze, applyPlan, parseIndex, planApply } from './memory-index-graph.mjs';

const script = fileURLToPath(new URL('./memory-index-graph.mjs', import.meta.url));

function fixture({ bom = false, crlf = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-graph-'));
  const nl = crlf ? '\r\n' : '\n';
  const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const links = { a: ['c', 'd'], b: ['c'], c: ['e'], d: ['f'], e: ['g'], f: [], g: [], h: [] };
  for (const name of entries) {
    const refs = links[name].map((target) => `[[${target}]]`).join(' ');
    fs.writeFileSync(path.join(directory, `${name}.md`), `# ${name}${nl}${refs}${nl}`);
  }
  const lines = [
    '- [A](a.md) ／ [B](b.md) ／ [C](c.md) — hook',
    '- [D](d.md) ／ [E](e.md) ／ [F](f.md)',
    '- [G](g.md) ／ [H](h.md)',
  ];
  fs.writeFileSync(path.join(directory, 'MEMORY.md'), `${bom ? '\uFEFF' : ''}${lines.join(nl)}${nl}`);
  const keepFile = path.join(directory, 'keep.txt');
  fs.writeFileSync(keepFile, '');
  return { directory, keepFile };
}

function cleanup(directory) { fs.rmSync(directory, { recursive: true, force: true }); }

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('キープリストの既定パスが実在ファイルに解決される', () => {
  assert.equal(fs.existsSync(DEFAULT_KEEP), true, DEFAULT_KEEP);
});

test('到達可能なエントリだけが候補になり、到達不能になる候補はスキップされる', () => {
  const f = fixture();
  try {
    const result = analyze(f.directory);
    assert.ok(result.removableFiles.includes('c.md'));
    assert.ok(!result.removableFiles.includes('h.md'), '被リンクがなく削除すると孤立する h は候補外');
    const plan = planApply(f.directory, { budget: 1, keepFile: f.keepFile });
    assert.ok(!plan.removedFiles.includes('h.md'));
    assert.equal(plan.reached.size, 8);
  } finally { cleanup(f.directory); }
});

test('キープリストは予算超過でも削除されない', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.keepFile, ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md'].join('\n'));
    const plan = planApply(f.directory, { budget: 1, keepFile: f.keepFile });
    assert.equal(plan.removed.size, 0);
    assert.ok(plan.afterBytes > 1);
  } finally { cleanup(f.directory); }
});

test('予算に達したら全部を削らず停止する', () => {
  const f = fixture();
  try {
    const before = fs.statSync(path.join(f.directory, 'MEMORY.md')).size;
    const one = planApply(f.directory, { budget: before - 20, keepFile: f.keepFile });
    assert.ok(one.removed.size > 0);
    assert.ok(one.removed.size < 8);
    assert.ok(one.afterBytes <= before - 20);
  } finally { cleanup(f.directory); }
});

test('BOM + CRLF を apply 後も保持する', () => {
  const f = fixture({ bom: true, crlf: true });
  try {
    const before = fs.readFileSync(path.join(f.directory, 'MEMORY.md'));
    const result = applyPlan(f.directory, { budget: before.length - 20, keepFile: f.keepFile });
    const after = fs.readFileSync(path.join(f.directory, 'MEMORY.md'));
    assert.deepEqual(after.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    assert.ok(after.toString('utf8').includes('\r\n'));
    assert.equal(after.toString('utf8').replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(parseIndex(after.toString('utf8')).entries.length, result.remainingEntries);
  } finally { cleanup(f.directory); }
});

test('未パース断片は apply 後も元の位置に保持する', () => {
  const f = fixture();
  try {
    const indexPath = path.join(f.directory, 'MEMORY.md');
    const text = fs.readFileSync(indexPath, 'utf8')
      .replace('- [A](a.md) ／ [B](b.md)', '- [A](a.md) ／ ただのテキスト ／ [B](b.md)');
    fs.writeFileSync(indexPath, text);
    applyPlan(f.directory, { budget: Buffer.byteLength(text, 'utf8') - 20, keepFile: f.keepFile });
    const after = fs.readFileSync(indexPath, 'utf8');
    assert.ok(after.includes('ただのテキスト'));
    assert.match(after, /^- \[A\]\(a\.md\) ／ ただのテキスト/m);
  } finally { cleanup(f.directory); }
});

test('--apply 前に索引が変化したら書かずに失敗する', async () => {
  const f = fixture();
  try {
    const original = fs.readFileSync(path.join(f.directory, 'MEMORY.md'), 'utf8');
    const pending = runCli(['--apply', '--dir', f.directory, '--budget', '1', '--min-bytes', '0', '--keep-file', f.keepFile], { MEMORY_INDEX_TEST_PREWRITE_DELAY_MS: '500' });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fs.readdirSync(f.directory).some((name) => name.startsWith('MEMORY.md.bak-'))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.readdirSync(f.directory).some((name) => name.startsWith('MEMORY.md.bak-')), '書き込み前待機に入った');
    fs.appendFileSync(path.join(f.directory, 'MEMORY.md'), '# concurrent\n');
    const result = await pending;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /書き込み直前/);
    assert.equal(fs.readFileSync(path.join(f.directory, 'MEMORY.md'), 'utf8'), `${original}# concurrent\n`);
  } finally { cleanup(f.directory); }
});

test('適用後検証失敗時はバックアップから復元する', async () => {
  const f = fixture();
  try {
    const original = fs.readFileSync(path.join(f.directory, 'MEMORY.md'));
    const result = await runCli(['--apply', '--dir', f.directory, '--budget', '1', '--min-bytes', '0', '--keep-file', f.keepFile], { MEMORY_INDEX_TEST_CORRUPT_AFTER_WRITE: '1' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /バックアップから復元/);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'MEMORY.md')), original);
  } finally { cleanup(f.directory); }
});

test('--min-bytes 以下の索引は書き換えられない', async () => {
  const f = fixture();
  try {
    const indexPath = path.join(f.directory, 'MEMORY.md');
    const before = fs.readFileSync(indexPath);
    const beforeStat = fs.statSync(indexPath);
    const result = await runCli(['--apply', '--dir', f.directory, '--budget', '1', '--min-bytes', String(before.length), '--keep-file', f.keepFile]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /しきい値未満のためスキップ/);
    assert.deepEqual(fs.readFileSync(indexPath), before);
    assert.equal(fs.statSync(indexPath).mtimeMs, beforeStat.mtimeMs);
    assert.equal(fs.readdirSync(f.directory).some((name) => name.startsWith('MEMORY.md.bak-')), false);
  } finally { cleanup(f.directory); }
});

test('--all-projects が複数のプロジェクトを処理する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-home-'));
  try {
    const projects = path.join(home, '.claude', 'projects');
    const first = fixture();
    const second = fixture();
    fs.mkdirSync(projects, { recursive: true });
    fs.renameSync(first.directory, path.join(projects, 'project-one'));
    fs.renameSync(second.directory, path.join(projects, 'project-two'));
    for (const project of ['project-one', 'project-two']) {
      fs.renameSync(path.join(projects, project), path.join(projects, `${project}-tmp`));
      fs.mkdirSync(path.join(projects, project), { recursive: true });
      fs.renameSync(path.join(projects, `${project}-tmp`), path.join(projects, project, 'memory'));
    }
    const result = await runCli(['--all-projects', '--dry-run', '--budget', '1', '--min-bytes', '0'], { HOME: home, USERPROFILE: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /project-one/);
    assert.match(result.stdout, /project-two/);
    assert.equal((result.stdout.match(/ドライラン:/g) ?? []).length, 2);
  } finally { cleanup(home); }
});

test('--all-projects は対象0件でも exit 0', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-empty-home-'));
  try {
    const result = await runCli(['--all-projects', '--dry-run'], { HOME: home, USERPROFILE: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /対象の MEMORY\.md はありません/);
  } finally { cleanup(home); }
});
