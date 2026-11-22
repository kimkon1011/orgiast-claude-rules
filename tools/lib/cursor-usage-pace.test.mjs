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
  readOwnerReport,
  findLastGoodFromState,
  hoursAgo,
  ownerReportPath,
  cursorUsagePaceStatePath,
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

test('readOwnerReport は owner-report JSON を読んでパースする', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-owner-'));
  const dir = path.join(home, '.claude', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ownerReportPath(home), JSON.stringify({
    cursorModelsPct: 5, otherModelsPct: 1, onDemandUsed: false, at: '2026-11-21T23:17:00+09:00', by: 'kim',
  }));
  const report = readOwnerReport(home);
  assert.equal(report.cursorModelsPct, 5);
  assert.equal(report.otherModelsPct, 1);
  assert.equal(report.onDemandUsed, false);
  assert.equal(report.at, '2026-11-21T23:17:00+09:00');
  assert.equal(report.by, 'kim');
  // 存在しない場合は null
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-owner-miss-'));
  assert.equal(readOwnerReport(home2), null);
});

test('findLastGoodFromState は lastGood を state から読み出す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-lastgood-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  // lastGood なし → null
  fs.writeFileSync(cursorUsagePaceStatePath(home), JSON.stringify({ fill: false, halt: false }));
  assert.equal(findLastGoodFromState(home), null);
  // lastGood あり → 値を返す
  const lastGood = { cursorModelsPct: 5, otherModelsPct: 1, source: 'owner-report', at: '2026-11-21T23:17:00+09:00' };
  fs.writeFileSync(cursorUsagePaceStatePath(home), JSON.stringify({ fill: false, halt: false, lastGood }));
  const found = findLastGoodFromState(home);
  assert.equal(found.cursorModelsPct, 5);
  assert.equal(found.otherModelsPct, 1);
  assert.equal(found.source, 'owner-report');
  // source=unavailable は無視
  const bad = { cursorModelsPct: 5, otherModelsPct: 1, source: 'unavailable', at: '2026-11-21T23:17:00+09:00' };
  fs.writeFileSync(cursorUsagePaceStatePath(home), JSON.stringify({ fill: false, halt: false, lastGood: bad }));
  assert.equal(findLastGoodFromState(home), null);
});

test('writePaceOutputs は lastGood を state に保存する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-lastgood-write-'));
  const now = Date.parse('2026-11-21T23:17:00+09:00');
  const decided = decideCursorPace({ cursorModelsPct: 5, otherModelsPct: 1, now, ...CYCLE });
  writePaceOutputs(home, { ...decided, now, ...CYCLE, source: 'owner-report' });
  const state = JSON.parse(fs.readFileSync(cursorUsagePaceStatePath(home), 'utf8'));
  assert.ok(state.lastGood);
  assert.equal(state.lastGood.cursorModelsPct, 5);
  assert.equal(state.lastGood.otherModelsPct, 1);
  assert.equal(state.lastGood.source, 'owner-report');
  // source=unavailable では lastGood を維持
  const unknown = decideCursorPace({ now, ...CYCLE });
  writePaceOutputs(home, { ...unknown, now, ...CYCLE, source: 'unavailable' });
  const state2 = JSON.parse(fs.readFileSync(cursorUsagePaceStatePath(home), 'utf8'));
  assert.ok(state2.lastGood);
  assert.equal(state2.lastGood.cursorModelsPct, 5);
});

test('hoursAgo は経過時間を正しく計算する', () => {
  const oneHourAgo = Date.now() - 3_600_000;
  const h = hoursAgo(oneHourAgo);
  assert.ok(h > 0.9 && h < 1.1, `hoursAgo=${h}`);
  const twoDaysAgo = Date.now() - 172_800_000;
  const h2 = hoursAgo(twoDaysAgo);
  assert.ok(h2 > 47 && h2 < 49, `hoursAgo(2d)=${h2}`);
});
