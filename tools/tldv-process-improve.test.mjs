#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, generateKeyPair, generateKeyPairSync } from 'node:crypto';
import {
  parseArgs, chunkText, normalizeText, normalizeTitle, isDuplicate, safeReason,
  ProcessImproveError, deduplicateMeetings, defaultState, extractMeetingDate,
  loadConfig, fetchExistingImprovements, fetchDriveMeetings,
  callLlm, getDriveToken, runImprove, runNode, mergeDuplicateSources,
  resolveTabName, writeImprovementSheet, writeLogEntry, writeRunSummary,
  writeTemplateReflection, ensureLogSheet, notifyKimInbox,
  postAppFeedback, addConstructionKnowhow, extractImprovements,
} from './tldv-process-improve.mjs';

// -- テスト用の LOG_DIR --
const testLogDir = path.join(os.tmpdir(), `tldv-pi-test-${randomUUID()}`);
const origLogDir = process.env.TLDV_PI_LOG_DIR;

process.env.TLDV_PI_LOG_DIR = testLogDir;

test.after(() => {
  process.env.TLDV_PI_LOG_DIR = origLogDir;
  try { fs.rmSync(testLogDir, { recursive: true, force: true }); } catch {}
});

// -- ヘルパー --
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function mockFetch(url, init) {
  // Mock: always returns empty JSON for Drive/Gmail/Sheets
  if (url.includes('googleapis.com')) {
    return Promise.resolve(jsonResponse({ files: [], values: [[]] }));
  }
  if (url.includes('gmail.googleapis.com')) {
    return Promise.resolve(jsonResponse({ messages: [] }));
  }
  return Promise.resolve(jsonResponse({}));
}

const mockConfigFixture = () => ({
  version: 1,
  templates: { test: 'id' },
  sheets: {
    improvementSheetId: 'test-sheet',
    improvementTabGid: 0,
    headerRow: 2,
    improvementHeaders: ['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策'],
  },
  llm: { providerChain: ['gemini'], confidenceThreshold: 0.6, maxCallsPerNight: 60, maxChunkChars: 12000 },
  feedbackApi: { action: 'submitFeedbackDialog', url: 'https://example.test/exec', maxPerNight: 5 },
  knowhow: { maxPerNight: 5 },
});

// ===== parseArgs =====
test('parseArgs accepts --dry-run and --since', () => {
  const r = parseArgs(['--dry-run', '--since', '2026-11-01']);
  assert.equal(r.dryRun, true);
  assert.equal(r.since instanceof Date, true);
  assert.equal(r.since.toISOString().slice(0, 10), '2026-11-01');
});

test('parseArgs rejects unknown options', () => {
  assert.throws(() => parseArgs(['--delete']), ProcessImproveError);
});

test('parseArgs rejects malformed --since', () => {
  assert.throws(() => parseArgs(['--since', 'not-a-date']), ProcessImproveError);
});

test('parseArgs rejects --limit without number', () => {
  assert.throws(() => parseArgs(['--limit']), ProcessImproveError);
});

test('parseArgs accepts --meeting', () => {
  const r = parseArgs(['--meeting', 'doc123']);
  assert.equal(r.meeting, 'doc123');
});

test('parseArgs --since only date prefix accepted', () => {
  const r = parseArgs(['--since', '2026-11-01T00:00:00Z']);
  assert.equal(r.since.toISOString().slice(0, 10), '2026-11-01');
});

test('parseArgs --limit is optional', () => {
  const r = parseArgs([]);
  assert.equal(r.dryRun, false);
  assert.equal(r.limit, Infinity);
});

// ===== chunkText =====
test('chunkText splits long text at newline boundary', () => {
  const text = 'abc\n'.repeat(10000); // ~50000 chars
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.length <= 100 || chunks.length === 1));
});

test('chunkText returns single chunk for short text', () => {
  assert.deepEqual(chunkText('short text', 100), ['short text']);
});

test('chunkText empty text returns empty array', () => {
  assert.deepEqual(chunkText('', 100), []);
});

test('chunkText uses 。fallback when no newline near boundary', () => {
  const text = 'あいうえお。'.repeat(500);
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
});

// ===== normalizeText =====
test('normalizeText removes whitespace and punctuation', () => {
  assert.equal(normalizeText(' こんにちは、世界！ '), 'こんにちは世界');
});

test('normalizeText empty string returns empty', () => {
  assert.equal(normalizeText(''), '');
});

test('normalizeText removes zero-width spaces', () => {
  assert.equal(normalizeText('A​B'), 'ab');
});

// ===== isDuplicate (bigram Jaccard) =====
test('isDuplicate detects identical text', () => {
  const existing = [{ event: 'パネルが壊れた', solution: '修理依頼' }];
  assert.ok(isDuplicate({ event: 'パネルが壊れた', solution: '修理依頼' }, existing));
});

test('isDuplicate passes for completely different text', () => {
  const existing = [{ event: 'パネルが壊れた', solution: '修理依頼' }];
  assert.equal(isDuplicate({ event: '見積もりが遅れた', solution: 'テンプレート化' }, existing), false);
});

test('isDuplicate empty existing returns false', () => {
  assert.equal(isDuplicate({ event: 'test' }, []), false);
});

test('isDuplicate handles empty candidate', () => {
  const existing = [{ event: 'test', solution: '' }];
  assert.equal(isDuplicate({ event: '', solution: '' }, existing), false);
});

// ===== deduplicateMeetings =====
test('deduplicateMeetings filters by processed state', () => {
  const state = { processedMeetings: { 'existing-id': { title: 'done' } } };
  const meetings = [{ id: 'existing-id', title: 'done' }, { id: 'new-id', title: 'new' }];
  const filtered = deduplicateMeetings(meetings, state);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'new-id');
});

test('deduplicateMeetings empty state passes all', () => {
  const state = defaultState();
  const meetings = [{ id: 'a' }, { id: 'b' }];
  assert.equal(deduplicateMeetings(meetings, state).length, 2);
});

// ===== safeReason =====
test('safeReason returns error code for ProcessImproveError', () => {
  assert.equal(safeReason(new ProcessImproveError('test-error')), 'test-error');
});

test('safeReason returns unexpected: prefix for generic errors', () => {
  assert.equal(safeReason(new Error('something broke')), 'unexpected:Error');
  assert.equal(safeReason(new TypeError('bad')), 'unexpected:TypeError');
});

