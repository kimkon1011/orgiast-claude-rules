import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  staleFindings,
  externalRecipients,
  resolveKeyPath,
  hasAnyCredential,
  runCli,
  scanMailbox,
  staleFindingsForDraft,
  render,
  LABEL,
  sentTo,
} from './mail-stale-draft.mjs';
import { defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { relayStatePath } from './lib/seisaku-gmail-token.mjs';
import { checkConsistency } from './mail-consistency-check.mjs';

test('下書き保存より後に同じ宛先へ送信があれば block・category「古い下書き」・thread_fact に後の件名を含む', () => {
  const draft = {
    messageId: 'draft-1',
    internalDate: String(new Date('2026-09-13T10:00:00+09:00').getTime()),
    subject: 'お見積もりの件',
    body: 'お見積もりをお送りいたします。',
  };
  const sentByAddr = {
    'client@example.com': [
      { id: 'sent-2', internalDate: String(new Date('2026-10-24T15:00:00+09:00').getTime()), subject: '10/24 再提案' },
      { id: 'sent-1', internalDate: String(new Date('2026-09-16T12:00:00+09:00').getTime()), subject: '9/16 打ち合わせ議事録' },
    ],
  };
  const findings = staleFindings({ draft, sentByAddr });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'block');
  assert.equal(findings[0].category, '古い下書き');
  assert.match(findings[0].thread_fact, /10\/24 再提案/);
});

test('初回挨拶（本文に「名刺交換」）の下書きは、保存後の送信が無くても既に送信履歴があれば block', () => {
  const draft = {
    messageId: 'draft-2',
    internalDate: String(new Date('2026-10-25T10:00:00+09:00').getTime()),
    subject: '展示会でのご挨拶',
    body: '先日は名刺交換のお礼申し上げます。',
  };
  const sentByAddr = {
    'client@example.com': [
      { id: 'sent-1', internalDate: String(new Date('2026-10-20T10:00:00+09:00').getTime()), subject: '以前の打ち合わせ' },
    ],
  };
  const findings = staleFindings({ draft, sentByAddr });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'block');
  assert.equal(findings[0].category, '古い下書き');
  assert.match(findings[0].suggestion, /初回の挨拶.*送らずに削除/);
});

test('通常の返信下書き（保存後の送信なし・挨拶でない）は []、送信履歴ゼロの挨拶も []', () => {
  const normalDraft = {
    messageId: 'draft-3',
    internalDate: String(new Date('2026-10-25T10:00:00+09:00').getTime()),
    subject: 'Re: 進行状況のご連絡',
    body: '進捗をご報告いたします。',
  };
  const normalSent = {
    'client@example.com': [
      { id: 'sent-1', internalDate: String(new Date('2026-10-24T10:00:00+09:00').getTime()), subject: '進行状況のご連絡' },
    ],
  };
  assert.deepEqual(staleFindings({ draft: normalDraft, sentByAddr: normalSent }), []);

  const firstGreetingDraft = {
    messageId: 'draft-4',
    internalDate: String(new Date('2026-10-25T10:00:00+09:00').getTime()),
    subject: '名刺交換のお礼',
    body: '先ほどは名刺交換ありがとうございました。',
  };
  const zeroSent = {
    'newclient@example.com': [],
  };
  assert.deepEqual(staleFindings({ draft: firstGreetingDraft, sentByAddr: zeroSent }), []);
});

test('下書き自身の messageId は送信履歴として数えない', () => {
  const draft = {
    messageId: 'draft-self',
    internalDate: '1000',
    subject: '名刺交換のお礼',
    body: '名刺交換',
  };
  const sentByAddr = {
    'client@example.com': [
      { id: 'draft-self', internalDate: '500', subject: '名刺交換のお礼' },
    ],
  };
  assert.deepEqual(staleFindings({ draft, sentByAddr }), []);
});

test('externalRecipients は To/Cc から @orgiast.jp を除外し小文字化・重複除去', () => {
  const payload = {
    headers: [
      { name: 'To', value: 'Alice <ALICE@example.com>, Bob <bob@orgiast.jp>' },
      { name: 'Cc', value: 'alice@example.com, Charlie <CHARLIE@other.org>, Dave <dave@ORGIAST.JP>' },
    ],
  };
  const recipients = externalRecipients(payload);
  assert.deepEqual(recipients.sort(), ['alice@example.com', 'charlie@other.org'].sort());
});

