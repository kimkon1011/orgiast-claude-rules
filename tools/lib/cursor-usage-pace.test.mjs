import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CYCLE_END,
  DEFAULT_CYCLE_START,
  countCursorAgentRuns,
  decideCursorPace,
  elapsedRatio,
  extractPlanPercents,
  formatPaceLine,
  idealBand,
  isCursorUsageFill,
  writePaceOutputs,
  cursorUsagePaceTxtPath,
} from './cursor-usage-pace.mjs';

const CYCLE = { cycleStart: DEFAULT_CYCLE_START, cycleEnd: DEFAULT_CYCLE_END };

test('11/21 は周期 30 日の約 4 日目で、5%/1% は遅れと判定する', () => {
  const now = Date.parse('2026-11-21T23:17:00+09:00');
  const ratio = elapsedRatio(now, CYCLE);
  assert.ok(ratio > 0.13 && ratio < 0.14, `ratio=${ratio}`);
  const band = idealBand(now, CYCLE);
  assert.ok(band.low > 11 && band.low < 13, `low=${band.low}`);
  assert.ok(band.high > 12 && band.high < 14, `high=${band.high}`);
  const decided = decideCursorPace({ cursorModelsPct: 5, otherModelsPct: 1, now, ...CYCLE });
  assert.equal(decided.decision, 'behind');
  assert.equal(decided.fill, true);
  assert.equal(decided.halt, false);
  const line = formatPaceLine({ ...decided, now, ...CYCLE, source: 'owner-report' });
  assert.match(line, /Cursor Models 5\.0%/);
  assert.match(line, /Other Models 1\.0%/);
  assert.match(line, /判定:遅れ/);
  assert.match(line, /追加回し:する/);
  assert.match(line, /JST/);
});

test('ペース超過なら追加回しをやめ、97%以上なら止めて通知する', () => {
  const now = Date.parse('2026-11-21T23:17:00+09:00');
  const ahead = decideCursorPace({ cursorModelsPct: 20, otherModelsPct: 3, now, ...CYCLE });
  assert.equal(ahead.decision, 'ahead');
  assert.equal(ahead.fill, false);
  const halt = decideCursorPace({ cursorModelsPct: 97, otherModelsPct: 10, now, ...CYCLE });
  assert.equal(halt.decision, 'on_demand_risk');
  assert.equal(halt.halt, true);
  assert.equal(halt.fill, false);
  const demand = decideCursorPace({ cursorModelsPct: 50, otherModelsPct: 10, now, onDemandUsed: true, ...CYCLE });
  assert.equal(demand.halt, true);
});

test('writePaceOutputs は1行ファイルと状態を書き、halt 時だけ通知ファイルを残す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-'));
  const now = Date.parse('2026-11-21T23:17:00+09:00');
  const decided = decideCursorPace({ cursorModelsPct: 5, otherModelsPct: 1, now, ...CYCLE });
  const written = writePaceOutputs(home, { ...decided, now, ...CYCLE, source: 'owner-report' });
  const line = fs.readFileSync(cursorUsagePaceTxtPath(home), 'utf8').trim();
  assert.equal(line.includes('\n'), false);
  assert.equal(line, written.line);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'cursor-usage-pace-state.json')), true);
  assert.equal(written.alert, null);
  assert.equal(isCursorUsageFill(home, {}), true);
  assert.equal(isCursorUsageFill(home, { CURSOR_USAGE_FILL: '1' }), true);
  const halted = decideCursorPace({ cursorModelsPct: 98, otherModelsPct: 1, now, ...CYCLE });
  const alerted = writePaceOutputs(home, { ...halted, now, ...CYCLE, source: 'api' });
  assert.ok(alerted.alert);
  assert.match(fs.readFileSync(alerted.alert, 'utf8'), /従量課金/);
  assert.equal(isCursorUsageFill(home, {}), false);
});

test('extractPlanPercents は dashboard 形式の auto/api を Cursor/Other に写す', () => {
  const extracted = extractPlanPercents({
    planUsage: { autoPercentUsed: 5.0, apiPercentUsed: 1.0 },
  });
  assert.deepEqual(
    { cursorModelsPct: extracted.cursorModelsPct, otherModelsPct: extracted.otherModelsPct },
    { cursorModelsPct: 5, otherModelsPct: 1 },
  );
  assert.equal(extractPlanPercents({ hello: true }), null);
});

test('countCursorAgentRuns は executor-usage と history の cursor 行を数える', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-counts-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'executor-usage.jsonl'), [
    JSON.stringify({ t: '2026-11-21T01:00:00+09:00', provider: 'fallback', model: 'cursor-agent/cursor-agent', status: 'ok' }),
    JSON.stringify({ t: '2026-11-21T02:00:00+09:00', provider: 'codex', model: 'sol', status: 'ok' }),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'fallback-backend-history.jsonl'), JSON.stringify({
    t: '2026-11-21T01:00:00+09:00', backend: 'cursor-agent', outcome: 'ok',
  }) + '\n');
  const since = Date.parse('2026-11-21T00:00:00+09:00');
  const counted = countCursorAgentRuns(home, { sinceMs: since, untilMs: Date.parse('2026-11-22T00:00:00+09:00') });
  assert.equal(counted.ok, 2);
  assert.equal(counted.attempts, 2);
});
