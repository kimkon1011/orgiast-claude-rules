import './secretary-progress/tests/watches.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

test('reviewed deployment payload matches its manifest byte for byte', () => {
  const root = new URL('./secretary-progress/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));
  for (const file of manifest.files) {
    assert.match(file.path, /^(?:app|components|lib|tests)\/|^start-prod\.vbs$/);
    assert.ok(!file.path.includes('..'));
    assert.equal(createHash('sha256').update(fs.readFileSync(new URL(file.path, root))).digest('hex'), file.after);
  }
  assert.equal(manifest.files.length, 7);
});
