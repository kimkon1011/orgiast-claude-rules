import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDiscordChannelRows, run } from './discord-channel-ledger.mjs';

test('buildDiscordChannelRows resolves categories, types, URLs, and deterministic order', () => {
  const rows = buildDiscordChannelRows([
    { id: '31', name: 'zeta', type: 99, position: 3, parent_id: '10' },
    { id: '2', name: 'general', type: 0, position: 2, parent_id: null },
    { id: '10', name: '開発', type: 4, position: 8, parent_id: null },
    { id: '30', name: 'alpha', type: 15, position: 1, parent_id: '10' },
    { id: '1', name: 'welcome', type: 5, position: 1, parent_id: null },
  ], 'guild', '2026-08-31');
  assert.deepEqual(rows.map((row) => row.id), ['1', '2', '10', '30', '31']);
  assert.equal(rows[2].category, '');
  assert.equal(rows[3].category, '開発');
  assert.equal(rows[3].type, 'フォーラム');
  assert.equal(rows[4].type, 'type:99');
  assert.equal(rows[3].parentId, '10');
  assert.equal(rows[3].url, 'https://discord.com/channels/guild/30');
});

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dcl-'));
  fs.mkdirSync(path.join(home, '.claude', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'tok', 'utf8');
  fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://sheet.example/exec\nFLEET_SHEET_TOKEN=t\n', 'utf8');
  return home;
}

function makeFetch(sheetBodies) {
  const calls = { sheet: 0 };
  const fetchImpl = async (url) => {
    if (String(url).includes('discord.com')) {
      return { status: 200, ok: true, json: async () => [{ id: '1', name: 'general', type: 0, position: 0, parent_id: null }], text: async () => '' };
    }
    calls.sheet += 1;
    const body = sheetBodies[Math.min(calls.sheet, sheetBodies.length) - 1];
    return { status: 200, ok: true, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

test('busy の後に ok なら再送して成功する', async () => {
  const home = makeHome();
  try {
    const { fetchImpl, calls } = makeFetch([{ ok: false, error: 'busy' }, { ok: true, updated: 1, appended: 0 }]);
    const stdout = { out: '', write(s) { this.out += s; } };
    const result = await run([], { fetchImpl, home, stdout, sleepImpl: async () => {} });
    assert.equal(result.posted, true);
    assert.equal(calls.sheet, 2);
    assert.match(stdout.out, /"ok":true/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('busy が続いても例外にせず busy_exhausted を出して終わる', async () => {
  const home = makeHome();
  try {
    const { fetchImpl } = makeFetch([{ ok: false, error: 'busy' }]);
    const stdout = { out: '', write(s) { this.out += s; } };
    const result = await run([], { fetchImpl, home, stdout, sleepImpl: async () => {} });
    assert.equal(result.posted, false);
    assert.equal(result.busyExhausted, true);
    assert.match(stdout.out, /busy_exhausted kind=discord-channels/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