test('resolveKeyPath の順序（env 優先、無ければ ~/.claude/keys）', () => {
  const home = path.resolve('/mock/home');
  const aujustKey = path.join(home, '.claude', 'keys', 'aujust-sheets-reader.json');
  const defaultKey = defaultDriveKeyPath();

  const envKey = path.resolve('/custom/path/sa.json');
  const resolvedEnv = resolveKeyPath({
    env: { GOOGLE_SA_KEY: envKey },
    exists: p => p === envKey || p === aujustKey || p === defaultKey,
    home,
  });
  assert.equal(resolvedEnv, envKey);

  const resolvedAujust = resolveKeyPath({
    env: {},
    exists: p => p === aujustKey,
    home,
  });
  assert.equal(resolvedAujust, aujustKey);

  const resolvedDefault = resolveKeyPath({
    env: {},
    exists: p => p === defaultKey,
    home,
  });
  assert.equal(resolvedDefault, defaultKey);

  const resolvedNone = resolveKeyPath({
    env: {},
    exists: () => false,
    home,
  });
  assert.equal(resolvedNone, defaultKey);

  const resolvedNoneWithEnv = resolveKeyPath({
    env: { GOOGLE_SA_KEY: path.resolve('/nonexistent/key.json') },
    exists: () => false,
    home,
  });
  assert.equal(resolvedNoneWithEnv, path.resolve('/nonexistent/key.json'));
});

test('hasAnyCredential は環境変数・既定鍵・代替鍵・リレーのいずれかで true', () => {
  const home = path.resolve('/mock/home');
  assert.equal(hasAnyCredential({ env: {}, exists: () => false, home }), false);
  assert.equal(hasAnyCredential({ env: { GOOGLE_SA_KEY: '/missing/key.json' }, exists: () => false, home }), true);
  for (const credential of [defaultDriveKeyPath(), path.join(home, '.claude', 'keys', 'aujust-sheets-reader.json'), relayStatePath()]) {
    assert.equal(hasAnyCredential({ env: {}, exists: p => p === credential, home }), true);
  }
});

test('runCli は認証情報が無ければスキップし scanMailbox を呼ばず終了コード 0', async () => {
  let scanned = false;
  const code = await runCli(['--user', 'test@example.com'], {
    hasCredential: () => false,
    stdout: () => {},
    scanMailbox: async () => { scanned = true; },
  });
  assert.equal(code, 0);
  assert.equal(scanned, false);
});

test('runCli は認証情報があって全ユーザーの API が失敗すれば終了コード 3', async () => {
  const code = await runCli([], {
    hasCredential: () => true,
    stdout: () => {},
    scanMailbox: async () => { throw new Error('API failed'); },
  });
  assert.equal(code, 3);
});

