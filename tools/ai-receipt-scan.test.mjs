import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiptLedgerAgeHours, runReceiptScanCli, buildReceiptQuery, classifyVendor, parseReceiptMail, summarizeReceipts, evaluateReceiptAlerts, formatReceiptReport, scanAiReceipts, alertAiReceipts } from './ai-receipt-scan.mjs';
const config = JSON.parse(fs.readFileSync(new URL('./ai-receipt-accounts.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-17T03:00:00Z');
const mail = { id: 'one', threadId: 'thread', date: '2026-10-16T10:00:00Z', from: '"Anthropic, PBC" <invoice+statements@mail.anthropic.com>', to: 'seisaku-team@orgiast.jp', subject: 'Your receipt from Anthropic, PBC #2666-1376-2870', body: 'Receipt from Anthropic, PBC $22.00 Paid on October 16, 2026 with - 1109 (invoice illustration [...]) Receipt #2666-1376-2870 One-time credit purchase Qty 1 $20.00 Subtotal $20.00 Total excluding tax $20.00 JCT - Japan (10%) $2.00 Total $22.00 Amount paid $22.00 Download receipt (...)' };
const row = (overrides = {}) => ({ ...parseReceiptMail(mail, config), ...overrides });
test('query has exact vendor and billing term OR groups', () => {
  assert.equal(buildReceiptQuery(config, 3), '(from:mail.anthropic.com OR from:anthropic.com OR from:openai.com OR from:payments-noreply@google.com OR from:cloud-billing OR from:google.com OR from:openrouter.ai OR from:x.ai OR from:deepseek.com OR from:moonshot.cn OR from:moonshot.ai OR from:z.ai OR from:zhipuai.cn OR from:bigmodel.cn OR from:cursor.com OR from:cursor.sh OR from:genspark.ai OR from:groq.com OR from:mistral.ai) newer_than:3d (receipt OR invoice OR payment OR "auto-reload" OR "usage credits" OR "spend limit" OR "API access" OR 領収 OR 請求 OR お支払い)');
  assert.throws(() => buildReceiptQuery(config, NaN));
});
test('receipt fixture yields structured fields only, with paid total and card', () => {
  assert.deepEqual(row(), { messageId: 'one', threadId: 'thread', account: mail.to, recipient: mail.to, vendor: 'anthropic', kind: 'receipt', date: mail.date.replace('Z', '.000Z'), amountUsd: 22, amountJpy: null, currency: 'USD', org: null, card: '- 1109', receiptNo: '2666-1376-2870', subject: mail.subject });
});
const fixtures = [
  { subject: '$17.36 payment to Anthropic, PBC was unsuccessful', from: 'failed-payments@mail.anthropic.com', kind: 'failed_payment', amountUsd: 17.36 },
  { subject: 'Auto-reload was paused on your Anthropic account', body: "Auto-reload has been turned off for your organization because the most recent auto-reload payment didn't go through.", kind: 'autoreload_paused' },
  { subject: 'Auto-reload went through on another saved card', body: "The latest $10.93 auto-reload for よろしくお願いします。's Individual Org went through on JCB ending in 7945 because your default card, Visa ending in 5406, was declined.", kind: 'autoreload_other_card', amountUsd: 10.93, org: "よろしくお願いします。's Individual Org", card: 'JCB 7945' },
  { subject: '[Action needed] Your Claude API access is turned off', snippet: 'Your access to the Claude API has been disabled because your organization &#39;よろしくお願いします。&#39;s Individual Org&#39; is out of usage credits.', kind: 'api_off', org: "よろしくお願いします。's Individual Org" },
  { subject: 'Your organization has reached its usage credits spend limit', to: 'kim@orgiast.jp', kind: 'spend_limit_reached', org: null },
  { subject: 'Your organization is approaching its usage credits spend limit', kind: 'spend_limit_warning' },
  { subject: 'You used 75% of your limit', kind: 'spend_limit_warning' },
  { subject: 'Your usage limit has been increased', kind: 'limit_increased' },
  { subject: 'Someone requested more usage', kind: 'usage_request' },
];
for (const fixture of fixtures) test(`event fixture: ${fixture.kind} / ${fixture.subject}`, () => {
  const parsed = parseReceiptMail({ ...mail, body: '', ...fixture }, config);
  for (const field of ['kind', 'amountUsd', 'org', 'card']) if (field in fixture) assert.equal(parsed[field], fixture[field]);
  assert.equal(parsed.vendor, 'anthropic');
});
test('amount priority, JPY, total fallback and Stripe classification', () => {
  assert.equal(parseReceiptMail({ ...mail, body: 'Total $30.00 Amount paid $22.00' }, config).amountUsd, 22);
  assert.equal(parseReceiptMail({ ...mail, body: 'Total $30.00' }, config).amountUsd, 30);
  const yen = parseReceiptMail({ ...mail, body: 'Amount paid ¥12,345' }, config);
  assert.equal(yen.amountUsd, null); assert.equal(yen.amountJpy, 12345); assert.equal(yen.currency, 'JPY');
  assert.equal(classifyVendor('receipts@stripe.com', 'Your receipt from OpenAI', config), 'openai');
  assert.equal(classifyVendor('x@notanthropic.com', '', config), 'unknown');
  assert.equal(classifyVendor('Anthropic <x@example.com>', '', config), 'unknown');
});
test('summaries use JST month, rolling windows, and receipts only', () => {
  const summary = summarizeReceipts([
    row({ date: '2026-09-30T15:00:00Z', amountUsd: 100 }),
    row({ date: '2026-09-30T14:59:59Z', amountUsd: 900 }),
    row({ date: '2026-10-15T03:00:00Z', amountUsd: 10 }), row(),
    row({ kind: 'failed_payment', amountUsd: 999 }), row({ kind: 'autoreload_other_card', amountUsd: 999 }),
    row({ date: '2026-10-18T00:00:00Z', amountUsd: 999 }), row({ date: null }),
  ].map((entry, index) => ({ ...entry, receiptNo: `test-${index}` })), { now });
  const source = Object.values(summary.sources)[0];
  assert.equal(source.mtdUsd, 132); assert.equal(source.last48hUsd, 32); assert.equal(source.last24hUsd, 22); assert.equal(source.reloads48h, 2);
  assert.equal(source.byDay['2026-10-01'], 100); assert.equal(summary.totals.byVendor.anthropic, 132);
  assert.ok(source.events48h.includes('failed_payment'));
});
test('alerts bootstrap, new source, daily and monthly deduplication are pure', () => {
  const summary = summarizeReceipts([row({ amountUsd: 110 }), row({ kind: 'api_off', receiptNo: null })], { now });
  const state = {}, thresholds = config.thresholds;
  const first = evaluateReceiptAlerts(summary, state, thresholds, { now });
  assert.deepEqual(state, {});
  assert.deepEqual(first.alerts.map(a => a.kind), ['reload_burst', 'billing_event', 'mtd_high']);
  assert.equal(evaluateReceiptAlerts(summary, first.state, thresholds, { now }).alerts.length, 0);
  const tomorrow = evaluateReceiptAlerts(summary, first.state, thresholds, { now: new Date('2026-10-18T03:00:00Z') });
  assert.deepEqual(tomorrow.alerts.map(a => a.kind), ['reload_burst', 'billing_event']);
  assert.ok(evaluateReceiptAlerts(summary, { initialized: true }, thresholds, { now }).alerts.some(a => a.kind === 'new_billing_source'));
  assert.ok(evaluateReceiptAlerts(summary, first.state, thresholds, { now: new Date('2026-11-01') }).alerts.some(a => a.kind === 'mtd_high'));
  assert.match(formatReceiptReport(summary, first.alerts), /🚨/);
});
test('receipt count alone reaches burst threshold', () => {
  const summary = summarizeReceipts([1, 2, 3].map(index => row({ amountUsd: 1, receiptNo: `receipt-${index}` })), { now });
  assert.ok(evaluateReceiptAlerts(summary, {}, config.thresholds, { now }).alerts.some(a => a.kind === 'reload_burst'));
});
test('scan persists structured ledger, deduplicates, includes old MTD, reports failures; dry-run writes nothing', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-receipts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = { ...config, accounts: [mail.to, 'group@orgiast.jp'] };
  const searchImpl = async options => {
    assert.equal(options.max, 100); assert.equal(options.withBody, true); assert.equal(options.bodyLimit, 6000);
    if (options.user.startsWith('group')) throw new Error('unauthorized_client SECRET_MAIL_BODY');
    return { messages: [mail], estimate: 1 };
  };
  const dry = await scanAiReceipts({ home, config: settings, now, appendLedger: false, searchImpl });
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  assert.equal(dry.rows.length, 1); assert.match(dry.report, /未計測: group@orgiast.jp（unauthorized_client）/); assert.doesNotMatch(JSON.stringify(dry), /SECRET_MAIL_BODY|invoice illustration/);
  await scanAiReceipts({ home, config: settings, now, searchImpl });
  const repeat = await scanAiReceipts({ home, config: settings, now, searchImpl });
  assert.equal(repeat.rows.length, 0); assert.equal(repeat.summary.totals.mtdUsd, 22);
  const older = await scanAiReceipts({ home, config: settings, now: new Date('2026-10-25'), searchImpl: async () => ({ messages: [] }) });
  assert.equal(older.summary.totals.mtdUsd, 22);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'ai-receipts.jsonl'), 'utf8').trim().split('\n').length, 1);
});
test('scan reports truncation, and notification is a single guarded DM', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-receipts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await scanAiReceipts({ home, config: { ...config, accounts: [mail.to] }, now, appendLedger: false, searchImpl: async () => ({ messages: [mail], estimate: 101 }) });
  assert.match(result.report, /取得上限100件/);
  let calls = 0;
  const notify = async (text, options) => { calls++; assert.equal(text, result.report); assert.equal(options.webhookFallback, false); return { delivered: 'dm' }; };
  await alertAiReceipts(null, { notify }); await alertAiReceipts(result, { notify }); assert.equal(calls, 0);
  await alertAiReceipts({ ...result, alerts: [{ kind: 'billing_event' }] }, { home, now, notify }); assert.equal(calls, 1);
});

