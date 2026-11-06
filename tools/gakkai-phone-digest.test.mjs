// gakkai-phone-digest のテスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// パース関数のテスト（本体から分離して直接テスト）
function parsePhoneMessage(content) {
  const m = content.match(/^PHONE\s+(S\d{3,4})\s*\|\s*([\d.]+),([\d.]+)\s*\|\s*([\d.]+)m?\s*\|\s*(\d+)%\s*\|\s*(.+)$/);
  if (!m) return null;
  return {
    phone: m[1],
    lat: parseFloat(m[2]),
    lng: parseFloat(m[3]),
    accuracy: parseInt(m[4], 10),
    battery: parseInt(m[5], 10),
    timestamp: new Date(m[6].trim()),
  };
}

describe('parsePhoneMessage', () => {
  it('parses valid message', () => {
    const result = parsePhoneMessage('PHONE S003 | 35.123456,135.123456 | 12m | 85% | 2026-11-07T10:00:00.000Z');
    assert(result);
    assert.equal(result.phone, 'S003');
    assert.equal(result.lat, 35.123456);
    assert.equal(result.lng, 135.123456);
    assert.equal(result.accuracy, 12);
    assert.equal(result.battery, 85);
    assert.equal(result.timestamp.toISOString(), '2026-11-07T10:00:00.000Z');
  });

  it('parses message without m suffix on accuracy', () => {
    const result = parsePhoneMessage('PHONE S005 | 34.5,133.2 | 10 | 50% | 2026-11-01T00:00:00.000Z');
    assert(result);
    assert.equal(result.phone, 'S005');
    assert.equal(result.accuracy, 10);
    assert.equal(result.battery, 50);
  });

  it('parses message with S008', () => {
    const result = parsePhoneMessage('PHONE S008 | 34.9876,135.4321 | 8m | 92% | 2026-11-05T15:30:00.000Z');
    assert(result);
    assert.equal(result.phone, 'S008');
    assert.equal(result.lat, 34.9876);
    assert.equal(result.timestamp.getTime(), new Date('2026-11-05T15:30:00.000Z').getTime());
  });

  it('rejects non-PHONE messages', () => {
    assert.equal(parsePhoneMessage('Hello world'), null);
  });

  it('rejects empty content', () => {
    assert.equal(parsePhoneMessage(''), null);
  });

  it('rejects malformed PHONE message', () => {
    assert.equal(parsePhoneMessage('PHONE S003 missing pipes'), null);
  });

  it('rejects PHONE with wrong prefix', () => {
    assert.equal(parsePhoneMessage('PHONE X999 | 1,2 | 3m | 4% | 2026-01-01T00:00:00Z'), null);
  });

  it('rejects missing fields', () => {
    assert.equal(parsePhoneMessage('PHONE S002 | 1,2 | 3m'), null);
  });
});