import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addItem, listItems } from './kim-inbox.mjs';
import { scanLostPrompts } from './lost-prompt-scan.mjs';
import { journalPrompt } from './prompt-journal.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-session-dedupe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  return home;
}

test('同じセッションの自動再開不可通知は登録元が違っても1件にまとまる', async t => {
  const home = fixture(t);
  const sessionId = 'session-dedupe-test';
  const dedupeKey = `auto-resume-disabled:${sessionId}`;
  const sources = [
    'auto-progress-auto-resume-disabled',
    'stalled-session-auto-resume-disabled',
    'auto-progress-external-monitor-auto-resume-disabled',
  ];

  for (const source of sources) {
    await addItem(home, {
      kind: 'info', source, sessionId, dedupeKey,
      text: `自動再開は行いません: ${source}`,
    }, { drain: false, localOnly: true });
  }

  const matching = listItems(home).filter(item =>
    ['open', 'seen'].includes(item.status) && item.dedupeKey === dedupeKey);
  assert.equal(matching.length, 1);
});

test('同じセッションの落ちた返答3件はlost-prompt-scanのinfo 1件にまとまる', async t => {
  const home = fixture(t);
  const sessionId = '2076fd36-ae6b-4462-ac35-e6cfc0365caf';
  const at = new Date('2026-11-20T00:00:00Z');

  for (let index = 0; index < 3; index++) {
    journalPrompt({ session_id: sessionId, prompt: `未達の返答 ${index + 1}` }, {
      home, now: new Date(+at + index * 1000),
    });
  }

  assert.equal(await scanLostPrompts({ home, now: +at + 120_000, graceMs: 0 }), 3);
  const matching = listItems(home).filter(item =>
    ['open', 'seen'].includes(item.status) && item.source === 'lost-prompt-scan');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].dedupeKey, `lost-prompt:${sessionId}`);
  assert.match(matching[0].text, /3件:/);
});
