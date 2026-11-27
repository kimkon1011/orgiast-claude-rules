import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseJsonLoose, readJsonFile, stripBom } from './json-read.mjs';

test('stripBom removes only a leading UTF-8 BOM character', () => {
  assert.equal(stripBom('\uFEFF{"ok":true}'), '{"ok":true}');
});

test('parseJsonLoose parses BOM-prefixed JSON', () => {
  assert.deepEqual(parseJsonLoose('\uFEFF{"ok":true}'), { ok: true });
});

test('parseJsonLoose parses ordinary JSON', () => {
  assert.deepEqual(parseJsonLoose('{"ok":true}'), { ok: true });
});

test('parseJsonLoose extracts JSON surrounded by log lines', () => {
  assert.deepEqual(parseJsonLoose('[info] start\n{"ok":true}\n[info] end'), { ok: true });
});

test('parseJsonLoose includes the source in failures', () => {
  assert.throws(() => parseJsonLoose('not json at all', { source: 'delegate-result.json' }), /delegate-result\.json/);
});

test('readJsonFile explicitly decodes UTF-8 Japanese without mojibake', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'result.json');
  fs.writeFileSync(file, Buffer.from('{"msg":"再実行可能なジョブは0件"}', 'utf8'));
  assert.deepEqual(readJsonFile(file), { msg: '再実行可能なジョブは0件' });
});
