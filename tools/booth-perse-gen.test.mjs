import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, loadKey } from './booth-perse-gen.mjs';

test('parseArgs: 必須3項目と複数の --ref を読む', () => {
  const o = parseArgs(['--brief', 'b.txt', '--plans', 'p.json', '--out', 'out', '--ref', 'logo.png', '--ref', 'photo.jpg']);
  assert.equal(o.brief, 'b.txt');
  assert.equal(o.plans, 'p.json');
  assert.equal(o.out, 'out');
  assert.deepEqual(o.refs, ['logo.png', 'photo.jpg']);
});

test('parseArgs: 必須項目が欠けたら使い方付きで止まる', () => {
  assert.throws(() => parseArgs(['--brief', 'b.txt', '--out', 'out']), /--plans is required/);
});

test('parseArgs: 知らないオプションは止まる', () => {
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--model', 'x']), /unknown option/);
});

test('loadKey: openrouter.env の OPENROUTER_API_KEY を読む', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'perse-'));
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'export OPENROUTER_API_KEY="sk-test"\n');
  assert.equal(loadKey(home), 'sk-test');
});

test('loadKey: キーが無ければ止まる', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'perse-'));
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'OTHER=1\n');
  assert.throws(() => loadKey(home), /OPENROUTER_API_KEY/);
});
