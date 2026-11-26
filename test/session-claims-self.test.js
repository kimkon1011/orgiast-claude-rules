import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveSelf } from '../tools/session-claims.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

describe('resolveSelf', () => {
  it('--filter で self が空なら self=none で warning を返す', () => {
    const result = resolveSelf('--filter', '');
    assert.equal(result.self, 'none');
    assert.notEqual(result.warning, null);
    assert(result.warning.includes('self=none'));
  });

  it('--filter で self があれば warning null で self をそのまま返す', () => {
    const result = resolveSelf('--filter', 'abc123');
    assert.equal(result.self, 'abc123');
    assert.equal(result.warning, null);
  });

  it('--claim で self が空なら self は空のまま warning を返す', () => {
    const result = resolveSelf('--claim', '');
    assert.equal(result.self, '');
    assert.notEqual(result.warning, null);
    assert(result.warning.includes('着手印を記録しません'));
  });

  it('--claim で self があれば warning null で self をそのまま返す', () => {
    const result = resolveSelf('--claim', 'abc123');
    assert.equal(result.self, 'abc123');
    assert.equal(result.warning, null);
  });

  it('--release で self が空なら self は空のまま warning を返す', () => {
    const result = resolveSelf('--release', '');
    assert.equal(result.self, '');
    assert.notEqual(result.warning, null);
    assert(result.warning.includes('着手印を記録しません'));
  });

  it('--release で self があれば warning null で self をそのまま返す', () => {
    const result = resolveSelf('--release', 'def456');
    assert.equal(result.self, 'def456');
    assert.equal(result.warning, null);
  });

  it('--list は self 不要なので warning null を返す', () => {
    const result = resolveSelf('--list', '');
    assert.equal(result.warning, null);
    assert.equal(result.self, '');
  });

  it('--sync も self 不要なので warning null', () => {
    const result = resolveSelf('--sync', '');
    assert.equal(result.warning, null);
    assert.equal(result.self, '');
  });
});

describe('resolveSelf integration (CLI)', () => {
  it('--filter を --self 無し・CLAUDE_SESSION_ID 無しで実行すると exit 0 で候補行を出力する', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-claims-test-'));
    try {
      const candidatesFile = path.join(tmpDir, 'candidates.txt');
      fs.writeFileSync(candidatesFile, '候補A\n候補B\n', 'utf8');

      const result = spawnSync(
        process.execPath,
        [path.join(rootDir, '..', 'tools', 'session-claims.mjs'), '--filter', '--candidates', candidatesFile],
        {
          cwd: path.join(rootDir, '..'),
          env: { ...process.env, CLAUDE_SESSION_ID: '', ORGIAST_HOME: tmpDir },
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert(result.stdout.includes('候補A'), `stdout: ${result.stdout}`);
      assert(result.stdout.includes('候補B'), `stdout: ${result.stdout}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});