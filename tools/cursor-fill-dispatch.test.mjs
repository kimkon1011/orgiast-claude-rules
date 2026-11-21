import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CURSOR_FILL_TODO, dispatchCursorFill } from './cursor-fill-dispatch.mjs';
import { cursorFillEnabledPath, cursorFillQueuePath, isCursorUsageFill } from './lib/cursor-usage-pace.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fill-'));
}

test('fill=true なら enabled=1・queue・next-session に CURSOR-FILL を積む', () => {
  const home = tempHome();
  const result = dispatchCursorFill({
    home,
    now: Date.parse('2026-11-22T00:30:00+09:00'),
    state: { fill: true, halt: false, decision: 'behind' },
  });
  assert.equal(result.filled, true);
  assert.equal(fs.readFileSync(cursorFillEnabledPath(home), 'utf8').trim(), '1');
  const queue = fs.readFileSync(cursorFillQueuePath(home), 'utf8').trim();
  assert.match(queue, /nightly-queue/);
  assert.match(queue, /code-improve/);
  const next = fs.readFileSync(path.join(home, '.claude', 'next-session.md'), 'utf8');
  assert.match(next, /\[CURSOR-FILL\]/);
  assert.ok(next.includes(CURSOR_FILL_TODO));
  assert.equal(isCursorUsageFill(home, {}), false); // no state file; use env
  assert.equal(isCursorUsageFill(home, { CURSOR_USAGE_FILL: '1' }), true);
});

test('同じ marker は二重に積まない', () => {
  const home = tempHome();
  dispatchCursorFill({ home, state: { fill: true, halt: false, decision: 'behind' } });
  const again = dispatchCursorFill({ home, state: { fill: true, halt: false, decision: 'behind' } });
  assert.equal(again.todoAppended, false);
  const text = fs.readFileSync(path.join(home, '.claude', 'next-session.md'), 'utf8');
  assert.equal(text.split('[CURSOR-FILL]').length - 1, 1);
});

test('halt または !fill なら enabled=0 で積まない', () => {
  const home = tempHome();
  const halted = dispatchCursorFill({ home, state: { fill: false, halt: true, decision: 'on_demand_risk' } });
  assert.equal(halted.filled, false);
  assert.equal(halted.reason, 'halt');
  assert.equal(fs.readFileSync(cursorFillEnabledPath(home), 'utf8').trim(), '0');
  const off = dispatchCursorFill({ home, state: { fill: false, halt: false, decision: 'ahead' } });
  assert.equal(off.reason, 'not-fill');
  assert.equal(fs.existsSync(cursorFillQueuePath(home)), false);
});