test('scan retains inbox and first To recipient, counting forwarded copies once', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-receipts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = { ...config, accounts: ['cr@orgiast.jp', mail.to] };
  const result = await scanAiReceipts({ home, config: settings, now, searchImpl: async ({ user }) => ({
    messages: [{ ...mail, id: user, to: '制作 <SEISAKU-TEAM@ORGIAST.JP>, cr@orgiast.jp' }],
  }) });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].account, 'cr@orgiast.jp');
  assert.equal(result.rows[0].recipient, mail.to);
  assert.deepEqual(Object.keys(result.summary.sources), [`${mail.to}|anthropic|-`]);
  assert.equal(result.summary.totals.mtdUsd, 22);
  assert.equal(result.summary.sources[`${mail.to}|anthropic|-`].reloads48h, 1);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'ai-receipts.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('deduplication falls back to first inbox and uses vendor, kind, subject and JST day without receipt number', () => {
  const first = row({ account: 'cr@orgiast.jp', recipient: 'external@example.com', receiptNo: null, date: '2026-10-15T16:00:00Z' });
  const copy = { ...first, account: mail.to, date: '2026-10-16T10:00:00Z' };
  const summary = summarizeReceipts([first, copy,
    { ...copy, date: '2026-10-16T16:00:00Z' },
    { ...copy, subject: 'Different receipt' },
    { ...copy, kind: 'api_off' },
    { ...copy, vendor: 'openai' },
  ], { now, config });
  assert.equal(summary.totals.mtdUsd, 88);
  assert.equal(summary.sources['cr@orgiast.jp|anthropic|-'].mtdUsd, 22);
  assert.equal(summary.sources[`${mail.to}|anthropic|-`].mtdUsd, 44);
  assert.deepEqual(summary.sources[`${mail.to}|anthropic|-`].events48h, ['receipt', 'receipt', 'api_off']);
  const legacy = summarizeReceipts([row({ recipient: null }), row({ account: 'cr@orgiast.jp', recipient: null })], { now });
  assert.equal(legacy.totals.mtdUsd, 22);
  assert.deepEqual(Object.keys(legacy.sources), [`${mail.to}|anthropic|-`]);
});