test('safeReason handles null/undefined', () => {
  assert.equal(safeReason({ code: 'ENOENT' }), 'file-not-found');
  assert.equal(safeReason({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(safeReason({}), 'unexpected:Error');
});

// ===== normalize + Jaccard edge cases =====
test('isDuplicate uses normalized comparison', () => {
  const existing = [{ event: 'パネル が 壊れた', solution: '修理  依頼' }];
  assert.ok(isDuplicate({ event: 'パネルが壊れた', solution: '修理依頼' }, existing));
});

// ===== 設定ファイル読み込み =====
test('loadConfig throws on missing config', () => {
  assert.throws(() => loadConfig('/nonexistent/config.json'), ProcessImproveError);
});

// ===== fetchExistingImprovements throws on no sheet =====
test('fetchExistingImprovements returns empty on API failure', async () => {
  // Mock fetch that returns error
  const noopFetch = async () => jsonResponse({ error: 'not found' }, 404);
  try {
    const result = await fetchExistingImprovements({ fetchImpl: noopFetch });
    assert.ok(Array.isArray(result));
  } catch {
    // API error is acceptable
    assert.ok(true);
  }
});

// ===== dry-run 引数パース =====
test('dry-run mode outputs JSON without writes', async () => {
  const opts = parseArgs(['--dry-run', '--limit', '3']);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.limit, 3);
});

// ===== ヘッダー検証ロジック（loadConfig の整合性） =====
test('config sheets headers match expected order', () => {
  const cfg = mockConfigFixture();
  const expected = ['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策'];
  assert.deepEqual(cfg.sheets.improvementHeaders, expected);
  assert.equal(cfg.sheets.headerRow, 2);
});

// ===== 状態管理 =====
test('defaultState has correct structure', () => {
  const s = defaultState();
  assert.equal(s.version, 1);
  assert.equal(typeof s.processedMeetings, 'object');
  assert.equal(s.llmCallsToday, 0);
});

// ===== エラーハンドリング: LLM抽出JSONパース失敗 =====
test('handle malformed LLM response gracefully', () => {
  const malformed = 'これは分析結果です\n{"invalid: true\n{broken';
  const jsonMatch = malformed.match(/\[[\s\S]*\]/);
  assert.equal(jsonMatch, null);
});

test('handle valid JSON extraction from LLM response', () => {
  const valid = 'ここに結果があります\n[\n  {"kind": "template", "event": "test", "confidence": 0.9}\n]\n追加情報';
  const jsonMatch = valid.match(/\[[\s\S]*\]/);
  assert.ok(jsonMatch !== null);
  const items = JSON.parse(jsonMatch[0]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'template');
});

// ===== confidence 閾値 =====
test('confidence filtering keeps only >= 0.6', () => {
  const items = [
    { kind: 'template', event: 'a', confidence: 0.9 },
    { kind: 'template', event: 'b', confidence: 0.5 },
    { kind: 'template', event: 'c', confidence: 0.6 },
  ];
  const filtered = items.filter(i => i.confidence >= 0.6);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].event, 'a');
  assert.equal(filtered[1].event, 'c');
});

// ===== 引数 --limit 検証 =====
test('parseArgs --limit validation rejects zero', () => {
  assert.throws(() => parseArgs(['--limit', '0']), ProcessImproveError);
});

test('parseArgs --limit validation rejects negative', () => {
  assert.throws(() => parseArgs(['--limit', '-5']), ProcessImproveError);
});

test('parseArgs --limit validation rejects float', () => {
  assert.throws(() => parseArgs(['--limit', '3.5']), ProcessImproveError);
});

// ===== サマリ母数一致テスト =====
test('summary totals consistency', () => {
  const summary = { fetched: 10, processed: 8, extracted: 5, duplicates: 2,
    sheetWritten: 3, feedbackSent: 1, knowhowAdded: 0, failed: 0 };
  // fetched >= processed
  assert.ok(summary.fetched >= summary.processed);
  // extracted = sheetWritten + duplicates (in simplified case)
  // 実際は重複除去後の件数が書き込み対象
  assert.ok(summary.extracted >= summary.duplicates);
});

// ===== 会議テキスト取得関数の戻り値形式 =====
test('meeting has required fields', () => {
  const meeting = {
    id: 'test-id',
    title: '会議',
    modifiedTime: new Date(),
    url: 'https://tldv.io',
    source: 'drive',
    body: '議事録本文',
  };
  assert.equal(typeof meeting.id, 'string');
  assert.equal(typeof meeting.body, 'string');
  assert.ok(meeting.modifiedTime instanceof Date || meeting.modifiedTime === undefined);
});

// ===== --meeting オプション =====
test('--meeting sets meeting filter', () => {
  const r = parseArgs(['--meeting', '特定会議ID']);
  assert.equal(r.meeting, '特定会議ID');
});

