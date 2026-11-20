import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mirrorKeyFiles, KEY_FILE_MIRRORS } from './onboarding-sync.mjs';

// Dummy fixtures only.
test('gemini.env from keyserve is merged into ~/.gemini/.env, keeping local keys', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-test-'));
  try {
    assert.deepEqual(KEY_FILE_MIRRORS['gemini.env'], ['.gemini', '.env']);
    assert.deepEqual(mirrorKeyFiles(home, { 'gemini.env': 'GEMINI_API_KEY=dummy-1\n' }), ['.gemini/.env']);
    assert.match(fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf8'), /GEMINI_API_KEY=dummy-1/);
    fs.writeFileSync(path.join(home, '.gemini', '.env'), 'GEMINI_API_KEY=old\nGEMINI_CLI_TRUST_WORKSPACE=true\n');
    mirrorKeyFiles(home, { 'gemini.env': 'GEMINI_API_KEY=dummy-2\n' });
    const text = fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf8');
    assert.match(text, /GEMINI_API_KEY=dummy-2/);
    assert.match(text, /GEMINI_CLI_TRUST_WORKSPACE=true/);
    assert.deepEqual(mirrorKeyFiles(home, { 'gemini.env': 'GEMINI_API_KEY=dummy-2\n' }), []);
    assert.deepEqual(mirrorKeyFiles(home, { 'groq.env': 'GROQ_API_KEY=x\n' }), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