test('unique organization supplements receipts after attribution without mutating ledger rows', () => {
  const receipt = row({ account: 'cr@orgiast.jp' });
  const event = row({ kind: 'autoreload_other_card', receiptNo: null, org: "Team's Individual Org" });
  const summary = summarizeReceipts([receipt, event], { now });
  assert.deepEqual(Object.keys(summary.sources), [`${mail.to}|anthropic|${event.org}`]);
  assert.equal(Object.values(summary.sources)[0].mtdUsd, 22);
  assert.equal(receipt.org, null);
  const ambiguous = summarizeReceipts([receipt, event, { ...event, kind: 'api_off', org: 'Another Org' }], { now });
  assert.equal(ambiguous.sources[`${mail.to}|anthropic|-`].mtdUsd, 22);
  for (const unrelated of [
    { ...event, vendor: 'openai' },
    { ...event, account: 'kim@orgiast.jp', recipient: 'kim@orgiast.jp' },
  ]) {
    assert.equal(summarizeReceipts([receipt, unrelated], { now }).sources[`${mail.to}|anthropic|-`].mtdUsd, 22);
  }
});

test('report hides sources with neither MTD receipts nor recent billing events without changing alerts', () => {
  const entries = [
    row({ vendor: 'google', kind: 'other', receiptNo: null }),
    row({ vendor: 'oldreceipt', date: '2026-09-01T00:00:00Z' }),
    row({ vendor: 'oldevent', kind: 'api_off', date: '2026-10-01T00:00:00Z' }),
    row({ vendor: 'yen', amountUsd: null, amountJpy: 1234 }),
    row({ vendor: 'zero', amountUsd: 0 }),
    ...['failed_payment', 'autoreload_paused', 'autoreload_other_card', 'api_off', 'spend_limit_reached', 'spend_limit_warning', 'limit_increased', 'usage_request'].map(kind => row({ vendor: kind, kind, receiptNo: null })),
  ];
  const summary = summarizeReceipts(entries, { now });
  const before = structuredClone(summary);
  const alerts = evaluateReceiptAlerts(summary, { initialized: true }, config.thresholds, { now }).alerts;
  const report = formatReceiptReport(summary, alerts);
  for (const vendor of ['google', 'oldreceipt', 'oldevent']) assert.ok(!report.includes(` / ${vendor} / `));
  for (const entry of entries.slice(3)) assert.ok(report.includes(` / ${entry.vendor} / `));
  assert.ok(alerts.some(alert => alert.sourceKey.includes('|google|')));
  assert.match(report, /🚨 .*\|google\|/);
  assert.deepEqual(summary, before);
});