test('runCli(["--apply","--notify"], deps) は newlyLabeled の下書きだけ通知し、古い下書きがあれば終了コード 2、新規0件なら notify を呼ばない', async () => {
  let notifiedText = null;
  const notifyMock = text => { notifiedText = text; };

  const depsWithNew = {
    hasCredential: () => true,
    scanMailbox: async () => ({
      user: 'seisaku-team@orgiast.jp',
      scanned: 5,
      stale: [{
        user: 'seisaku-team@orgiast.jp',
        draftId: 'd-1',
        messageId: 'm-1',
        subject: '古い下書き件名',
        to: 'client@example.com',
        savedAt: '2026/9/13 10:00',
        newlyLabeled: true,
        alreadyLabeled: false,
        findings: [{ severity: 'block', category: '古い下書き', thread_fact: '10/24 に後続メール送信済み' }],
      }],
    }),
    notify: notifyMock,
    stdout: () => {},
  };

  const codeA = await runCli(['--apply', '--notify'], depsWithNew);
  assert.equal(codeA, 2);
  assert.ok(notifiedText !== null);
  assert.match(notifiedText, /古い下書き件名/);
  assert.match(notifiedText, /10\/24 に後続メール送信済み/);

  notifiedText = null;
  const depsAlreadyLabeled = {
    hasCredential: () => true,
    scanMailbox: async () => ({
      user: 'seisaku-team@orgiast.jp',
      scanned: 5,
      stale: [{
        user: 'seisaku-team@orgiast.jp',
        draftId: 'd-1',
        messageId: 'm-1',
        subject: '既存ラベル下書き件名',
        to: 'client@example.com',
        savedAt: '2026/9/13 10:00',
        newlyLabeled: false,
        alreadyLabeled: true,
        findings: [{ severity: 'block', category: '古い下書き', thread_fact: '10/24 に後続メール送信済み' }],
      }],
    }),
    notify: notifyMock,
    stdout: () => {},
  };

  const codeB = await runCli(['--apply', '--notify'], depsAlreadyLabeled);
  assert.equal(codeB, 2);
  assert.equal(notifiedText, null);

  notifiedText = null;
  const depsNoStale = {
    hasCredential: () => true,
    scanMailbox: async () => ({
      user: 'seisaku-team@orgiast.jp',
      scanned: 3,
      stale: [],
    }),
    notify: notifyMock,
    stdout: () => {},
  };

  const codeC = await runCli(['--apply', '--notify'], depsNoStale);
  assert.equal(codeC, 0);
  assert.equal(notifiedText, null);
});

test('checkConsistency に deps.loaded.stale の block を渡すと report.ok=false で findings[0].category="古い下書き"', async () => {
  const staleFinding = {
    severity: 'block',
    category: '古い下書き',
    thread_fact: '後からメールが送信されています',
    thread_ref: null,
    draft_claim: '名刺交換のお礼',
    suggestion: '下書きを削除してください。',
  };
  const report = await checkConsistency({
    target: 'draft-123',
    draftId: 'draft-123',
    deps: {
      loaded: {
        threadId: 'thread-123',
        body: '名刺交換のお礼申し上げます。',
        stale: [staleFinding],
        timeline: [],
      },
      llm: async () => ({ provider: 'dummy', ok: true, findings: [], summary: '' }),
      saveState: () => {},
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].category, '古い下書き');
  assert.equal(report.findings[0].severity, 'block');
});

test('キャッシュで同じ宛先の問い合わせが1回になる', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method ?? 'GET' });
    if (u.includes('/labels')) {
      return { ok: true, status: 200, json: async () => ({ labels: [] }) };
    }
    if (u.includes('/drafts?maxResults=100')) {
      return { ok: true, status: 200, json: async () => ({ drafts: [{ id: 'd-1' }, { id: 'd-2' }] }) };
    }
    if (u.includes('/drafts/d-1?')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 'd-1',
          message: {
            id: 'm-1',
            internalDate: '1000',
            labelIds: ['DRAFT'],
            payload: {
              headers: [
                { name: 'To', value: 'client@example.com' },
                { name: 'Subject', value: '下書き1' },
              ],
            },
          },
        }),
      };
    }
    if (u.includes('/drafts/d-2?')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 'd-2',
          message: {
            id: 'm-2',
            internalDate: '1000',
            labelIds: ['DRAFT'],
            payload: {
              headers: [
                { name: 'To', value: 'client@example.com' },
                { name: 'Subject', value: '下書き2' },
              ],
            },
          },
        }),
      };
    }
    if (u.includes('/messages?q=')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 's-1' }, { id: 's-2' }] }) };
    }
    if (u.includes('/messages/s-1?')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 's-1',
          internalDate: '2000',
          payload: { headers: [{ name: 'Subject', value: '最新送信メール' }] },
        }),
      };
    }
    throw new Error(`Unexpected mock url: ${u}`);
  };

  const result = await scanMailbox({
    user: 'seisaku-team@orgiast.jp',
    fetchImpl: mockFetch,
    getToken: async () => 'mock-token',
    retryDelayMs: 0,
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.stale.length, 2);

  const sentListCalls = calls.filter(c => c.url.includes('/messages?q='));
  const sentDetailCalls = calls.filter(c => c.url.includes('/messages/s-1?'));
  assert.equal(sentListCalls.length, 1, 'sent検索APIの呼び出しは1回のみ');
  assert.equal(sentDetailCalls.length, 1, 'sent詳細APIの呼び出しは1回のみ');
});

