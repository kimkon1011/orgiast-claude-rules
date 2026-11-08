import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAndPersist } from './run-rule-compliance-loop.mjs';

test('runAndPersist は集計結果と履歴スナップショットを更新する', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-comp-test-'));
  try {
    const result = runAndPersist({ home: tmpHome, days: 7 });
    assert.ok(result);

    const statePath = path.join(tmpHome, '.claude', 'rule-compliance-state.json');
    assert.ok(fs.existsSync(statePath));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(state.summary);

    const historyPath = path.join(tmpHome, '.claude', 'compliance-history.json');
    assert.ok(fs.existsSync(historyPath));
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    assert.ok(Array.isArray(history));
    assert.equal(history.length, 1);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
