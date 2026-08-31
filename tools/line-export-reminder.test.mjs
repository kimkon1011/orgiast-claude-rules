import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from './line-export-reminder.mjs';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-08-28T00:00:00.000Z');

function fixture(ageDays = null, sentAgeDays = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'line-reminder-'));
  const dir = path.join(home, '.claude', 'line-openchat');
  fs.mkdirSync(dir, { recursive: true });
  if (ageDays !== null) {
    const ts = NOW.getTime() - ageDays * DAY_MS;
    const record = { id: '1', chat: 'テスト', sender: 'kim', text: '本文', ts, receivedAt: new Date(ts + 1000).toISOString() };
    fs.writeFileSync(path.join(dir, '2026-08.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  }
  if (sentAgeDays !== null) {
    fs.writeFileSync(path.join(dir, 'reminder-state.json'), JSON.stringify({ sentAt: new Date(NOW.getTime() - sentAgeDays * DAY_MS).toISOString() }));
  }
  return home;
}

async function run({ ageDays = null, sentAgeDays = null, dryRun = true } = {}) {
  const home = fixture(ageDays, sentAgeDays);
  const messages = [];
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await main(dryRun ? ['--dry-run'] : [], { home, now: NOW, sendDm: async ({ message }) => messages.push(message) });
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { output: writes.join(''), messages };
}

test('jsonl無しは未取り込みの文面', async () => {
  const { output } = await run();
  assert.match(output, /まだ1件もありません/);
  assert.match(output, /line-setup/);
});

test('最新tsが3日前なら送らない', async () => {
  const { output } = await run({ ageDays: 3 });
  assert.match(output, /3日前のため送らない/);
});

test('8日前は通常の催促', async () => {
  const { output } = await run({ ageDays: 8 });
  assert.match(output, /取り込みが 8 日空きました/);
  assert.doesNotMatch(output, /🔴/);
});

test('20日前は強い催促', async () => {
  const { output } = await run({ ageDays: 20 });
  assert.match(output, /🔴 LINEの取り込みが 20 日/);
});

test('前回送信から2日後は送らない', async () => {
  const { output, messages } = await run({ ageDays: 8, sentAgeDays: 2, dryRun: false });
  assert.match(output, /3日以内のため送らない/);
  assert.equal(messages.length, 0);
});

test('前回送信から4日後は送る', async () => {
  const { output, messages } = await run({ ageDays: 8, sentAgeDays: 4, dryRun: false });
  assert.match(output, /Discord DMを送信しました/);
  assert.equal(messages.length, 1);
});
