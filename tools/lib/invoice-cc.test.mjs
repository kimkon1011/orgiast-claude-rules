import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInvoiceCc, draftAttachmentNames } from './invoice-cc.mjs';

test('件名に請求書があるメールへ経理を追加する', () => {
  const result = applyInvoiceCc({ to: 'customer@example.com', subject: '請求書のご送付' });
  assert.deepEqual(result.cc, ['keiri2@orgiast.jp']);
  assert.equal(result.added, true);
  assert.equal(result.reason, 'subject:請求書');
});

test('件名の御請求・ご請求書・invoice（大小無視）も対象', () => {
  for (const [subject, keyword] of [
    ['御請求のご案内', '御請求'],
    ['ご請求書送付の件', '請求書'],
    ['Invoice copy', 'invoice'],
    ['INVOICE #12', 'invoice'],
  ]) {
    const result = applyInvoiceCc({ to: 'customer@example.com', subject });
    assert.equal(result.added, true, subject);
    assert.equal(result.reason, `subject:${keyword}`);
  }
});

test('添付ファイル名に請求書/invoice があれば件名なしでも対象', () => {
  const byJa = applyInvoiceCc({ to: 'customer@example.com', subject: '資料送付', attachments: ['御社向け請求書.pdf'] });
  assert.equal(byJa.added, true);
  assert.equal(byJa.reason, 'attachment:請求書');
  const byEn = applyInvoiceCc({ to: 'a@b.com', subject: 'files', attachments: [{ name: 'Invoice-2026.pdf' }] });
  assert.equal(byEn.added, true);
  assert.equal(byEn.reason, 'attachment:invoice');
});

test('見積書・申込書だけのメールは対象外', () => {
  for (const subject of ['お見積書のご送付', '申込書の確認', '制作のお見積り']) {
    const result = applyInvoiceCc({ to: 'customer@example.com', subject, attachments: ['見積書.pdf'] });
    assert.deepEqual(result.cc, []);
    assert.equal(result.added, false);
    assert.equal(result.reason, 'not_invoice');
  }
});

test('本文に請求書言及があっても件名・添付が無ければ対象外', () => {
  const result = applyInvoiceCc({
    to: 'customer@example.com',
    subject: '日程のご相談',
    body: '請求書は別メールで送ります',
  });
  assert.equal(result.added, false);
  assert.equal(result.reason, 'not_invoice');
});

test('既に To/CC にあれば大小無視・表示名付きでも重複追加しない', () => {
  const inCc = applyInvoiceCc({
    to: 'customer@example.com',
    cc: '経理 <Keiri2@Orgiast.jp>',
    subject: '請求書',
  });
  assert.deepEqual(inCc.cc, ['経理 <Keiri2@Orgiast.jp>']);
  assert.equal(inCc.added, false);

  const inTo = applyInvoiceCc({
    to: '経理部 <keiri2@orgiast.jp>',
    cc: 'other@example.com',
    subject: 'Invoice',
  });
  assert.deepEqual(inTo.cc, ['other@example.com']);
  assert.equal(inTo.added, false);
});

test('draftAttachmentNames は入れ子 MIME の filename を集める', () => {
  assert.deepEqual(draftAttachmentNames({
    parts: [
      { mimeType: 'text/plain' },
      { filename: '請求書.pdf', body: { attachmentId: 'a1' } },
      { parts: [{ filename: 'invoice.xlsx' }] },
    ],
  }), ['請求書.pdf', 'invoice.xlsx']);
});