test('organization extraction normalizes ASCII and both Unicode apostrophes', () => {
  for (const quote of ["'", '’', '‘']) {
    const org = `よろしくお願いします。${quote}s Individual Org`;
    for (const body of [
      `The latest $10.93 auto-reload for ${org} went through on JCB ending in 7945.`,
      `Your organization ${quote}${org}${quote} is out of usage credits.`,
    ]) {
      assert.equal(parseReceiptMail({ ...mail, body }, config).org, "よろしくお願いします。's Individual Org");
    }
  }
});


test('receipt ledger age uses newest mtime, either file alone, and Infinity when absent', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-age-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(receiptLedgerAgeHours(home, now), Infinity);
  fs.mkdirSync(path.join(home, '.claude'));
  const ledger = path.join(home, '.claude', 'ai-receipts.jsonl');
  const state = path.join(home, '.claude', 'ai-receipts-alert-state.json');
  const writeAge = (file, hours) => { fs.writeFileSync(file, ''); const date = new Date(+now - hours * 3600e3); fs.utimesSync(file, date, date); };
  writeAge(ledger, 40);
  assert.equal(receiptLedgerAgeHours(home, now), 40);
  writeAge(state, 2);
  assert.equal(receiptLedgerAgeHours(home, now), 2);
  writeAge(ledger, 1);
  assert.equal(receiptLedgerAgeHours(home, now), 1);
  fs.unlinkSync(ledger);
  assert.equal(receiptLedgerAgeHours(home, now), 2);
});

