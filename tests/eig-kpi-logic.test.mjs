#!/usr/bin/env node
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateKpi, jstDay, alertKey, LABELS, normalizeCompany, emailAddress, isHumanExternal, masterRows, deterministicClass, DEADLINES } from '../tools/lib/eig-kpi-logic.mjs';

describe('eig-kpi-logic', () => {
  describe('jstDay', () => {
    it('returns YYYY-MM-DD for a known JST date', () => {
      const d = new Date('2026-11-17T05:00:00Z'); // 14:00 JST
      assert.equal(jstDay(d), '2026-11-17');
    });
    it('rolls over at JST midnight', () => {
      const d = new Date('2026-11-17T14:59:00Z'); // 23:59 JST = still 11/17
      assert.equal(jstDay(d), '2026-11-17');
      const d2 = new Date('2026-11-17T15:01:00Z'); // 00:01 JST = 11/18
      assert.equal(jstDay(d2), '2026-11-18');
    });
  });

  describe('evaluateKpi', () => {
    it('returns "期限前" before the earliest deadline', () => {
      const result = evaluateKpi('2026-11-19', { registrations: 0, positiveCompanies: 0 });
      assert.equal(result.status, '期限前');
      assert.deepEqual(result.deficits, []);
      assert.deepEqual(result.unknown, []);
    });

    it('returns "順調" when all targets are met', () => {
      const result = evaluateKpi('2026-11-21', { registrations: 5, positiveCompanies: 1 });
      assert.equal(result.status, '順調');
      assert.deepEqual(result.deficits, []);
    });

    it('returns "遅れ" when registrations are below target', () => {
      const result = evaluateKpi('2026-11-21', { registrations: 2, positiveCompanies: 1 });
      assert.equal(result.status, '遅れ');
      assert.deepEqual(result.deficits.map(d => d.key), ['registrations']);
      assert.deepEqual(result.deficits[0].missing, 3);
    });

    it('returns "遅れ" when positiveCompanies are below target', () => {
      const result = evaluateKpi('2026-11-24', { registrations: 10, positiveCompanies: 1 });
      assert.equal(result.status, '遅れ');
      assert.deepEqual(result.deficits.map(d => d.key), ['positiveCompanies']);
      assert.equal(result.deficits[0].missing, 1);
    });

    it('flags both deficits when multiple targets are missed', () => {
      const result = evaluateKpi('2026-11-24', { registrations: 5, positiveCompanies: 0 });
      assert.equal(result.status, '遅れ');
      assert.equal(result.deficits.length, 2);
      assert.ok(result.deficits.some(d => d.key === 'registrations' && d.missing === 5));
      assert.ok(result.deficits.some(d => d.key === 'positiveCompanies' && d.missing === 2));
    });

    it('returns "要確認" when metric is null/undefined', () => {
      const result = evaluateKpi('2026-11-21', { registrations: null, positiveCompanies: 1 });
      assert.equal(result.status, '要確認');
      assert.deepEqual(result.unknown, ['registrations']);
    });

    it('returns "要確認" when there are external errors', () => {
      const result = evaluateKpi('2026-11-21', { registrations: 5, positiveCompanies: 1 }, ['Gmail failure']);
      assert.equal(result.status, '要確認');
    });

    it('handles confirmedCompanies + cafe212 target on 11-26', () => {
      const passing = evaluateKpi('2026-11-26', { registrations: 15, positiveCompanies: 3, confirmedCompanies: 3, cafe212: 1 });
      assert.equal(passing.status, '順調');
      const failing = evaluateKpi('2026-11-26', { registrations: 15, positiveCompanies: 3, confirmedCompanies: 2, cafe212: 1 });
      assert.equal(failing.status, '遅れ');
      assert.deepEqual(failing.deficits.map(d => d.key), ['confirmedCompanies']);
    });

    it('handles 12-07 presenters target', () => {
      const result = evaluateKpi('2026-12-07', { registrations: 30, presenters: 8 });
      assert.equal(result.status, '遅れ');
      assert.deepEqual(result.deficits.map(d => d.key), ['presenters']);
    });

    it('accumulates all deadlines up to the given day', () => {
      // By 12-07, all previous deadlines should apply
      const result = evaluateKpi('2026-12-07', {
        registrations: 30, presenters: 0, positiveCompanies: 3,
        confirmedCompanies: 3, cafe212: 1, submissions: 5,
      });
      // Only presenters should be a deficit
      assert.equal(result.status, '遅れ');
      assert.deepEqual(result.deficits.map(d => d.key), ['presenters']);
    });
  });

  describe('alertKey', () => {
    it('generates a reproducible key', () => {
      assert.equal(alertKey('2026-11-17', 'delay'), 'eig-kpi-watch:2026-11-17:delay');
      assert.equal(alertKey('2026-11-17', 'source-error'), 'eig-kpi-watch:2026-11-17:source-error');
    });
  });

  describe('LABELS', () => {
    it('every DEADLINES key has a label', () => {
      for (const [, goals] of DEADLINES) {
        for (const key of Object.keys(goals)) {
          assert.ok(LABELS[key], `Missing label for ${key}`);
        }
      }
    });
  });

  describe('normalizeCompany', () => {
    it('normalizes NFKC and removes suffixes', () => {
      assert.equal(normalizeCompany('株式会社テスト'), 'テスト');
      assert.equal(normalizeCompany('有限会社 サンプル'), 'サンプル');
    });
    it('detects Cafe 212 variants', () => {
      assert.equal(normalizeCompany('Cafe 212'), 'cafe212');
      assert.equal(normalizeCompany('Cafe212（大阪・深江橋）'), 'cafe212');
    });
  });

  describe('emailAddress', () => {
    it('extracts email from text', () => {
      assert.equal(emailAddress('contact@example.com'), 'contact@example.com');
      assert.equal(emailAddress('名前 <name@test.co.jp>'), 'name@test.co.jp');
    });
    it('returns empty string for no match', () => {
      assert.equal(emailAddress('no email here'), '');
    });
  });

  describe('isHumanExternal', () => {
    it('rejects orgiast.jp addresses', () => {
      assert.equal(isHumanExternal({ from: 'kim@orgiast.jp' }), false);
      assert.equal(isHumanExternal({ from: 'seisaku-team@orgiast.jp' }), false);
    });
    it('rejects auto-reply/no-reply addresses', () => {
      assert.equal(isHumanExternal({ from: 'noreply@example.com' }), false);
      assert.equal(isHumanExternal({ from: 'mailer-daemon@google.com' }), false);
    });
    it('rejects Peatix and Google system senders', () => {
      assert.equal(isHumanExternal({ from: 'noreply@peatix.com' }), false);
      assert.equal(isHumanExternal({ from: 'notifications@google.com' }), false);
    });
    it('rejects auto-submitted messages', () => {
      assert.equal(isHumanExternal({ from: 'user@gmail.com', autoSubmitted: 'auto-replied' }), false);
    });
    it('rejects bulk precedence messages', () => {
      assert.equal(isHumanExternal({ from: 'user@gmail.com', precedence: 'bulk' }), false);
    });
    it('rejects sent/draft labels', () => {
      assert.equal(isHumanExternal({ from: 'user@gmail.com', labels: ['SENT'] }), false);
      assert.equal(isHumanExternal({ from: 'user@gmail.com', labels: ['DRAFT'] }), false);
    });
    it('accepts a genuine external human email', () => {
      assert.equal(isHumanExternal({
        from: 'owner@restaurant.co.jp',
        subject: 'Re: 飲食×AI ピッチコンテスト',
        autoSubmitted: '',
        precedence: '',
        labels: ['INBOX'],
      }), true);
    });
  });

  describe('deterministicClass', () => {
    it('classifies confirmed', () => {
      assert.equal(deterministicClass('確定'), 'confirmed');
      assert.equal(deterministicClass('参加確定'), 'confirmed');
      assert.equal(deterministicClass('承諾済み'), 'confirmed');
    });
    it('classifies positive', () => {
      assert.equal(deterministicClass('前向き'), 'positive');
      assert.equal(deterministicClass('前向き検討中'), 'positive');
    });
    it('classifies declined', () => {
      assert.equal(deterministicClass('辞退'), 'declined');
      assert.equal(deterministicClass('不参加'), 'declined');
    });
    it('returns "other" for status labels that are not judgments', () => {
      assert.equal(deterministicClass('返信待ち'), 'other');
      assert.equal(deterministicClass('送信済み'), 'other');
      assert.equal(deterministicClass('未打診'), 'other');
    });
    it('returns null for truly ambiguous input', () => {
      assert.equal(deterministicClass('問い合わせ中'), null);
      assert.equal(deterministicClass('こちらから連絡'), null);
    });
  });

  describe('masterRows', () => {
    const header = ['送信日', '返信', '状態', '会社名', 'メール'];
    it('parses company rows', () => {
      const values = [
        header,
        ['2026/11/15', '11/15 返信あり', '前向き検討', 'テスト株式会社', 'test@example.com'],
        ['', '', '未送信', '', ''],
        ['2026/11/16', '', '返信待ち', 'サンプル有限会社', 'sample@test.jp'],
        ['2026/11/15', '', '辞退', '辞退会社', 'declined@test.jp'],
      ];
      const result = masterRows(values, 'company');
      assert.equal(result.total, 3); // empty row skipped
      assert.equal(result.sent, 3); // all 3 non-empty have dates
      assert.equal(result.replies, 1); // only 1 has reply text
      assert.deepEqual(result.states, { '前向き検討': 1, '返信待ち': 1, '辞退': 1 });
    });
  });
});