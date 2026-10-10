import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_VALUES,
  SERVICE_KEYS,
  BOOTH_OPTIONS,
  validateEntry,
  normalizeEntry,
  sanitizeLoadedData,
  parseData,
  serializeData,
  entryStats,
  toCsv,
  toMarkdown,
  validDate,
  validEmail,
  validUrl,
} from '../expo-apply-core.mjs';

const sampleValidInput = {
  companyName: 'Global Tech Inc.',
  companyNameJa: 'グローバルテック',
  country: 'United States',
  website: 'https://globaltech.example.com',
  contactPerson: 'Jane Doe',
  email: 'jane@globaltech.example.com',
  phone: '+1-555-0199',
  exhibitionName: 'Tokyo Tech Expo 2026',
  boothSize: '9m2',
  periodUndecided: false,
  startDate: '2026-11-10',
  endDate: '2026-11-12',
  servicesNeeded: ['booth_design', 'interpretation'],
  message: 'Looking forward to participating.',
};

test('Constants export expected frozen arrays', () => {
  assert.deepEqual(STATUS_VALUES, ['new', 'contacted', 'accepted', 'cancelled']);
  assert.equal(Object.isFrozen(STATUS_VALUES), true);
  assert.ok(SERVICE_KEYS.includes('booth_design'));
  assert.ok(BOOTH_OPTIONS.includes('9m2'));
});

test('validDate, validEmail, and validUrl helper functions', () => {
  assert.equal(validDate('2026-11-10'), true);
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('invalid'), false);

  assert.equal(validEmail('user@domain.com'), true);
  assert.equal(validEmail('invalid-email'), false);

  assert.equal(validUrl('https://example.com'), true);
  assert.equal(validUrl('example.com'), true);
  assert.equal(validUrl('ht://bad url'), false);
});

test('validateEntry enforces required fields and format checks', () => {
  const emptyRes = validateEntry({});
  assert.equal(emptyRes.ok, false);
  const fields = emptyRes.errors.map((e) => e.field);
  assert.ok(fields.includes('companyName'));
  assert.ok(fields.includes('country'));
  assert.ok(fields.includes('contactPerson'));
  assert.ok(fields.includes('email'));
  assert.ok(fields.includes('exhibitionName'));

  const validRes = validateEntry(sampleValidInput);
  assert.equal(validRes.ok, true);
  assert.deepEqual(validRes.errors, []);
});

test('validateEntry detects invalid email, website, and date sequence', () => {
  const badEmailRes = validateEntry({ ...sampleValidInput, email: 'not-an-email' });
  assert.equal(badEmailRes.ok, false);
  assert.ok(badEmailRes.errors.some((e) => e.field === 'email' && e.messageKey === 'errors.email'));

  const badUrlRes = validateEntry({ ...sampleValidInput, website: 'ht://bad url' });
  assert.equal(badUrlRes.ok, false);
  assert.ok(badUrlRes.errors.some((e) => e.field === 'website' && e.messageKey === 'errors.url'));

  const badDateOrderRes = validateEntry({
    ...sampleValidInput,
    startDate: '2026-11-12',
    endDate: '2026-11-10',
  });
  assert.equal(badDateOrderRes.ok, false);
  assert.ok(badDateOrderRes.errors.some((e) => e.field === 'endDate' && e.messageKey === 'errors.dateOrder'));
});

test('validateEntry requires boothSizeOther when boothSize is other', () => {
  const missingOtherRes = validateEntry({ ...sampleValidInput, boothSize: 'other', boothSizeOther: '' });
  assert.equal(missingOtherRes.ok, false);
  assert.ok(missingOtherRes.errors.some((e) => e.field === 'boothSizeOther'));

  const validOtherRes = validateEntry({
    ...sampleValidInput,
    boothSize: 'other',
    boothSizeOther: 'Custom 50m2 Pavilion',
  });
  assert.equal(validOtherRes.ok, true);
});

