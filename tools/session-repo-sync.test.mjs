import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  isQuietWindow,
  isWorkingTreeClean,
  main,
} from './session-repo-sync.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-repo-sync-'));
  const source = path.join(root, 'source');
  const origin = path.join(root, 'origin.git');
  const working = path.join(root, 'working');
  const projectsDir = path.join(root, 'projects');
  const ledgerPath = path.join(root, 'state', 'ledger.jsonl');
  fs.mkdirSync(source);
  fs.mkdirSync(projectsDir);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'config', 'user.name', 'Session Repo Sync Test');
  fs.writeFileSync(path.join(source, 'file.txt'), 'first\n');
  git(source, 'add', 'file.txt');
  git(source, 'commit', '-m', 'first');
  const oldSha = git(source, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(source, 'file.txt'), 'second\n');
  git(source, 'add', 'file.txt');
  git(source, 'commit', '-m', 'second');
  execFileSync('git', ['clone', '--bare', source, origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', origin, working], { stdio: 'ignore' });
  git(working, 'checkout', oldSha, '--quiet');
  return { root, working, projectsDir, ledgerPath, oldSha };
}

test('isWorkingTreeClean は空白だけをclean、それ以外をdirtyと判定する', () => {
  assert.equal(isWorkingTreeClean(''), true);
  assert.equal(isWorkingTreeClean(' \r\n\t'), true);
  assert.equal(isWorkingTreeClean(' M file.txt\n'), false);
  assert.equal(isWorkingTreeClean('?? new.txt\n M file.txt\n'), false);
});

test('isQuietWindow は空配列と閾値境界を正しく判定する', () => {
  const nowMs = 1_000_000;
  const thresholdMs = 300_000;
  assert.equal(isQuietWindow({ nowMs, transcriptMtimesMs: [], thresholdMs }), true);
  assert.equal(isQuietWindow({ nowMs, transcriptMtimesMs: [nowMs - thresholdMs + 1], thresholdMs }), false);
  assert.equal(isQuietWindow({ nowMs, transcriptMtimesMs: [nowMs - thresholdMs], thresholdMs }), true);
  assert.equal(isQuietWindow({ nowMs, transcriptMtimesMs: [0, nowMs - 1], thresholdMs }), false);
});

test('cleanかつ静穏ならHEADをorigin/mainのSHAへ移す', () => {
  const fixture = createFixture();
  try {
    const targetSha = git(fixture.working, 'rev-parse', 'origin/main');
    assert.notEqual(fixture.oldSha, targetSha);
    main({
      env: { SESSION_REPO_SYNC_TARGET: fixture.working },
      projectsDir: fixture.projectsDir,
      ledgerPath: fixture.ledgerPath,
    });
    assert.equal(git(fixture.working, 'rev-parse', 'HEAD'), targetSha);
    const ledger = JSON.parse(fs.readFileSync(fixture.ledgerPath, 'utf8').trim());
    assert.equal(ledger.from, fixture.oldSha);
    assert.equal(ledger.to, targetSha);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('未コミット変更があればHEADを動かさない', () => {
  const fixture = createFixture();
  try {
    fs.appendFileSync(path.join(fixture.working, 'file.txt'), 'local work\n');
    main({
      env: { SESSION_REPO_SYNC_TARGET: fixture.working },
      projectsDir: fixture.projectsDir,
      ledgerPath: fixture.ledgerPath,
    });
    assert.equal(git(fixture.working, 'rev-parse', 'HEAD'), fixture.oldSha);
    assert.equal(fs.existsSync(fixture.ledgerPath), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
