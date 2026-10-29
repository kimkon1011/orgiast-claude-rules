import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, loadKey, buildPrompt } from './booth-perse-gen.mjs';

test('buildPrompt: どの案にも高さ3.6mと明るさの指示が必ず入る', () => {
  const t = buildPrompt('BRIEF', { add: 'PLAN SIMPLE: white panels about 2.7 m high' });
  assert.match(t, /overall height is 3\.6 m/);
  assert.match(t, /BRIGHT/);
  assert.ok(t.indexOf('MANDATORY HEIGHT') > t.indexOf('PLAN SIMPLE'), '案の記述より後ろに置き、低い高さの記述を上書きする');
});

test('parseArgs: --max-height で会場の上限に合わせられ、既定は3.6', () => {
  assert.equal(parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o']).maxHeight, 3.6);
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--max-height', '4.5']);
  assert.equal(o.maxHeight, 4.5);
  assert.match(buildPrompt('B', { add: 'P' }, o.maxHeight), /overall height is 4\.5 m/);
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--max-height', 'x']), /--max-height/);
});

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
