import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
test('report hook distinguishes valid, invalid, partial, unrelated, symlink and FIFO inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-report-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    const dir = path.join(root, 'samples/booth-event/reports');
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(root, 'tools/check.mjs');
    fs.copyFileSync(new URL('./booth-event-report-check.mjs', import.meta.url), script);
    const file = path.join(dir, 'report.json');
    const runEvent = event => {
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8', input: JSON.stringify(event), timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim() ? JSON.parse(result.stdout) : null;
    };
    const run = (filePath = file, tool = 'Write') => runEvent({ hook_event_name: 'PostToolUse', tool_name: tool, cwd: root, tool_input: { file_path: filePath } });
    for (const event of [null, [], {}, { hook_event_name: 'SessionStart' }]) assert.equal(runEvent(event), null);
    assert.equal(runEvent({ hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: {}, tool_input: { file_path: 'unrelated.json' } }), null);
    fs.copyFileSync(new URL('../samples/booth-event/reports/sample-v1.json', import.meta.url), file);
    assert.equal(run(), null);
    fs.writeFileSync(file, JSON.stringify({sample:'sample-v1', findings:[], unconfirmed:[]}));
    assert.equal(run().decision, 'block');
    fs.writeFileSync(file, '{');
    assert.equal(run().decision, 'block');
    assert.equal(run(path.join(root, 'unrelated.json')), null);
    assert.equal(run(file, 'Read'), null);
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(root, 'outside.json'), file);
    fs.writeFileSync(path.join(root, 'outside.json'), '{}');
    assert.equal(run().decision, 'block');
    fs.unlinkSync(file);
    const fifo = spawnSync('mkfifo', [file], { encoding: 'utf8', timeout: 5000 });
    assert.equal(fifo.status, 0, fifo.stderr);
    assert.equal(run().decision, 'block');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
