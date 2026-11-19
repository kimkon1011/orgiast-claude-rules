import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './event-shop-close-ended.mjs';

const now = new Date('2026-11-19T03:00:00Z');

// A lead with past preferred_date (close candidate)
const pastLead = {
  id: 'past-001',
  company_name: '株式会社サンプル',
  contact_name: '山田太郎',
  email: 'client@example.com',
  event_name: '展示会',
  preferred_date: '2026-10-15',
  created_at: '2026-09-01T03:00:00Z',
  status: 'unread',
  raw_payload: { product: '展示会' },
};

// A lead with declined message (close candidate)
const declinedLead = {
  id: 'declined-001',
  company_name: '株式会社辞退',
  contact_name: '田中花子',
  email: 'declined@example.com',
  event_name: 'イベント',
  preferred_date: '2026-12-15',
  created_at: '2026-11-01T03:00:00Z',
  status: 'replied',
  raw_payload: { product: 'イベント' },
};

// A lead already completed (should be excluded)
const completedLead = {
  id: 'completed-001',
  company_name: '株式会社完了済み',
  contact_name: '佐藤次郎',
  email: 'done@example.com',
  event_name: 'セミナー',
  preferred_date: '2026-10-01',
  created_at: '2026-09-15T03:00:00Z',
  status: 'handled',
  raw_payload: { product: 'セミナー', event_shop: { closed_at: '2026-10-20T01:00:00Z' } },
};

// A lead that is still active (not close candidate)
const activeLead = {
  id: 'active-001',
  company_name: '株式会社進行中',
  contact_name: '鈴木一郎',
  email: 'active@example.com',
  event_name: '展示会',
  preferred_date: '2026-12-20',
  created_at: '2026-11-15T03:00:00Z',
  status: 'unread',
  raw_payload: { product: '展示会' },
};

// Internal/test leads (should be excluded)
const internalLead = {
  id: 'internal-001',
  company_name: '社内テスト',
  contact_name: '内部',
  email: 'someone@orgiast.jp',
  event_name: '社内',
  preferred_date: '2026-10-01',
  created_at: '2026-09-01T03:00:00Z',
  status: 'unread',
  raw_payload: { product: '社内' },
};

// Declined message body
const declinedMessage = (direction, day, body) => ({
  direction,
  received_at: `2026-11-${day}T03:00:00Z`,
  subject: 'Re: お問い合わせ',
  body,
  rfc822_message_id: `<msg-${day}-${direction}>`,
});

test('dry-run: past-date leads are shown as close candidates', async () => {
  // pastLead has preferred_date 2026-10-15 which is past (now is 2026-11-19)
  // No messages → no activeReply → isCloseCandidate returns true (past && !activeReply)
  // declinedLead has future preferred_date + no messages → NOT close candidate
  // completedLead (has closed_at) and internalLead (orgiast.jp email) are excluded
  // activeLead (future preferred_date, no messages) → NOT close candidate
  let callIndex = 0;
  const fetchImpl = async (url, options) => {
    callIndex++;
    if (url.includes('quote_requests?')) {
      return { ok: true, json: async () => [pastLead, declinedLead, completedLead, activeLead, internalLead] };
    }
    if (url.includes('channel_messages?')) {
      return { ok: true, json: async () => [] };
    }
    return { ok: false };
  };

  const output = [];
  const code = await main({
    env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test' },
    now,
    args: [],
    fetchImpl,
    log: s => output.push(s),
  });

  assert.equal(code, 0);
  const tableRows = output.filter(l => l.startsWith('|'));
  // Header + separator + 1 data row (only pastLead)
  assert.equal(tableRows.length, 3, `Expected 3 rows (header + sep + 1 data), got ${tableRows.length}: ${JSON.stringify(tableRows)}`);
  assert.match(tableRows[2], /past-001/);
  assert.match(tableRows[2], /株式会社サンプル/);
  assert.match(tableRows[2], /開催日経過/);
  assert.match(output.join('\n'), /終了候補: 1 件/);
});