test('1件の取得失敗でも他の下書きは判定され errors に1件入る', async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/labels')) return { ok: true, status: 200, json: async () => ({ labels: [] }) };
    if (u.includes('/drafts?maxResults=100')) {
      return { ok: true, status: 200, json: async () => ({ drafts: [{ id: 'd-bad' }, { id: 'd-ok' }] }) };
    }
    if (u.includes('/drafts/d-bad?')) throw new Error('boom');
    if (u.includes('/drafts/d-ok?')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 'd-ok',
          message: {
            id: 'm-ok', internalDate: '1000', labelIds: ['DRAFT'],
            payload: { headers: [{ name: 'To', value: 'client@example.com' }, { name: 'Subject', value: '正常下書き' }] },
          },
        }),
      };
    }
    if (u.includes('/messages?q=')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: 's-1' }] }) };
    if (u.includes('/messages/s-1?')) {
      return { ok: true, status: 200, json: async () => ({ id: 's-1', internalDate: '2000', payload: { headers: [{ name: 'Subject', value: '後続' }] } }) };
    }
    throw new Error(`Unexpected mock url: ${u}`);
  };
  const result = await scanMailbox({
    user: 'seisaku-team@orgiast.jp',
    fetchImpl: mockFetch,
    getToken: async () => 'mock-token',
    retryDelayMs: 0,
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].draftId, 'd-bad');
  assert.match(result.errors[0].error, /boom/);
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].draftId, 'd-ok');
});

test('新規ラベル20件なら通知本文に15件分と「ほか 5 件」が入る', async () => {
  let notifiedText = null;
  const stale = Array.from({ length: 20 }, (_, n) => ({
    user: 'seisaku-team@orgiast.jp',
    draftId: `d-${n}`,
    messageId: `m-${n}`,
    subject: `件名${n}`,
    to: 'client@example.com',
    savedAt: '2026/9/13 10:00',
    newlyLabeled: true,
    alreadyLabeled: false,
    findings: [{ severity: 'block', category: '古い下書き', thread_fact: '後続あり' }],
  }));
  await runCli(['--apply', '--notify'], {
    hasCredential: () => true,
    scanMailbox: async () => ({ user: 'seisaku-team@orgiast.jp', scanned: 20, stale }),
    notify: t => { notifiedText = t; },
    stdout: () => {},
  });
  assert.match(notifiedText, /20 件/);
  assert.match(notifiedText, /件名14「|件名14」/);
  assert.ok(!/件名15」/.test(notifiedText));
  assert.match(notifiedText, /ほか 5 件/);
});

