import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { playbookContext } from './playbook-inject.mjs';
test('prompt・直前の応答・別名から実測手順を注入する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'playbooks'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MacroDroid.md'), '---\naliases: [マクロドロイド]\n---\n実測の本文');
  const transcript_path = path.join(home, 't.jsonl'); fs.writeFileSync(transcript_path, JSON.stringify({ type: 'assistant', message: { content: 'MacroDroid で操作' } }));
  for (const input of [{ prompt: 'MacroDroid で WeChat 転送したい' }, { prompt: 'この次は？', transcript_path }, { prompt: 'マクロドロイド' }]) {
    const result = spawnSync(process.execPath, ['tools/playbook-inject.mjs'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } });
    assert.equal(result.status, 0, result.stderr); const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /\[PLAYBOOK:MacroDroid\]/); assert.match(ctx, /実測の本文/);
  }
  assert.equal(playbookContext({ prompt: '関係なし' }, home), '');
  fs.writeFileSync(path.join(dir, 'X.md'), 'x'); assert.equal(playbookContext({ prompt: 'XYZ' }, home), '');
  fs.writeFileSync(path.join(dir, 'Aaa.md'), 'あ'.repeat(7000)); fs.writeFileSync(path.join(dir, 'Bbb.md'), 'b');
  const ctx = playbookContext({ prompt: 'Aaa Bbb MacroDroid' }, home);
  assert.equal((ctx.match(/\[PLAYBOOK:/g) || []).length, 2); assert.match(ctx, /続きは .*Aaa.md を Read/); assert.ok(!ctx.includes('あ'.repeat(6001)));
});