test('CLI skips fresh data including boundary, scans stale/missing data, and honors notify', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  const state = path.join(home, '.claude', 'ai-receipts-alert-state.json');
  const keyPath = path.join(home, 'key.json'); fs.writeFileSync(keyPath, '{}');
  const logs = [], scans = [], alerts = [];
  const result = { report: 'scanned' };
  const options = { home, now, keyPath, log: line => logs.push(line), scan: async opts => { scans.push(opts); return result; }, alert: async res => alerts.push(res) };
  for (const hours of [2, 30]) {
    fs.writeFileSync(state, '{}'); const date = new Date(+now - hours * 3600e3); fs.utimesSync(state, date, date);
    await runReceiptScanCli(['--if-stale', '30', '--notify'], options);
    assert.equal(logs.at(-1), `skip: fresh (${hours.toFixed(1)}h)`);
  }
  assert.equal(scans.length, 0); assert.equal(alerts.length, 0);
  const stale = new Date(+now - 31 * 3600e3); fs.utimesSync(state, stale, stale);
  await runReceiptScanCli(['--if-stale', '30', '--notify'], options);
  fs.unlinkSync(state);
  await runReceiptScanCli(['--if-stale', '30', '--notify', '--dry-run'], options);
  assert.equal(scans.length, 2); assert.equal(alerts.length, 1); assert.equal(alerts[0], result);
  assert.equal(scans[0].appendLedger, true); assert.equal(scans[1].appendLedger, false);
  assert.equal(logs.at(-1), 'scanned');
  for (const value of [undefined, 'bad', '0', '-1', 'Infinity']) await assert.rejects(runReceiptScanCli(['--if-stale', value], options));
});

test('CLI without SA key exits successfully with one line and no scan or notification', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-no-key-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ai-receipt-scan.mjs', import.meta.url)), '--if-stale', '30', '--notify'], {
    env: { ...process.env, ORGIAST_HOME: home, GOOGLE_SA_KEY: path.join(home, 'missing.json') }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0); assert.equal(result.stdout, 'skip: no-sa-key\n'); assert.equal(result.stderr, '');
  assert.deepEqual(fs.readdirSync(home), []);
});

test('一時的な接続障害は自動再試行し、永続エラーは宛先と安全なコードを残す', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-repair-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const options = { home, config: { ...config, accounts: ['kim@orgiast.jp'] }, now, appendLedger: false };
  const recovered = await scanAiReceipts({ ...options, searchImpl: async () => {
    if (++calls === 1) throw Object.assign(new Error('secret upstream'), { cause: { code: 'ECONNRESET' } });
    return { messages: [], estimate: 0 };
  } });
  assert.equal(calls, 2); assert.deepEqual(recovered.errors, []);
  const failed = await scanAiReceipts({ ...options, searchImpl: async () => { throw Object.assign(new Error('secret path'), { code: 'ENOENT' }); } });
  assert.deepEqual(failed.errors, [{ account: 'kim@orgiast.jp', reason: '取得失敗: ENOENT' }]);
  assert.match(failed.report, /kim@orgiast.jp（取得失敗: ENOENT）/);
  assert.doesNotMatch(failed.report, /secret path|認証・接続を確認/);
});
