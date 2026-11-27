import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generate, loadRegistry } from './mistake-to-rule.mjs';

const registryFile = new URL('./mistake-registry/registry.json', import.meta.url);

test('registry.json loads ten seed mistakes', async () => {
  const registry = await loadRegistry(registryFile);
  assert.equal(registry.version, 1);
  assert.equal(registry.mistakes.length, 10);
});

test('generation includes every mistake ID and refuses overwrite', async () => {
  const registry = await loadRegistry(registryFile);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'x0075-rules-'));
  const outputs = await generate(registry, dir);
  assert.equal(outputs.length, 20);
  const contents = await Promise.all(outputs.map(file => readFile(file, 'utf8')));
  for (const mistake of registry.mistakes) assert.ok(contents.some(content => content.includes(mistake.id)));
  await assert.rejects(() => generate(registry, dir), error => error.code === 'EEXIST');
});

test('empty registry generates no files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'x0075-empty-'));
  assert.deepEqual(await generate({ version: 1, mistakes: [] }, dir), []);
});
