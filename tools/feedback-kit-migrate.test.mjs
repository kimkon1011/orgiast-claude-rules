import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanApps } from './feedback-kit-migrate.mjs';

test('scanApps は gas / next アプリだけを列挙し node_modules と隠しフォルダを無視する', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-scan-'));
  try {
    const w = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    w('gasapp/appsscript.json', '{}');
    w('nextapp/package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    w('plain/package.json', JSON.stringify({ dependencies: { react: '1' } }));
    w('nextapp/node_modules/x/appsscript.json', '{}');
    w('.hidden/appsscript.json', '{}');
    const found = scanApps([root]).map(p => path.basename(p));
    assert.deepEqual(found.sort(), ['gasapp', 'nextapp']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