test('normalizeEntry trims strings, filters services, and sets defaults', () => {
  const raw = {
    companyName: '  Acme Corp  ',
    email: ' info@acme.com ',
    boothSize: 'invalid_size',
    servicesNeeded: ['booth_design', 'invalid_service', 'booth_design'],
    status: 'unknown_status',
  };

  const normalized = normalizeEntry(raw, 'fallback-id-123', '2026-10-11T10:00:00.000Z');
  assert.equal(normalized.id, 'fallback-id-123');
  assert.equal(normalized.companyName, 'Acme Corp');
  assert.equal(normalized.email, 'info@acme.com');
  assert.equal(normalized.boothSize, 'undecided');
  assert.deepEqual(normalized.servicesNeeded, ['booth_design']);
  assert.equal(normalized.status, 'new');
  assert.equal(normalized.createdAt, '2026-10-11T10:00:00.000Z');
});

test('sanitizeLoadedData repairs broken structure and duplicate IDs', () => {
  const invalidJsonParsed = sanitizeLoadedData(null);
  assert.equal(invalidJsonParsed.data.applications.length, 0);
  assert.ok(invalidJsonParsed.warnings.length > 0);

  const duplicateIdData = {
    version: 1,
    applications: [
      { id: 'dup-1', companyName: 'Company A', country: 'US', contactPerson: 'Alice', email: 'a@a.com', exhibitionName: 'Expo A' },
      { id: 'dup-1', companyName: 'Company B', country: 'JP', contactPerson: 'Bob', email: 'b@b.com', exhibitionName: 'Expo B' },
    ],
  };

  const sanitized = sanitizeLoadedData(duplicateIdData);
  assert.equal(sanitized.data.applications.length, 2);
  assert.equal(sanitized.data.applications[0].id, 'dup-1');
  assert.equal(sanitized.data.applications[1].id, 'dup-1-1');
  assert.ok(sanitized.warnings.some((w) => w.includes('Duplicate or missing ID repaired')));
});

test('parseData and serializeData handle JSON roundtrip', () => {
  const parsedRes = parseData('invalid json text');
  assert.equal(parsedRes.data.applications.length, 0);
  assert.ok(parsedRes.warnings.length > 0);

  const initialData = {
    version: 1,
    applications: [normalizeEntry(sampleValidInput, 'id-001', '2026-10-10T12:00:00.000Z')],
  };

  const jsonStr = serializeData(initialData);
  const roundtrip = parseData(jsonStr);
  assert.equal(roundtrip.data.applications.length, 1);
  assert.equal(roundtrip.data.applications[0].companyName, 'Global Tech Inc.');
});

test('entryStats aggregates counts and recent 7 days filter', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const recentDate = new Date('2026-10-09T10:00:00Z').toISOString();
  const oldDate = new Date('2026-09-01T10:00:00Z').toISOString();

  const entries = [
    { id: '1', status: 'new', createdAt: recentDate },
    { id: '2', status: 'contacted', createdAt: recentDate },
    { id: '3', status: 'accepted', createdAt: oldDate },
    { id: '4', status: 'cancelled', createdAt: oldDate },
  ];

  const stats = entryStats(entries, now);
  assert.equal(stats.total, 4);
  assert.equal(stats.new, 1);
  assert.equal(stats.contacted, 1);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.recentCount, 2);
});

test('toCsv escapes quotes, commas, and line breaks properly', () => {
  const entries = [
    {
      id: 'csv-1',
      companyName: 'Acme, Inc.',
      message: 'Line 1\nLine 2 with "quotes"',
      country: 'Japan',
    },
  ];

  const csv = toCsv(entries);
  assert.ok(csv.includes('ID,Company Name'));
  assert.ok(csv.includes('"Acme, Inc."'));
  assert.ok(csv.includes('"Line 1\nLine 2 with ""quotes"""'));
});

test('toMarkdown generates formatted markdown table', () => {
  const emptyMdEn = toMarkdown([]);
  assert.ok(emptyMdEn.includes('# Trade Show Exhibition Applications'));
  assert.ok(emptyMdEn.includes('(No applications registered)'));

  const emptyMdJa = toMarkdown([], 'ja');
  assert.ok(emptyMdJa.includes('# 展示会出展申込一覧'));
  assert.ok(emptyMdJa.includes('（登録データなし）'));

  const entries = [normalizeEntry(sampleValidInput, '12345678-uuid', '2026-10-10T12:00:00Z')];
  const md = toMarkdown(entries, 'en');
  assert.ok(md.includes('| 12345678 | Global Tech Inc. | United States |'));
});