test('既ラベルは再確認しない', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method ?? 'GET' });
    if (u.includes('/labels')) {
      return { ok: true, status: 200, json: async () => ({ labels: [{ id: 'label-stale-99', name: LABEL }] }) };
    }
    if (u.includes('/drafts?maxResults=100')) {
      return { ok: true, status: 200, json: async () => ({ drafts: [{ id: 'd-labeled' }] }) };
    }
    if (u.includes('/drafts/d-labeled?')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 'd-labeled',
          message: {
            id: 'm-labeled',
            internalDate: '1000',
            labelIds: ['DRAFT', 'label-stale-99'],
            payload: {
              headers: [
                { name: 'To', value: 'client@example.com' },
                { name: 'Subject', value: '既ラベル下書き' },
              ],
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected mock url: ${u}`);
  };

  const result = await scanMailbox({
    user: 'seisaku-team@orgiast.jp',
    fetchImpl: mockFetch,
    getToken: async () => 'mock-token',
    retryDelayMs: 0,
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].alreadyLabeled, true);
  assert.equal(result.stale[0].newlyLabeled, false);
  assert.equal(result.stale[0].findings[0].thread_fact, '前回の点検でラベル付与済み');

  const sentQueries = calls.filter(c => c.url.includes('/messages?q='));
  assert.equal(sentQueries.length, 0, '既ラベル下書きには送信履歴の問い合わせを行わない');
});

test('締め切りで truncated になる', async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/labels')) return { ok: true, status: 200, json: async () => ({ labels: [] }) };
    if (u.includes('/drafts?maxResults=100')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          drafts: [{ id: 'd-1' }, { id: 'd-2' }, { id: 'd-3' }],
        }),
      };
    }
    if (u.includes('/drafts/')) {
      await new Promise(r => setTimeout(r, 20));
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 'd-1',
          message: {
            id: 'm-1',
            internalDate: '1000',
            payload: { headers: [{ name: 'To', value: 'client@example.com' }] },
          },
        }),
      };
    }
    if (u.includes('/messages?q=')) return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    throw new Error(`Unexpected mock url: ${u}`);
  };

  const result = await scanMailbox({
    user: 'seisaku-team@orgiast.jp',
    fetchImpl: mockFetch,
    getToken: async () => 'mock-token',
    deadlineMs: 0,
    retryDelayMs: 0,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.unprocessed > 0, `unprocessed should be > 0, got ${result.unprocessed}`);
  const rendered = render([result]);
  assert.match(rendered, /打ち切り/);
  assert.match(rendered, /未処理/);
});

test('snippet で挨拶判定できる', async () => {
  const draftJsonWithSnippet = {
    id: 'd-greet',
    message: {
      id: 'm-greet',
      internalDate: '2000',
      snippet: '先日は名刺交換のお礼申し上げます。',
      payload: {
        headers: [
          { name: 'To', value: 'client@example.com' },
          { name: 'Subject', value: 'ご挨拶' },
        ],
      },
    },
  };

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/messages?q=')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 's-old' }] }) };
    }
    if (u.includes('/messages/s-old?')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 's-old',
          internalDate: '1000',
          payload: { headers: [{ name: 'Subject', value: '以前のメール' }] },
        }),
      };
    }
    throw new Error(`Unexpected mock url: ${u}`);
  };

  const findings = await staleFindingsForDraft('mock-token', draftJsonWithSnippet, {
    fetchImpl: mockFetch,
    retryDelayMs: 0,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'block');
  assert.equal(findings[0].category, '古い下書き');
  assert.match(findings[0].suggestion, /初回の挨拶/);
});

test('429/5xx は 1 回だけ 2 秒待って再試行し成功する', async () => {
  let attempts = 0;
  let sleptMs = 0;
  const mockSleep = async ms => { sleptMs += ms; };
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/messages?q=')) {
      attempts++;
      if (attempts === 1) {
        return { ok: false, status: 429, statusText: 'Too Many Requests' };
      }
      return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    }
    throw new Error(`Unexpected url: ${u}`);
  };

  const res = await sentTo('mock-token', 'client@example.com', mockFetch, {
    sleepImpl: mockSleep,
    retryDelayMs: 2000,
  });

  assert.equal(attempts, 2, '初回失敗後に再試行される');
  assert.equal(sleptMs, 2000, '再試行前に2秒待つ');
  assert.deepEqual(res, []);
});

test('sentTo は最新が下書き自身の messageId の場合次の1件を取得し件数を保持する', async () => {
  const calls = [];
  const mockFetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/messages?q=')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          messages: [
            { id: 'm-draft-self' },
            { id: 'm-sent-prev' },
            { id: 'm-sent-older' },
          ],
        }),
      };
    }
    if (u.includes('/messages/m-sent-prev?')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 'm-sent-prev',
          internalDate: '1500',
          payload: { headers: [{ name: 'Subject', value: '前回のメール' }] },
        }),
      };
    }
    throw new Error(`Unexpected url: ${u}`);
  };

  const sent = await sentTo('mock-token', 'client@example.com', mockFetch, {
    draftMessageId: 'm-draft-self',
    retryDelayMs: 0,
  });

  assert.equal(calls.filter(u => u.includes('/messages')).length, 2, 'list と metadata 取得の計2回');
  assert.ok(!calls.some(u => u.includes('/messages/m-draft-self?')), '下書き自身の詳細は取得しない');
  assert.ok(calls.some(u => u.includes('/messages/m-sent-prev?')), '次の1件の詳細を取得する');
  assert.equal(sent.length, 3, '件数はリストの3件を維持');
  assert.equal(sent[0].id, 'm-sent-prev');
  assert.equal(sent[0].subject, '前回のメール');
});