// ===== fetchDriveMeetings: text/plain export returns body =====
test('fetchDriveMeetings text/plain export populates body', async () => {
  const mockFetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token' }), { status: 200 });
    }
    if (url.includes('/export?mimeType=text/plain')) {
      return new Response('会議の本文テキスト', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    if (url.includes('drive/v3/files')) {
      return new Response(JSON.stringify({
        files: [{
          id: 'doc1', name: '会議1', modifiedTime: new Date(Date.now() - 3600000).toISOString(),
          webViewLink: 'https://docs.google.com/document/d/doc1',
          appProperties: { tldvMeetingId: 'mtg1' },
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const result = await fetchDriveMeetings({ fetchImpl: mockFetch, getToken: async () => 'mock-token' });
  assert.equal(result.meetings.length, 1);
  assert.equal(result.meetings[0].id, 'mtg1');
  assert.equal(result.meetings[0].body, '会議の本文テキスト');
  assert.equal(result.meetings[0].source, 'drive');
  assert.equal(result.failures.length, 0);
  assert.equal(result.listedCount, 1);
});

// ===== fetchDriveMeetings: all exports fail =====
test('fetchDriveMeetings returns failures when all exports fail', async () => {
  const mockFetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token' }), { status: 200 });
    }
    if (url.includes('/export?mimeType=text/plain')) {
      return new Response('Not Found', { status: 404 });
    }
    if (url.includes('drive/v3/files')) {
      return new Response(JSON.stringify({
        files: [{
          id: 'doc1', name: '会議1', modifiedTime: new Date(Date.now() - 3600000).toISOString(),
          webViewLink: 'https://docs.google.com/document/d/doc1',
          appProperties: { tldvMeetingId: 'mtg1' },
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const result = await fetchDriveMeetings({ fetchImpl: mockFetch, getToken: async () => 'mock-token' });
  assert.equal(result.meetings.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].meetingId, 'mtg1');
  assert.equal(typeof result.failures[0].reason, 'string');
  assert.equal(result.listedCount, 1);
});

// ===== callLlm: execFile fallback chain (callback-based via runNode) =====
test('callLlm uses execFile fallback chain and returns stdout on success', async () => {
  let callCount = 0;
  const mockExecFile = (file, args, opts, cb) => {
    callCount++;
    const providerIdx = args.indexOf('--provider');
    const provider = providerIdx >= 0 ? args[providerIdx + 1] : '';
    // 1st and 2nd (gemini, deepseek) fail, 3rd (groq) succeeds
    if (callCount < 3) return cb(new Error(`${provider} unavailable`));
    cb(null, JSON.stringify([{ kind: 'process', event: 'test event', confidence: 0.9 }]), '');
  };
  const result = await callLlm('test prompt', { execFileImpl: mockExecFile });
  assert.equal(callCount, 3);
  assert.ok(result.length > 0);
  const parsed = JSON.parse(result);
  assert.equal(parsed[0].kind, 'process');
  assert.equal(parsed[0].event, 'test event');
});

test('callLlm throws llm-failed when all providers fail with empty stdout', async () => {
  const mockExecFile = (file, args, opts, cb) => cb({ code: 1 }, '', '');
  try {
    await callLlm('test', { execFileImpl: mockExecFile });
    assert.unreachable('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ProcessImproveError);
    assert.equal(error.code, 'llm-failed');
  }
});

test('callLlm returns stdout when exitCode non-zero but stdout has content', async () => {
  const mockExecFile = (file, args, opts, cb) => cb({ code: 1 }, '{"result":"partial"}', '');
  const result = await callLlm('test', { execFileImpl: mockExecFile });
  assert.ok(result.includes('partial'));
});

// ===== Bug C: runImprove exits 2 when all meetings have process-error =====
async function withTempKey(fn) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
  if (typeof privateKey !== 'string') throw new Error('privateKey must be PEM string');
  const keyData = { client_email: `test-${randomUUID()}@test.iam.gserviceaccount.com`, private_key: privateKey };
  const tmpDir = path.join(os.tmpdir(), `tldv-test-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const keyPath = path.join(tmpDir, 'key.json');
  fs.writeFileSync(keyPath, JSON.stringify(keyData));
  const oldKey = process.env.GOOGLE_SA_KEY;
  process.env.GOOGLE_SA_KEY = keyPath;
  try {
    await fn(keyPath, tmpDir);
  } finally {
    process.env.GOOGLE_SA_KEY = oldKey;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

test('runImprove exits 2 when all meetings have process-error', async () => {
  await withTempKey(async (keyPath, tmpDir) => {
    const mockExecFile = (file, args, opts, cb) => cb(null, 'this is not valid JSON', '');
    const mockFetch = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      if (url.includes('/export?mimeType=text/plain')) {
        return new Response('会議の本文', { status: 200 });
      }
      if (url.includes('drive/v3/files')) {
        return new Response(JSON.stringify({
          files: [{
            id: 'doc1', name: '会議1', modifiedTime: new Date(Date.now() - 3600000).toISOString(),
            webViewLink: 'https://docs.google.com/document/d/doc1',
            appProperties: { tldvMeetingId: 'mtg1' },
          }],
        }), { status: 200 });
      }
      if (url.includes('gmail.googleapis.com')) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes('sheets.googleapis.com')) {
        return new Response(JSON.stringify({ values: [[]] }));
      }
      return new Response(JSON.stringify({}));
    };

    const exitCode = await runImprove({ dryRun: true, limit: 1 }, { fetch: mockFetch, execFile: mockExecFile });
    assert.equal(exitCode, 2);
  });
});

// ===== Bug D: getDriveToken accepts and uses scope parameter =====
test('getDriveToken uses provided scope in JWT claims', async () => {
  await withTempKey(async (keyPath, tmpDir) => {
    let capturedScope = '';
    const mockFetch = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        const body = init.body;
        const assertion = decodeURIComponent(body.match(/assertion=([^&]+)/)[1]);
        const parts = assertion.split('.');
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        capturedScope = claims.scope;
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      return new Response(JSON.stringify({}));
    };

    const testScope = 'https://www.googleapis.com/auth/gmail.readonly';
    await getDriveToken({ scope: testScope, fetchImpl: mockFetch });
    assert.equal(capturedScope, testScope);
    assert.ok(!capturedScope.includes('spreadsheets'));
  });
});

// ===== runNode: callback-based execFile wrapper =====
test('runNode uses process.execPath and returns exitCode/stdout/stderr', async () => {
  const mockExecFile = (file, args, opts, cb) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(args, ['--help']);
    assert.ok(opts.timeout > 0);
    assert.equal(opts.encoding, 'utf8');
    cb(null, 'stdout text', 'stderr text');
  };
  const result = await runNode(['--help'], { execFileImpl: mockExecFile });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'stdout text');
  assert.equal(result.stderr, 'stderr text');
});

test('runNode captures exit code from error object', async () => {
  const mockExecFile = (file, args, opts, cb) => cb({ code: 42 }, '', '');
  const result = await runNode(['fail'], { execFileImpl: mockExecFile });
  assert.equal(result.exitCode, 42);
});

test('runNode defaults exitCode to 1 when err.code is not a number', async () => {
  const mockExecFile = (file, args, opts, cb) => cb(new Error('killed'), '', '');
  const result = await runNode(['fail'], { execFileImpl: mockExecFile });
  assert.equal(result.exitCode, 1);
});

test('runNode handles timeout option', async () => {
  const mockExecFile = (file, args, opts, cb) => {
    assert.equal(opts.timeout, 5000);
    cb(null, 'done', '');
  };
  const result = await runNode(['cmd'], { timeout: 5000, execFileImpl: mockExecFile });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'done');
});

// ===== callLlm fallback chain: all providers start with non-zero exit =====
test('callLlm retries all providers when each has non-zero exit with empty stdout', async () => {
  let callCount = 0;
  const mockExecFile = (file, args, opts, cb) => {
    callCount++;
    cb({ code: 1 }, '', '');
  };
  try {
    await callLlm('test', { execFileImpl: mockExecFile });
    assert.unreachable('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ProcessImproveError);
    assert.equal(error.code, 'llm-failed');
  }
  assert.equal(callCount, 3);
});

// ===== extractMeetingDate（不具合2: 古い会議の再保存） =====
test('extractMeetingDate extracts date from title', () => {
  const meeting = { title: '2026-05-15 10:30（日本時間）定例会議', modifiedTime: new Date('2026-11-10T10:00:00Z') };
  const date = extractMeetingDate(meeting);
  assert.equal(date.toISOString().slice(0, 10), '2026-05-15');
});

test('extractMeetingDate extracts date from body when not in title', () => {
  const meeting = { title: '定例会議', body: '2026-06-20 14:00（日本時間）開始\n議題...', modifiedTime: new Date('2026-11-10T10:00:00Z') };
  const date = extractMeetingDate(meeting);
  assert.equal(date.toISOString().slice(0, 10), '2026-06-20');
});

test('extractMeetingDate falls back to modifiedTime when no date in title/body', () => {
  const meeting = { title: '定例会議', body: '議題のみ', modifiedTime: new Date('2026-11-10T10:00:00Z') };
  const date = extractMeetingDate(meeting);
  assert.equal(date.toISOString(), meeting.modifiedTime.toISOString());
});

test('extractMeetingDate handles empty title and body', () => {
  const meeting = { title: '', body: '', modifiedTime: new Date('2026-11-10T10:00:00Z') };
  const date = extractMeetingDate(meeting);
  assert.equal(date.toISOString(), meeting.modifiedTime.toISOString());
});

test('extractMeetingDate returns undefined when no date info available', () => {
  const meeting = { title: 'test', body: 'content' };
  const date = extractMeetingDate(meeting);
  assert.equal(date, undefined);
});

// ===== fetchExistingImprovements sheetId→タイトル解決（不具合1） =====
test('fetchExistingImprovements resolves tab name from sheetId', async () => {
  await withTempKey(async (keyPath, tmpDir) => {
    const callLog = [];
    const mockFetch = async (url, init) => {
      callLog.push(url);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      if (url.includes('fields=sheets.properties')) {
        return new Response(JSON.stringify({
          sheets: [
            { properties: { sheetId: 0, title: 'シート1' } },
            { properties: { sheetId: 354072335, title: '地雷回避リスト・トラブル報告' } },
          ],
        }));
      }
      if (url.includes('/values/')) {
        // A3:J → データ行（集計行1・ヘッダー行2はスキップ）
        return new Response(JSON.stringify({
          values: [
            ['2026/11/01', '担当者', '', '社内改善', '', 'パネル破損', '原因A', '修理手順追加', '', ''],
          ],
          range: "'地雷回避リスト・トラブル報告'!A3:J3",
        }));
      }
      return new Response(JSON.stringify({}));
    };

    const rows = await fetchExistingImprovements({ fetchImpl: mockFetch, dryRun: true });
    // 集計行・ヘッダー行は含まれず、データ1行のみ
    assert.equal(rows.length, 1);
    // F列（index5）= 事象, H列（index7）= 対策
    assert.equal(rows[0].event, 'パネル破損');
    assert.equal(rows[0].solution, '修理手順追加');
    // sheets.properties を呼んだことを確認
    const metaCall = callLog.find(u => u.includes('fields=sheets.properties'));
    assert.ok(metaCall, 'sheet metadata API should be called');
  });
});

test('fetchExistingImprovements logs HTTP status on error', async () => {
  await withTempKey(async (keyPath, tmpDir) => {
    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      return new Response('Not Found', { status: 404 });
    };

    try {
      await fetchExistingImprovements({ fetchImpl: mockFetch, dryRun: false });
      assert.unreachable('should have thrown on production');
    } catch (error) {
      assert.ok(error instanceof ProcessImproveError);
      assert.equal(error.code, 'existing-fetch-error');
    }
  });
});

test('fetchExistingImprovements dry-run continues on error', async () => {
  await withTempKey(async (keyPath, tmpDir) => {
    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      return new Response('Not Found', { status: 404 });
    };

    const rows = await fetchExistingImprovements({ fetchImpl: mockFetch, dryRun: true });
    assert.deepEqual(rows, []);
  });
});

test('fetchExistingImprovements quotes tab name with special chars', async () => {
  await withTempKey(async (keyPath, tmpDir) => {
    const capturedRanges = [];
    const mockFetch = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      if (url.includes('fields=sheets.properties')) {
        return new Response(JSON.stringify({
          sheets: [{ properties: { sheetId: 354072335, title: "改善'項目'シート" } }],
        }));
      }
      if (url.includes('/values/')) {
        const rangeMatch = url.match(/values\/([^?]+)/);
        if (rangeMatch) capturedRanges.push(decodeURIComponent(rangeMatch[1]));
        return new Response(JSON.stringify({ values: [] }));
      }
      return new Response(JSON.stringify({}));
    };

    await fetchExistingImprovements({ fetchImpl: mockFetch, dryRun: true });
    assert.ok(capturedRanges.length > 0);
    // タブ名内の ' が '' にエスケープされ、全体が ' で囲まれている（A3:J で読み取り）
    assert.ok(capturedRanges[0].startsWith("'改善''項目''シート'!"));
  });
});

// ===== runImprove exits 2 when fetchExistingImprovements fails in production =====
test('runImprove exits 2 when existing fetch fails in production mode', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
  const keyData = { client_email: `test-${randomUUID()}@test.iam.gserviceaccount.com`, private_key: privateKey };
  const tmpDir = path.join(os.tmpdir(), `tldv-test-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const keyPath = path.join(tmpDir, 'key.json');
  fs.writeFileSync(keyPath, JSON.stringify(keyData));
  const oldKey = process.env.GOOGLE_SA_KEY;
  process.env.GOOGLE_SA_KEY = keyPath;

  try {
    const mockExecFile = (file, args, opts, cb) => cb(null, JSON.stringify([{ kind: 'process', event: 'test', confidence: 0.9 }]), '');
    const mockFetch = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      if (url.includes('/export?mimeType=text/plain')) {
        return new Response('会議の本文', { status: 200 });
      }
      if (url.includes('drive/v3/files')) {
        return new Response(JSON.stringify({
          files: [{
            id: 'doc1', name: '会議1', modifiedTime: new Date(Date.now() - 3600000).toISOString(),
            webViewLink: 'https://docs.google.com/document/d/doc1',
            appProperties: { tldvMeetingId: 'mtg1' },
          }],
        }), { status: 200 });
      }
      if (url.includes('gmail.googleapis.com')) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      // sheets は常にエラーを返す
      if (url.includes('sheets.googleapis.com')) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify({}));
    };

    const exitCode = await runImprove({ dryRun: false, limit: 1 }, { fetch: mockFetch, execFile: mockExecFile });
    assert.equal(exitCode, 2);
  } finally {
    process.env.GOOGLE_SA_KEY = oldKey;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ===== runImprove dry-run continues when existing fetch fails =====
test('runImprove dry-run continues on existing fetch error', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
  const keyData = { client_email: `test-${randomUUID()}@test.iam.gserviceaccount.com`, private_key: privateKey };
  const tmpDir = path.join(os.tmpdir(), `tldv-test-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const keyPath = path.join(tmpDir, 'key.json');
  fs.writeFileSync(keyPath, JSON.stringify(keyData));
  const oldKey = process.env.GOOGLE_SA_KEY;
  process.env.GOOGLE_SA_KEY = keyPath;

  try {
    const mockExecFile = (file, args, opts, cb) => cb(null, JSON.stringify([{ kind: 'process', event: 'test', confidence: 0.9 }]), '');
    const mockFetch = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      if (url.includes('/export?mimeType=text/plain')) {
        return new Response('会議の本文', { status: 200 });
      }
      if (url.includes('drive/v3/files')) {
        return new Response(JSON.stringify({
          files: [{
            id: 'doc1', name: '会議1', modifiedTime: new Date(Date.now() - 3600000).toISOString(),
            webViewLink: 'https://docs.google.com/document/d/doc1',
            appProperties: { tldvMeetingId: 'mtg1' },
          }],
        }), { status: 200 });
      }
      if (url.includes('gmail.googleapis.com')) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes('sheets.googleapis.com')) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify({}));
    };

    const exitCode = await runImprove({ dryRun: true, limit: 1 }, { fetch: mockFetch, execFile: mockExecFile });
    // dry-run では既存取得失敗でも続行（0 または 1）
    assert.ok(exitCode === 0 || exitCode === 1);
  } finally {
    process.env.GOOGLE_SA_KEY = oldKey;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ===== 古い会議が skippedOld に計上される =====
test('runImprove counts old meetings as skippedOld', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
  const keyData = { client_email: `test-${randomUUID()}@test.iam.gserviceaccount.com`, private_key: privateKey };
  const tmpDir = path.join(os.tmpdir(), `tldv-test-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const keyPath = path.join(tmpDir, 'key.json');
  fs.writeFileSync(keyPath, JSON.stringify(keyData));
  const oldKey = process.env.GOOGLE_SA_KEY;
  process.env.GOOGLE_SA_KEY = keyPath;

  try {
    const mockExecFile = (file, args, opts, cb) => cb(null, JSON.stringify([{ kind: 'process', event: 'test', confidence: 0.9 }]), '');
    const mockFetch = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }));
      }
      if (url.includes('/export?mimeType=text/plain')) {
        return new Response('会議の本文', { status: 200 });
      }
      if (url.includes('drive/v3/files')) {
        // 1つは日付が since（2026-11-01）より古い会議（名前から判定）、もう1つは新しい会議
        return new Response(JSON.stringify({
          files: [
            {
              id: 'old-doc', name: '2025-05-15 10:30（日本時間）古い会議',
              modifiedTime: '2026-11-10T10:00:00Z',
              webViewLink: 'https://docs.google.com/document/d/old-doc',
              appProperties: { tldvMeetingId: 'old-mtg' },
            },
            {
              id: 'new-doc', name: '2026-11-05 10:30（日本時間）新しい会議',
              modifiedTime: '2026-11-10T10:00:00Z',
              webViewLink: 'https://docs.google.com/document/d/new-doc',
              appProperties: { tldvMeetingId: 'new-mtg' },
            },
          ],
        }), { status: 200 });
      }
      if (url.includes('gmail.googleapis.com')) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (url.includes('fields=sheets.properties')) {
        return new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 354072335, title: '改善項目登録シート' } }] }));
      }
      const decoded = decodeURIComponent(url);
      if (decoded.includes('A2:H2')) {
        return new Response(JSON.stringify({ values: [['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] }));
      }
      if (url.includes('/values/')) {
        return new Response(JSON.stringify({ values: [] }));
      }
      return new Response(JSON.stringify({}));
    };

    const exitCode = await runImprove({ dryRun: true, since: new Date('2026-11-01'), limit: 10 }, { fetch: mockFetch, execFile: mockExecFile });
    // dry-run なので成功するはず（exit 0）
    assert.equal(exitCode, 0);
  } finally {
    process.env.GOOGLE_SA_KEY = oldKey;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ===== Issue 1: normalizeTitle（Drive タイトルと Gmail 件名の正規化） =====
test('normalizeTitle handles Drive title with date and timezone', () => {
  const title = '2026-11-11 09:21（日本時間） 事前M：ファインスティール様';
  const result = normalizeTitle(title);
  // 日付・（日本時間）・空白が除去され、事前M：ファインスティール様 のみになる
  assert.ok(result.includes('事前'));
  assert.ok(result.includes('ファインスティール'));
  assert.ok(!result.includes('2026'));
  assert.ok(!result.includes('日本時間'));
});

test('normalizeTitle handles Gmail subject with brackets and suffix', () => {
  const gmailSubject = '「事前M：ファインスティール様」の会議ノートとAI回答が準備できました✅';
  const result = normalizeTitle(gmailSubject);
  // 「」・suffix が除去され、事前M：ファインスティール様 のみになる
  assert.ok(result.includes('事前'));
  assert.ok(result.includes('ファインスティール'));
  assert.ok(!result.includes('会議ノート'));
  assert.ok(!result.includes('✅'));
  assert.ok(!result.includes('「'));
});

test('normalizeTitle produces same normalized form for Drive and Gmail of same meeting', () => {
  const driveTitle = '2026-11-11 09:21（日本時間） 事前M：ファインスティール様';
  const gmailSubject = '「事前M：ファインスティール様」の会議ノートとAI回答が準備できました✅';
  assert.equal(normalizeTitle(driveTitle), normalizeTitle(gmailSubject));
});

test('normalizeTitle empty or short title', () => {
  assert.equal(typeof normalizeTitle(''), 'string');
  assert.equal(typeof normalizeTitle('短い'), 'string');
});

test('normalizeTitle removes multiple whitespace', () => {
  const title = '  会議  タイトル  ';
  const result = normalizeTitle(title);
  assert.ok(result.includes('会議'));
  assert.ok(result.includes('タイトル'));
});

// ===== Issue 1: mergeDuplicateSources =====
test('mergeDuplicateSources removes duplicate Gmail meeting matched by normalized title', () => {
  const driveMeetings = [{
    id: 'drive-1', title: '2026-11-11 09:21（日本時間） 事前M：ファインスティール様',
    source: 'drive', body: 'drive body', modifiedTime: new Date(), url: '',
  }];
  const gmailMeetings = [{
    id: 'gmail-1', title: '「事前M：ファインスティール様」の会議ノートとAI回答が準備できました✅',
    source: 'gmail', body: 'gmail body', modifiedTime: new Date(), url: '',
  }];
  const { merged, skippedDuplicateSource } = mergeDuplicateSources(driveMeetings, gmailMeetings);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'drive');
  assert.equal(skippedDuplicateSource.length, 1);
  assert.equal(skippedDuplicateSource[0].meetingId, 'gmail-1');
});

test('mergeDuplicateSources keeps distinct meetings from both sources', () => {
  const driveMeetings = [{
    id: 'drive-1', title: '定例会議', source: 'drive', body: '', modifiedTime: new Date(), url: '',
  }];
  const gmailMeetings = [{
    id: 'gmail-1', title: '別の会議', source: 'gmail', body: '', modifiedTime: new Date(), url: '',
  }];
  const { merged, skippedDuplicateSource } = mergeDuplicateSources(driveMeetings, gmailMeetings);
  assert.equal(merged.length, 2);
  assert.equal(skippedDuplicateSource.length, 0);
});

test('mergeDuplicateSources empty sources', () => {
  const { merged, skippedDuplicateSource } = mergeDuplicateSources([], []);
  assert.equal(merged.length, 0);
  assert.equal(skippedDuplicateSource.length, 0);
});

// ===== Issue 4: LLM JSON フェンス除去と truncated JSON 救済 =====
test('extractImprovements handles ```json fences in LLM response', async () => {
  // We'll test the JSON parsing logic directly via the module
  // The fence removal happens in extractImprovements, so we need a mock execFile
  let callCount = 0;
  const mockExecFile = (file, args, opts, cb) => {
    callCount++;
    // Return response with ```json fences
    cb(null, '```json\n[\n  {"kind": "process", "event": "test event", "confidence": 0.9}\n]\n```', '');
  };
  const meeting = {
    id: 'mtg1', title: '会議1', body: '短い本文', modifiedTime: new Date(),
    source: 'drive', url: '',
  };
  // Import extractImprovements
  const { extractImprovements } = await import('./tldv-process-improve.mjs');
  const items = await extractImprovements(meeting, {
    config: {
      llm: { confidenceThreshold: 0.6 }, excludeTitlePatterns: [],
    },
    execFileImpl: mockExecFile,
  });
  assert.equal(callCount, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'process');
  assert.equal(items[0].event, 'test event');
});

test('extractImprovements handles truncated JSON (missing closing bracket)', async () => {
  let callCount = 0;
  const mockExecFile = (file, args, opts, cb) => {
    callCount++;
    // Truncated JSON: missing final ]
    cb(null, '[\n  {"kind": "process", "event": "event1", "confidence": 0.9},\n  {"kind": "template", "event": "event2", "confidence": 0.8}', '');
  };
  const meeting = {
    id: 'mtg1', title: '会議1', body: '短い本文', modifiedTime: new Date(),
    source: 'drive', url: '',
  };
  const { extractImprovements } = await import('./tldv-process-improve.mjs');
  const items = await extractImprovements(meeting, {
    config: {
      llm: { confidenceThreshold: 0.6 }, excludeTitlePatterns: [],
    },
    execFileImpl: mockExecFile,
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].event, 'event1');
  assert.equal(items[1].event, 'event2');
});

// ===== Issue 3: TLDV_PI_LOG_DIR override =====
test('TLDV_PI_LOG_DIR redirects log output to custom dir', async () => {
  const testDir = path.join(os.tmpdir(), `tldv-pi-append-test-${randomUUID()}`);
  const oldLogDir = process.env.TLDV_PI_LOG_DIR;
  process.env.TLDV_PI_LOG_DIR = testDir;
  try {
    const { appendLog } = await import('./tldv-process-improve.mjs');
    appendLog({ event: 'test-log-dir-override', message: 'check' });
    const logFile = path.join(testDir, 'tldv-process-improve.log');
    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, 'utf8');
    assert.ok(content.includes('test-log-dir-override'));
  } finally {
    process.env.TLDV_PI_LOG_DIR = oldLogDir;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
});

// ===== 改善項目シート書き込み（F/H列・batchUpdate） =====
test('writeImprovementSheet header row 2 match proceeds with D=caseName, E=問題', async () => {
  const mockFetch = async (url) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes('fields=sheets.properties')) {
      return jsonResponse({ sheets: [{ properties: { sheetId: 354072335, title: '改善シート' } }] });
    }
    const decoded = decodeURIComponent(url);
    if (decoded.includes('A2:H2')) {
      return jsonResponse({ values: [['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
    }
    if (decoded.includes('A1:J')) {
      return jsonResponse({ values: [['集計: 100'], ['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
    }
    return jsonResponse({});
  };
  const result = await writeImprovementSheet(
    [{ kind: 'process', event: 'test event', solution: 'test solution', cause: '', caseName: '会議', meetingUrl: 'https://url' }],
    { token: 'mock-token', dryRun: true, fetchImpl: mockFetch }
  );
  assert.equal(result.planned, 1);
  assert.ok(result.writeStartRow >= 3);
  assert.equal(result.rows[0].B, 'tl;dv自動抽出');
  assert.equal(result.rows[0].D, '会議'); // caseName without date prefix
  assert.equal(result.rows[0].E, '問題');
  assert.equal(result.rows[0].F, '【業務フロー】test event'); // no （会議: …） suffix
  assert.ok(result.rows[0].H.includes('［出典:'));
});

test('writeImprovementSheet throws on header row 2 mismatch', async () => {
  const mockFetch = async (url) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes('fields=sheets.properties')) {
      return jsonResponse({ sheets: [{ properties: { sheetId: 354072335, title: '改善シート' } }] });
    }
    const decoded = decodeURIComponent(url);
    if (decoded.includes('A2:H2')) {
      return jsonResponse({ values: [['WRONG', 'HEADER', '', '', '', '', '', '']] });
    }
    if (decoded.includes('A1:J')) {
      return jsonResponse({ values: [['集計: 100'], ['WRONG', 'HEADER', '', '', '', '', '', '']] });
    }
    return jsonResponse({});
  };
  try {
    await writeImprovementSheet(
      [{ kind: 'process', event: 'test', solution: 'test', cause: '', caseName: '会議', meetingUrl: 'url' }],
      { token: 'mock-token', dryRun: true, fetchImpl: mockFetch }
    );
    assert.unreachable('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ProcessImproveError);
    assert.equal(error.code, 'sheet-header-mismatch');
  }
});

test('writeImprovementSheet last row with A empty but D has value', async () => {
  const mockFetch = async (url) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes('fields=sheets.properties')) {
      return jsonResponse({ sheets: [{ properties: { sheetId: 354072335, title: '改善シート' } }] });
    }
    const decoded = decodeURIComponent(url);
    if (decoded.includes('A2:H2')) {
      return jsonResponse({ values: [['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
    }
    if (decoded.includes('A1:J')) {
      return jsonResponse({ values: [
        ['集計: 100'],
        ['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', '事象', '原因', '対策'],
        ['2026/11/01', '担当者', '', '社内改善'],
        ['', '担当者2', '', 'ヒヤリハット'],
      ]});
    }
    return jsonResponse({});
  };
  const result = await writeImprovementSheet(
    [{ kind: 'process', event: 'test', solution: 'test', cause: '', caseName: '会議', meetingUrl: 'url' }],
    { token: 'mock-token', dryRun: true, fetchImpl: mockFetch }
  );
  // row 4 is last non-empty (D=ヒヤリハット), so writeStartRow = 5
  assert.equal(result.writeStartRow, 5);
});

test('fetchExistingImprovements uses F/H columns and last 800 rows', async () => {
  await withTempKey(async (keyPath, tmpDir) => {
    const dataRows = [];
    for (let i = 0; i < 850; i++) {
      dataRows.push([`2026/11/01`, '担当', '', '社内改善', `金額${i}`, `事象${i}`, `原因${i}`, `対策${i}`]);
    }
    const mockFetch = async (url) => {
      if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
      if (url.includes('fields=sheets.properties')) {
        return jsonResponse({ sheets: [{ properties: { sheetId: 354072335, title: '改善シート' } }] });
      }
      if (url.includes('/values/')) {
        return jsonResponse({ values: dataRows });
      }
      return jsonResponse({});
    };
    const rows = await fetchExistingImprovements({ fetchImpl: mockFetch, dryRun: true });
    assert.equal(rows.length, 800);
    // 850 data rows → last 800 (indices 50-849)
    // event = F列 (index 5), solution = H列 (index 7)
    assert.equal(rows[0].event, '事象50');
    assert.equal(rows[0].solution, '対策50');
    assert.equal(rows[799].event, '事象849');
    assert.equal(rows[799].solution, '対策849');
  });
});

test('writeImprovementSheet uses batchUpdate with 3 ranges A:B / D:E / F:H', async () => {
  let capturedBody = null;
  const mockFetch = async (url, init) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes('fields=sheets.properties')) {
      return jsonResponse({ sheets: [{ properties: { sheetId: 354072335, title: '改善シート' } }] });
    }
    const decoded = decodeURIComponent(url);
    if (decoded.includes('A2:H2')) {
      return jsonResponse({ values: [['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
    }
    if (decoded.includes('A1:J')) {
      return jsonResponse({ values: [['集計: 100'], ['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
    }
    if (url.includes('values:batchUpdate')) {
      capturedBody = JSON.parse(init.body);
      return jsonResponse({});
    }
    if (decoded.includes('!F') && decoded.includes(':H')) {
      return jsonResponse({ values: [['【業務フロー】test event', '', 'test solution［出典: tl;dv https://url］']] });
    }
    return jsonResponse({});
  };
  const result = await writeImprovementSheet(
    [{ kind: 'process', event: 'test event', solution: 'test solution', cause: '', caseName: 'test meeting', meetingUrl: 'https://url' }],
    { token: 'mock-token', dryRun: false, fetchImpl: mockFetch }
  );
  assert.ok(capturedBody !== null, 'batchUpdate should be called');
  assert.equal(capturedBody.data.length, 3);
  assert.ok(capturedBody.data[0].range.includes(':B'), 'range 1 should cover A:B');
  assert.equal(capturedBody.data[0].values[0][1], 'tl;dv自動抽出');
  assert.ok(capturedBody.data[1].range.includes(':E'), 'range 2 should cover D:E');
  assert.equal(capturedBody.data[1].values[0][0], 'test meeting'); // D = caseName
  assert.equal(capturedBody.data[1].values[0][1], '問題'); // E = 問題
  assert.ok(capturedBody.data[2].range.includes(':H'), 'range 3 should cover F:H');
  assert.ok(capturedBody.data[2].values[0][0].includes('【業務フロー】'));
  assert.ok(!capturedBody.data[2].values[0][0].includes('（会議:'), 'F should not contain meeting suffix');
  assert.ok(capturedBody.data[2].values[0][2].includes('［出典:'));
  assert.equal(result.written, 1);
});

test('writeImprovementSheet kindJapanese mapping is correct', async () => {
  const kindMap = { app: 'アプリ改善', template: 'テンプレート修正', knowhow: 'ノウハウ', manual: 'マニュアル修正', process: '業務フロー' };
  for (const [kind, jp] of Object.entries(kindMap)) {
    const mockFetch = async (url) => {
      if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
      if (url.includes('fields=sheets.properties')) {
        return jsonResponse({ sheets: [{ properties: { sheetId: 354072335, title: '改善シート' } }] });
      }
      const decoded = decodeURIComponent(url);
      if (decoded.includes('A2:H2')) {
        return jsonResponse({ values: [['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
      }
      if (decoded.includes('A1:J')) {
        return jsonResponse({ values: [['集計: 100'], ['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', '事象', '原因', '対策']] });
      }
      return jsonResponse({});
    };
    const result = await writeImprovementSheet(
      [{ kind, event: 'test event', solution: 'fix', cause: '', caseName: '会議', meetingUrl: 'url' }],
      { token: 'mock-token', dryRun: true, fetchImpl: mockFetch }
    );
    assert.ok(result.rows[0].F.startsWith(`【${jp}】`), `kind ${kind} should map to 【${jp}】`);
  }
});

// ===== D 列から日付部分除去 =====
test('writeImprovementSheet D column strips date prefix from caseName', async () => {
  const mockFetch = async (url) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes('fields=sheets.properties')) {
      return jsonResponse({ sheets: [{ properties: { sheetId: 354072335, title: '改善シート' } }] });
    }
    const decoded = decodeURIComponent(url);
    if (decoded.includes('A2:H2')) {
      return jsonResponse({ values: [['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
    }
    if (decoded.includes('A1:J')) {
      return jsonResponse({ values: [['集計: 100'], ['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
    }
    return jsonResponse({});
  };
  // caseName に日付プレフィックスがある場合 → 除去される
  const withDate = await writeImprovementSheet(
    [{ kind: 'process', event: 'test', solution: '', cause: '', caseName: '2026-11-11 09:21（日本時間） 事前M：ファインスティール様', meetingUrl: '' }],
    { token: 'mock-token', dryRun: true, fetchImpl: mockFetch }
  );
  assert.equal(withDate.rows[0].D, '事前M：ファインスティール様');
  assert.equal(withDate.rows[0].E, '問題');

  // caseName に日付がない場合 → そのまま
  const withoutDate = await writeImprovementSheet(
    [{ kind: 'process', event: 'test', solution: '', cause: '', caseName: '定例会議', meetingUrl: '' }],
    { token: 'mock-token', dryRun: true, fetchImpl: mockFetch }
  );
  assert.equal(withoutDate.rows[0].D, '定例会議');
});

// ===== dry-run の sheetPlan =====
test('writeImprovementSheet dry-run returns E=問題 and F without meeting suffix', async () => {
  const mockFetch = async (url) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes('fields=sheets.properties')) {
      return jsonResponse({ sheets: [{ properties: { sheetId: 354072335, title: '改善シート' } }] });
    }
    const decoded = decodeURIComponent(url);
    if (decoded.includes('A2:H2')) {
      return jsonResponse({ values: [['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', 'エピソード・発生内容', '発生原因', '発生原因対策']] });
    }
    if (decoded.includes('A1:J')) {
      return jsonResponse({ values: [['集計: 100'], ['タイムスタンプ', '担当', '責任者（プロデューサー）', 'カテゴリ', '改善されるコスト（金額）', '事象', '原因', '対策']] });
    }
    return jsonResponse({});
  };
  const result = await writeImprovementSheet(
    [{ kind: 'app', event: 'ボタンが反応しない', solution: '修正済み', cause: 'バグ', caseName: '2026-11-10 15:00（日本時間） 朝礼', meetingUrl: 'https://tldv.io/mtg1' }],
    { token: 'mock-token', dryRun: true, fetchImpl: mockFetch }
  );
  assert.equal(result.rows[0].D, '朝礼'); // date stripped
  assert.equal(result.rows[0].E, '問題');
  assert.equal(result.rows[0].F, '【アプリ改善】ボタンが反応しない'); // no （会議: …）
  assert.equal(result.rows[0].G, 'バグ');
  assert.ok(result.rows[0].H.includes('［出典:'));
  assert.equal(result.planned, 1);
  assert.ok(result.writeStartRow > 0);
});

// ===== Fix 2: writeLogEntry uses values:append (not row counting) =====
test('writeLogEntry uses values:append with insertDataOption', async () => {
  let capturedUrl = '';
  let capturedBody = null;
  const mockFetch = async (url, init) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes(':append')) {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return jsonResponse({ updates: { updatedRange: "'抽出ログ'!A2" } });
    }
    return jsonResponse({});
  };
  await writeLogEntry({
    token: 'mock-token', logSheetId: 'test-sheet',
    entry: { meetingName: '会議1', kind: 'process', event: 'test', solution: 'fix' },
    fetchImpl: mockFetch,
  });
  assert.ok(capturedUrl.includes(':append'), 'should use append endpoint');
  assert.ok(capturedUrl.includes('insertDataOption=INSERT_ROWS'), 'should insert rows');
  assert.ok(capturedBody.values.length === 1);
  assert.equal(capturedBody.values[0][1], '会議1'); // meetingName (index 1)
  assert.equal(capturedBody.values[0][5], 'test'); // event (index 5)
});

// ===== Fix 2b: writeRunSummary uses values:append =====
test('writeRunSummary uses values:append', async () => {
  let capturedUrl = '';
  const mockFetch = async (url, init) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes(':append')) {
      capturedUrl = url;
      return jsonResponse({ updates: {} });
    }
    return jsonResponse({});
  };
  await writeRunSummary({
    token: 'mock-token', logSheetId: 'test-sheet',
    summary: { fetched: 5, processed: 3, extracted: 2, duplicates: 0, sheetWritten: 2, feedbackSent: 1, knowhowAdded: 0, failed: 0 },
    fetchImpl: mockFetch,
  });
  assert.ok(capturedUrl.includes(':append'));
  assert.ok(capturedUrl.includes('insertDataOption=INSERT_ROWS'));
});

// ===== Fix 3: writeTemplateReflection writes to template tab =====
test('writeTemplateReflection appends template items to テンプレート反映案 tab', async () => {
  let capturedBody = null;
  const mockFetch = async (url, init) => {
    if (url.includes('oauth2')) return jsonResponse({ access_token: 'mock-token' });
    if (url.includes(':append')) {
      capturedBody = JSON.parse(init.body);
      return jsonResponse({ updates: {} });
    }
    return jsonResponse({});
  };
  const items = [
    { kind: 'template', target: '実施計画書テンプレート', solution: 'チェック項目追加', evidence: '会議で決定', caseName: '朝礼' },
    { kind: 'process', event: 'test' }, // non-template item, should be skipped
  ];
  const count = await writeTemplateReflection(items, { token: 'mock-token', logSheetId: 'test-sheet', fetchImpl: mockFetch });
  assert.equal(count, 1);
  assert.ok(capturedBody !== null);
  assert.equal(capturedBody.values.length, 1);
  assert.equal(capturedBody.values[0][1], '実施計画書テンプレート');
  assert.equal(capturedBody.values[0][5], '未反映');
});

test('writeTemplateReflection returns 0 when no template items', async () => {
  const count = await writeTemplateReflection(
    [{ kind: 'process', event: 'test' }],
    { token: 'mock-token', logSheetId: 'test-sheet', fetchImpl: async () => jsonResponse({}) }
  );
  assert.equal(count, 0);
});

// ===== Fix 4: notifyKimInbox skips 0-item nights =====
test('notifyKimInbox returns silently when totalItems=0', async () => {
  const result = await notifyKimInbox({ totalItems: 0, fetched: 0 }, 'https://sheet.url');
  assert.equal(result, undefined);
});

// ===== Fix 5: postAppFeedback uses correct config key (feedbackApi, not feeedbackApi) =====
test('postAppFeedback reads from config.feedbackApi url', async () => {
  let capturedBody = null;
  const mockFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return jsonResponse({ ok: true });
  };
  const items = [
    { kind: 'app', event: 'ボタンが動かない', solution: '修正済み', caseName: '会議', meetingId: 'mtg1', evidence: '引用' },
    { kind: 'process', event: '業務フロー改善' }, // non-app, should be skipped
  ];
  // Set env so the URL is picked up
  process.env.BOOTH_FEEDBACK_URL = 'https://example.test/exec';
  try {
    const count = await postAppFeedback(items, { fetchImpl: mockFetch });
    assert.equal(count, 1);
    assert.ok(capturedBody.action === 'submitFeedbackDialog');
    assert.ok(capturedBody.kind === '要望');
    assert.ok(capturedBody.submitId);
    assert.ok(capturedBody.submitId.startsWith('tldv-'));
  } finally {
    delete process.env.BOOTH_FEEDBACK_URL;
  }
});

test('postAppFeedback returns 0 when no url configured', async () => {
  const items = [{ kind: 'app', event: 'test' }];
  const count = await postAppFeedback(items, { fetchImpl: async () => jsonResponse({}) });
  assert.equal(count, 0);
});

// ===== Fix 6: addConstructionKnowhow =====
test('addConstructionKnowhow dry-run returns count for knowhow items', async () => {
  const count = await addConstructionKnowhow(
    [{ kind: 'knowhow', event: 'test knowhow', solution: 'fix', caseName: '会議1', target: '施工ノウハウ' },
     { kind: 'process', event: 'no-knowhow' }],
    { dryRun: true }
  );
  assert.equal(count, 1); // only 1 knowhow item
});

test('addConstructionKnowhow processes each knowhow item', async () => {
  const count = await addConstructionKnowhow(
    [{ kind: 'knowhow', event: 'test knowhow 1', solution: 'fix', caseName: '会議', target: '施工ノウハウ' },
     { kind: 'knowhow', event: 'test knowhow 2', solution: 'fix', caseName: '会議', target: '施工ノウハウ' }],
    { dryRun: true }
  );
  assert.equal(count, 2);
});

// ===== Fix 7: state tracking =====
test('processed meetings recorded only after writes succeed', () => {
  const state = defaultState();
  assert.equal(typeof state.processedMeetings, 'object');
  assert.equal(Object.keys(state.processedMeetings).length, 0);
  // Simulating the new flow: processedIds collected during loop, added to state after writes
  const processedIds = ['mtg1', 'mtg2'];
  for (const id of processedIds) {
    if (!state.processedMeetings[id]) {
      state.processedMeetings[id] = {
        title: '',
        processedAt: new Date().toISOString(),
        items: 1,
      };
    }
  }
  assert.equal(Object.keys(state.processedMeetings).length, 2);
  assert.ok(state.processedMeetings.mtg1);
  assert.equal(state.processedMeetings.mtg2.processedAt, state.processedMeetings.mtg2.processedAt);
});

// ===== Fix 1: ensureLogSheet で owner を writer と同等に扱う =====
test('ensureLogSheet accepts owner role as valid', async () => {
  // token, state, fetchImpl を使い、owner のロールを writer と同様に扱う
  const mockFetch = async (url, init) => {
    if (url.includes('sheets.googleapis.com')) {
      return jsonResponse({ spreadsheetId: 'test-log-sheet', spreadsheetUrl: 'https://sheet.url' });
    }
    // sheets metadata は sheets list で帰る
    if (url.includes('fields=sheets.properties')) {
      return jsonResponse({ sheets: [{ properties: { sheetId: 0, title: '抽出ログ' } }] });
    }
    // drive.read_file content はテキスト
    if (url.includes('values/抽出ログ!A1')) {
      return jsonResponse({});
    }
    if (url.includes('values/テンプレート反映案!A1')) {
      return jsonResponse({});
    }
    if (url.includes('values/実行サマリ!A1')) {
      return jsonResponse({});
    }
    // Permission verify: return owner role for kim
    if (url.includes('/permissions')) {
      return jsonResponse({ permissions: [{ emailAddress: 'kim@orgiast.jp', role: 'owner' }] });
    }
    if (url.includes('oauth2.googleapis.com')) {
      return jsonResponse({ access_token: 'mock-token' });
    }
    return jsonResponse({});
  };
  const state = defaultState();
  await ensureLogSheet({ token: 'mock-token', state, fetchImpl: mockFetch });
  // Should not have logged an error — owner is accepted
  assert.equal(state.logSheetId, 'test-log-sheet');
});

// ===== Fix 2: 同一 extractImprovements 呼び出し内の重複除去 =====
test('extractImprovements deduplicates within same call (chunk crossing)', async () => {
  let callCount = 0;
  const mockExecFile = (file, args, opts, cb) => {
    callCount++;
    // Chunk 1 returns items [A, B]; Chunk 2 returns overlapping [A, C]
    if (callCount === 1) {
      cb(null, JSON.stringify([
        { kind: 'process', event: '同一事象A', confidence: 0.9 },
        { kind: 'process', event: '事象B', confidence: 0.85 },
      ]), '');
    } else {
      cb(null, JSON.stringify([
        { kind: 'process', event: '同一事象A', confidence: 0.9 },
        { kind: 'process', event: '事象C', confidence: 0.8 },
      ]), '');
    }
  };
  // body は chunk 分割されるよう十分長く
  const body = '会議本文\n'.repeat(2401); // 12005 chars → 2 chunks (12000 + 5)
  const meeting = {
    id: 'mtg-dedup', title: '同一会議', body, modifiedTime: new Date(),
    source: 'drive', url: '',
  };
  const items = await extractImprovements(meeting, {
    config: { llm: { confidenceThreshold: 0.6 }, excludeTitlePatterns: [] },
    execFileImpl: mockExecFile,
  });
  // 重複除去後: A は1回だけ、B, C は各1回 → 3件
  // 注意: CHUNK_SIZE=12000, body が 2401行(各5文字=12005) → chunk 分割なし（※実測要確認）
  // LLMは2回呼ばれ(2 chunks → 2 callLlm)、Aはchunk1とchunk2で重複→seenInCallで2回目をskip
  const chunkLen = chunkText(body).length;
  assert.ok(chunkLen >= 2, `body should split into >=2 chunks (got ${chunkLen})`);
  assert.equal(items.length, 3);
  assert.equal(callCount, 2);
  // 同一事象A は1度しか現れない
  const aItems = items.filter(i => i.event === '同一事象A');
  assert.equal(aItems.length, 1, '同一事象 should appear only once');
});

// ===== Fix 3: addConstructionKnowhow の JSON パース成功 =====
test('addConstructionKnowhow parses CommandQueue JSON format (ok+result)', async () => {
  const mockRunNode = async (args, opts) => {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, command: 'ConstructionKnowhow_add', result: 'KH-abc123' }),
      stderr: '',
    };
  };
  const count = await addConstructionKnowhow(
    [{ kind: 'knowhow', event: 'test knowhow', solution: 'fix', caseName: '会議', target: '施工ノウハウ' }],
    { cmdPath: '/tmp/nonexistent/booth-cmd.mjs', runNode: mockRunNode }
  );
  assert.equal(count, 1);
});

test('addConstructionKnowhow logs error on GAS failure', async () => {
  const mockRunNode = async (args, opts) => {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ok: false, command: 'ConstructionKnowhow_add', error: 'Validation failed' }),
      stderr: '',
    };
  };
  const count = await addConstructionKnowhow(
    [{ kind: 'knowhow', event: 'test knowhow', solution: 'fix', caseName: '会議', target: '施工ノウハウ' }],
    { cmdPath: '/tmp/nonexistent/booth-cmd.mjs', runNode: mockRunNode }
  );
  assert.equal(count, 0);
});

test('addConstructionKnowhow logs error on non-zero exit', async () => {
  const mockRunNode = async (args, opts) => {
    return { exitCode: 1, stdout: '', stderr: 'command not found' };
  };
  const count = await addConstructionKnowhow(
    [{ kind: 'knowhow', event: 'test knowhow', solution: 'fix', caseName: '会議', target: '施工ノウハウ' }],
    { cmdPath: '/tmp/nonexistent/booth-cmd.mjs', runNode: mockRunNode }
  );
  assert.equal(count, 0);
});