test('dry-run: already completed leads are excluded (idempotent)', async () => {
  let callIndex = 0;
  const fetchImpl = async (url, options) => {
    callIndex++;
    if (url.includes('quote_requests?')) {
      // Only return already-completed leads
      return { ok: true, json: async () => [completedLead] };
    }
    return { ok: true, json: async () => [] };
  };

  const output = [];
  const code = await main({
    env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test' },
    now,
    args: [],
    fetchImpl,
    log: s => output.push(s),
  });

  assert.equal(code, 0);
  assert.match(output.join('\n'), /終了候補の案件はありません。/);
});

test('--apply: read-back mismatch treated as failure', async () => {
  let callIndex = 0;
  const fetchImpl = async (url, options) => {
    callIndex++;
    if (url.includes('quote_requests?') && !url.includes('id=eq.')) {
      // Initial fetch
      return { ok: true, json: async () => [pastLead] };
    }
    if (url.includes('channel_messages?')) {
      return { ok: true, json: async () => [] };
    }
    if (options?.method === 'PATCH') {
      return { ok: true, json: async () => null };
    }
    if (url.includes('id=eq.past-001')) {
      // Read-back: return without closed_at (simulating failure)
      return { ok: true, json: async () => [{ ...pastLead }] };
    }
    return { ok: false };
  };

  const output = [];
  const code = await main({
    env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test' },
    now,
    args: ['--apply'],
    fetchImpl,
    log: s => output.push(s),
  });

  assert.equal(code, 1);
  assert.match(output.join('\n'), /read-back不一致/);
  assert.match(output.join('\n'), /失敗 1 件/);
});

test('--apply: successful update reported', async () => {
  let callIndex = 0;
  const fetchImpl = async (url, options) => {
    callIndex++;
    if (url.includes('quote_requests?') && !url.includes('id=eq.')) {
      return { ok: true, json: async () => [pastLead] };
    }
    if (url.includes('channel_messages?')) {
      return { ok: true, json: async () => [] };
    }
    if (options?.method === 'PATCH') {
      return { ok: true, json: async () => null };
    }
    if (url.includes('id=eq.past-001')) {
      // Read-back: return with closed_at set
      return { ok: true, json: async () => [{ ...pastLead, raw_payload: { product: '展示会', event_shop: { closed_at: now.toISOString() } } }] };
    }
    return { ok: false };
  };

  const output = [];
  const code = await main({
    env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test' },
    now,
    args: ['--apply'],
    fetchImpl,
    log: s => output.push(s),
  });

  assert.equal(code, 0);
  assert.match(output.join('\n'), /✅.*past-001.*株式会社サンプル/);
  assert.match(output.join('\n'), /✅ 更新 1 件 \/ ❌ 失敗 0 件/);
});

test('no credentials returns error', async t => {
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs.promises, 'readFile', () => { throw new Error('should not read files'); });
  const output = [];
  const code = await main({
    env: { SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    now,
    args: [],
    fetchImpl: () => { throw new Error('should not be called'); },
    log: s => output.push(s),
  });
  assert.equal(code, 1);
  assert.match(output.join('\n'), /認証情報なし/);
});

test('declined message lead shown as close candidate', async () => {
  let callIndex = 0;
  const fetchImpl = async (url, options) => {
    callIndex++;
    if (url.includes('quote_requests?')) {
      return { ok: true, json: async () => [declinedLead] };
    }
    if (url.includes('channel_messages?')) {
      // Return declined message
      return { ok: true, json: async () => [declinedMessage('inbound', '15', '申し訳ございませんが、今回は辞退させていただきます。')] };
    }
    return { ok: false };
  };

  const output = [];
  const code = await main({
    env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test' },
    now,
    args: [],
    fetchImpl,
    log: s => output.push(s),
  });

  assert.equal(code, 0);
  const tableRows = output.filter(l => l.startsWith('|'));
  // Header + separator + 1 data row = 3
  assert.equal(tableRows.length, 3, `Expected 3 rows (header + sep + 1 data), got ${tableRows.length}`);
  assert.match(tableRows[2], /declined-001/);
  assert.match(tableRows[2], /辞退/);
  assert.match(output.join('\n'), /終了候補: 1 件/);
});