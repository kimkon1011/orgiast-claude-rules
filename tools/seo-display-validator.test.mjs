import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validate } from './seo-display-validator.mjs';

const registryFile = new URL('./mistake-registry/registry.json', import.meta.url);
const boothFile = new URL('../apps/booth-lead/index.html', import.meta.url);

test('booth page runs all SEO-001..006 and UI-001..004 checks', async () => {
  const result = await validate({ file: boothFile, registryFile });
  assert.equal(result.details.length, 10);
  assert.deepEqual(result.details.map(item => item.id), ['SEO-001','SEO-002','SEO-003','SEO-004','SEO-005','SEO-006','UI-001','UI-002','UI-003','UI-004']);
  assert.equal(result.details.find(item => item.id === 'SEO-001').pass, false);
  assert.equal(result.summary.passed, 9);
});

test('known passing document passes every rule', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'x0075-valid-'));
  const file = path.join(dir, 'index.html');
  await writeFile(path.join(dir, 'style.css'), ':root{--tap-size:48px}.btn:focus-visible{outline:2px solid blue}.btn{min-height:48px}', 'utf8');
  await writeFile(file, '<!doctype html><html lang="ja"><head><meta name="description" content="x"><meta name="viewport" content="width=device-width"><title>題名</title><link rel="stylesheet" href="style.css"></head><body><h1>主題</h1><img src="x" alt="説明"><button aria-label="閉じる">&times;</button><div onclick="x()" role="button">操作</div></body></html>', 'utf8');
  assert.equal((await validate({ file, registryFile })).pass, true);
});

test('known failing document reports all rule failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'x0075-invalid-'));
  const file = path.join(dir, 'index.html');
  await writeFile(path.join(dir, 'style.css'), 'button:focus{outline:none} button{height:20px}', 'utf8');
  await writeFile(file, '<html><head><title> </title><link rel="stylesheet" href="style.css"></head><body><img src="x"><button>&times;</button><div onclick="x()">操作</div></body></html>', 'utf8');
  const result = await validate({ file, registryFile });
  assert.equal(result.pass, false);
  assert.equal(result.summary.failed, 10);
});
