import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { googleClient } from './deadline-ledger.mjs';
import { collectReadableContent, extractGoogleUrls, readGoogleDoc, extractPdfText, trimBytes, extractPdfViaDriveOcr } from './lib/autoreply-attachments.mjs';

// Helper: create a mock request function for readGoogleDoc
function mockRequest(handlers) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, ...options });
    const u = new URL(url);
    const pathKey = u.pathname;
    if (u.pathname.endsWith('/values:batchGet')) {
      const valueRanges = [];
      for (const range of u.searchParams.getAll('ranges')) {
        const title = range.slice(1, -1).replace(/''/g, "'");
        valueRanges.push(await fn(`https://sheets.googleapis.com/v4/spreadsheets/mock/values/${encodeURIComponent(title)}`, options));
      }
      return { valueRanges };
    }
    // Find matching handler
    for (const [pattern, handler] of handlers) {
      if (pattern.test(url)) {
        const result = handler(url, options, u);
        if (result === '__throw__') throw new Error('denied');
        return result;
      }
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  fn.calls = () => calls;
  return fn;
}

// ============================================================
// extractGoogleUrls — gid extraction
// ============================================================

test('extractGoogleUrls: gid from #gid= in hash', () => {
  const urls = extractGoogleUrls('https://docs.google.com/spreadsheets/d/abc123/edit#gid=456');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].id, 'abc123');
  assert.equal(urls[0].gid, 456);
});

test('extractGoogleUrls: gid from ?gid= in query', () => {
  const urls = extractGoogleUrls('https://docs.google.com/spreadsheets/d/abc123/edit?gid=789');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].id, 'abc123');
  assert.equal(urls[0].gid, 789);
});

test('extractGoogleUrls: gid from open?id= with #gid=', () => {
  const urls = extractGoogleUrls('https://docs.google.com/spreadsheets/d/abc123/edit#gid=0');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].gid, 0);
});

test('extractGoogleUrls: no gid when none present', () => {
  const urls = extractGoogleUrls('https://docs.google.com/document/d/doc1/edit');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].gid, undefined);
});

test('extractGoogleUrls: Drive URL with no gid', () => {
  const urls = extractGoogleUrls('https://drive.google.com/file/d/drive123/view');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].gid, undefined);
});

// ============================================================
// readGoogleDoc — spreadsheet all tabs
// ============================================================

test('readGoogleDoc: spreadsheet reads all tabs via Sheets API', async () => {
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'sheet1', name: 'Test Sheet', mimeType: 'application/vnd.google-apps.spreadsheet' })],
    [/sheets\.googleapis.*fields=sheets\.properties/, () => ({
      sheets: [
        { properties: { sheetId: 0, title: 'Sheet1' } },
        { properties: { sheetId: 1, title: 'Sheet2' } },
      ],
    })],
    [/sheets\.googleapis.*values\/Sheet1/, () => ({ values: [['A1', 'B1'], ['A2', 'B2']] })],
    [/sheets\.googleapis.*values\/Sheet2/, () => ({ values: [['C1', 'D1']] })],
  ]);
  const result = await readGoogleDoc('sheet1', { request: req });
  assert.ok(result.text);
  assert.equal(result.images, null);
  assert.match(result.text, /## Sheet1/);
  assert.match(result.text, /A1\tB1/);
  assert.match(result.text, /## Sheet2/);
  assert.match(result.text, /C1\tD1/);
});

test('readGoogleDoc: spreadsheet first tab empty reads second tab', async () => {
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'sheet1', name: 'Test', mimeType: 'application/vnd.google-apps.spreadsheet' })],
    [/fields=sheets\.properties/, () => ({ sheets: [{ properties: { sheetId: 0, title: 'Empty' } }, { properties: { sheetId: 1, title: 'Data' } }] })],
    [/values\/Empty/, () => ({ values: [] })],
    [/values\/Data/, () => ({ values: [['val1']] })],
  ]);
  const result = await readGoogleDoc('sheet1', { request: req });
  assert.ok(result.text);
  assert.doesNotMatch(result.text, /## Empty/);
  assert.match(result.text, /## Data/);
  assert.match(result.text, /val1/);
});

test('readGoogleDoc: spreadsheet gid priority reorders tabs', async () => {
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'sheet1', name: 'Test', mimeType: 'application/vnd.google-apps.spreadsheet' })],
    [/fields=sheets\.properties/, () => ({
      sheets: [
        { properties: { sheetId: 0, title: 'First' } },
        { properties: { sheetId: 123, title: 'Second' } },
        { properties: { sheetId: 456, title: 'Third' } },
      ],
    })],
    [/values\/Second/, () => ({ values: [['gid-data']] })],
    [/values\/First/, () => ({ values: [['first-data']] })],
    [/values\/Third/, () => ({ values: [['third-data']] })],
  ]);
  // gid=123 → "Second" should be first
  const result = await readGoogleDoc('sheet1', { request: req, gid: 123 });
  assert.ok(result.text);
  // Second should appear before First
  const secondIdx = result.text.indexOf('gid-data');
  const firstIdx = result.text.indexOf('first-data');
  assert.ok(secondIdx >= 0 && firstIdx >= 0);
  assert.ok(secondIdx < firstIdx, 'gid-prioritized tab should come first');
});

test('readGoogleDoc: all tabs empty throws', async () => {
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'sheet1', name: 'Empty Sheet', mimeType: 'application/vnd.google-apps.spreadsheet' })],
    [/fields=sheets\.properties/, () => ({ sheets: [{ properties: { sheetId: 0, title: 'Empty1' } }, { properties: { sheetId: 1, title: 'Empty2' } }] })],
    [/values\//, () => ({ values: [] })],
  ]);
  await assert.rejects(() => readGoogleDoc('sheet1', { request: req }), /empty/);
});

// ============================================================
// readGoogleDoc — Drive PDF
// ============================================================

test('readGoogleDoc: Drive PDF returns text via extractPdfText', async () => {
  const pdfBytes = Buffer.from('%PDF-1.4 test');
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'pdf1', name: 'doc.pdf', mimeType: 'application/pdf' })],
    [/\?alt=media/, () => pdfBytes],
  ]);
  const result = await readGoogleDoc('pdf1', { request: req, extractPdf: async bytes => {
    assert.equal(bytes, pdfBytes);
    return 'PDF extracted text';
  } });
  assert.ok(result.text);
  assert.match(result.text, /PDF extracted text/);
  assert.equal(result.images, null);
});

// ============================================================
// readGoogleDoc — Drive image
// ============================================================

test('readGoogleDoc: Drive image returns images array', async () => {
  const imgBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'img1', name: 'photo.png', mimeType: 'image/png' })],
    [/\?alt=media/, () => imgBytes],
  ]);
  const result = await readGoogleDoc('img1', { request: req });
  assert.equal(result.text, null);
  assert.ok(Array.isArray(result.images));
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mime, 'image/png');
  assert.ok(result.images[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(result.images[0].name, 'photo.png');
});

// ============================================================
// readGoogleDoc — xlsx temporary copy deleted
// ============================================================

test('readGoogleDoc: xlsx creates temp copy, reads, and deletes', async () => {
  let copyCreated = false;
  let copyDeleted = false;
  let copyId = 'copy-temp-12345';
  // Simple request mock that handles all calls
  const req = async (url, opts = {}) => {
    const u = url;
    // File metadata
    if (u.includes('mimeType')) return { id: 'xlsx1', name: 'data.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    // Copy creation
    if (u.includes('/copy') && opts.method === 'POST') {
      copyCreated = true;
      // body is already an object (not JSON string) from the caller
      const b = opts.body || {};
      assert.match(b.mimeType || '', /google-apps\.spreadsheet/);
      return { id: copyId };
    }
    // Permissions
    if (u.includes('permissions')) return { permissions: [{ emailAddress: 'kim@orgiast.jp', role: 'writer' }] };
    // Sheets API metadata
    if (u.includes('sheets.properties')) return { sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] };
    // Sheets API values
    if (u.includes('/values:batchGet')) return { valueRanges: [{ values: [['H1', 'H2'], ['V1', 'V2']] }] };
    // DELETE of temp copy
    if (opts.method === 'DELETE') {
      copyDeleted = true;
      return '';
    }
    throw new Error(`Unexpected call: ${u} method=${opts.method}`);
  };
  req.calls = () => [];
  const result = await readGoogleDoc('xlsx1', { request: req });
  assert.ok(result.text);
  assert.match(result.text, /## Sheet1/);
  assert.match(result.text, /H1\tH2/);
  assert.equal(result.images, null);
  assert.equal(copyCreated, true, 'temp copy should be created');
  assert.equal(copyDeleted, true, 'temp copy should be deleted');
});

test('readGoogleDoc: xlsx temp copy deleted even on failure', async () => {
  let copyDeleted = false;
  let copyId = 'copy-fail-123';
  const req = async (url, opts = {}) => {
    // File metadata
    if (url.includes('mimeType')) return { id: 'xlsx1', name: 'data.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    // Copy creation
    if (url.includes('/copy') && opts.method === 'POST') return { id: copyId };
    // Permissions
    if (url.includes('permissions')) return { permissions: [{ emailAddress: 'kim@orgiast.jp', role: 'writer' }] };
    // Sheets API — cause failure by returning empty
    if (url.includes('sheets')) return { sheets: [] };
    // DELETE
    if (opts.method === 'DELETE') {
      copyDeleted = true;
      return '';
    }
    throw new Error(`Unexpected: ${url}`);
  };
  await assert.rejects(() => readGoogleDoc('xlsx1', { request: req }), /empty/);
  assert.equal(copyDeleted, true, 'temp copy should be deleted even on failure');
});

// ============================================================
// readGoogleDoc — unsupported format
// ============================================================

test('readGoogleDoc: unsupported mime type throws', async () => {
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'unknown', name: 'file.xyz', mimeType: 'application/octet-stream' })],
  ]);
  await assert.rejects(() => readGoogleDoc('unknown', { request: req }), /unsupported/);
});

// ============================================================
// collectReadableContent — Drive image via Google URL
// ============================================================

test('collectReadableContent: Google Drive image URL adds to images', async () => {
  const result = await collectReadableContent({
    messages: [{ text: '画像あります https://drive.google.com/file/d/img123/view' }],
    downloadAttachment: async () => { throw new Error('must not call'); },
    readGoogleUrl: async (fileId) => {
      assert.equal(fileId, 'img123');
      return { text: null, images: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,abc', name: 'photo.png' }] };
    },
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mime, 'image/png');
  assert.equal(result.documents.length, 0);
  assert.equal(result.failures.length, 0);
});

test('collectReadableContent: Google Drive PDF URL adds to documents', async () => {
  const result = await collectReadableContent({
    messages: [{ text: 'https://drive.google.com/file/d/pdf456/view' }],
    downloadAttachment: async () => { throw new Error('must not call'); },
    readGoogleUrl: async (fileId) => {
      assert.equal(fileId, 'pdf456');
      return { text: 'PDF extracted content', images: null };
    },
  });
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].source, 'google_url');
  assert.match(result.documents[0].text, /PDF extracted/);
  assert.equal(result.images.length, 0);
  assert.equal(result.failures.length, 0);
});

test('collectReadableContent: Drive image with existing images at maxImages', async () => {
  const result = await collectReadableContent({
    messages: [
      { attachments: [{ fileName: 'img1.png', mimeType: 'image/png', url: 'https://cdn.discord.com/1.png' }] },
      { text: 'https://drive.google.com/file/d/img456/view', id: 'msg2' },
    ],
    downloadAttachment: async () => Buffer.from([0]),
    readGoogleUrl: async () => ({ text: null, images: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,a', name: 'drive.png' }] }),
    maxImages: 1,
    targetIds: new Set(['msg2']),
  });
  // Only the target message's image should be in images (discord image is context, under max)
  assert.equal(result.images.length, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(result.contextFailures.length, 0);
});

// ============================================================
// collectReadableContent — backward compat string return
// ============================================================

test('collectReadableContent: readGoogleUrl returning string (backward compat)', async () => {
  const result = await collectReadableContent({
    messages: [{ text: 'https://docs.google.com/document/d/doc123/edit' }],
    downloadAttachment: async () => { throw new Error('must not call'); },
    readGoogleUrl: async (fileId) => {
      assert.equal(fileId, 'doc123');
      return 'Legacy string document text';
    },
  });
  assert.equal(result.documents.length, 1);
  assert.match(result.documents[0].text, /Legacy string/);
  assert.equal(result.failures.length, 0);
});

// ============================================================
// collectReadableContent — Google URL document limit (5)
// ============================================================

test('collectReadableContent: Google URL documents over 5 are failures', async () => {
  const text = Array.from({ length: 6 }, (_, i) => `https://docs.google.com/document/d/doc${i}/edit`).join(' ');
  const result = await collectReadableContent({
    messages: [{ text }],
    downloadAttachment: async () => { throw new Error('must not call'); },
    readGoogleUrl: async (fileId) => {
      return { text: `Document ${fileId} content`, images: null };
    },
  });
  assert.equal(result.documents.length, 5);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /上限超過/);
});

// ============================================================
// extractGoogleUrls — dedup
// ============================================================

test('extractGoogleUrls: dedup same ID', () => {
  const urls = extractGoogleUrls('https://docs.google.com/document/d/abc123/edit https://docs.google.com/document/d/abc123/view');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].id, 'abc123');
});

test('extractGoogleUrls: Drive open?id= URL', () => {
  const urls = extractGoogleUrls('https://drive.google.com/file/d/driveFile/view?usp=sharing');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].id, 'driveFile');
  // For the drive.google.com/file/d/ pattern, type is the match[1] group (the file ID)
  assert.equal(urls[0].type, 'drive');
});

// ============================================================
// readGoogleDoc — text file
// ============================================================

test('readGoogleDoc: text file returns text', async () => {
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'txt1', name: 'notes.txt', mimeType: 'text/plain' })],
    [/\?alt=media/, () => 'This is a text file.'],
  ]);
  const result = await readGoogleDoc('txt1', { request: req });
  assert.ok(result.text);
  assert.match(result.text, /text file/);
  assert.equal(result.images, null);
});

// ============================================================
// readGoogleDoc — Google Slides
// ============================================================

test('readGoogleDoc: Google Slides exports text/plain', async () => {
  const req = mockRequest([
    [/fields=id,name,mimeType/, () => ({ id: 'slides1', name: 'Deck', mimeType: 'application/vnd.google-apps.presentation' })],
    [/export\?mimeType=text%2Fplain/, () => 'Slide text content'],
  ]);
  const result = await readGoogleDoc('slides1', { request: req });
  assert.ok(result.text);
  assert.match(result.text, /Slide text/);
  assert.equal(result.images, null);
});

// ============================================================
// trimBytes
// ============================================================

test('trimBytes cuts at byte boundary', () => {
  const text = 'a'.repeat(31000);
  const clipped = trimBytes(text, 30000);
  assert.ok(Buffer.byteLength(clipped) <= 30000);
  assert.ok(clipped.length <= 30000);
});

test('trimBytes handles multi-byte chars at boundary', () => {
  const text = 'あ'.repeat(10001); // each 3 bytes
  const clipped = trimBytes(text, 30000);
  assert.ok(Buffer.byteLength(clipped) <= 30000);
  // Ensure no broken surrogate at end
  assert.equal(clipped.at(-1) === '�', false);
});
test('batchGet uses quoted whole-tab ranges, gid priority and 30000-byte truncation', async () => {
  let batches = 0;
  const result = await readGoogleDoc('synthetic-sheet', { gid: 2, request: async url => {
    const u = new URL(url);
    if (u.hostname === 'www.googleapis.com') {
      assert.equal(u.searchParams.get('supportsAllDrives'), 'true');
      return { mimeType: 'application/vnd.google-apps.spreadsheet' };
    }
    if (!u.pathname.endsWith('/values:batchGet')) return { sheets: [
      { properties: { sheetId: 0, title: 'Empty' } },
      { properties: { sheetId: 2, title: "Tab's data" } },
    ] };
    batches++;
    assert.deepEqual(u.searchParams.getAll('ranges'), ["'Tab''s data'", "'Empty'"]);
    return { valueRanges: [{ values: [['あ'.repeat(15000)]] }, { values: [['']] }] };
  } });
  assert.equal(batches, 1);
  assert.ok(result.text.startsWith("## Tab's data\n"));
  assert.ok(Buffer.byteLength(result.text) <= 30000);
  assert.ok(!result.text.includes('�'));
});

test('extractGoogleUrls handles open links and gid after other query parameters', () => {
  assert.deepEqual(extractGoogleUrls('https://drive.google.com/open?id=synthetic&gid=22')
    .map(({ id, gid, type }) => ({ id, gid, type })), [{ id: 'synthetic', gid: 22, type: 'drive' }]);
});

test('xlsx deletes every temporary copy when Sheets request throws', async () => {
  const created = [], deleted = [];
  await assert.rejects(readGoogleDoc('synthetic-xlsx', { request: async (url, opts = {}) => {
    const u = new URL(url);
    if (opts.method === 'DELETE') {
      assert.equal(u.searchParams.get('supportsAllDrives'), 'true');
      deleted.push(u.pathname.split('/').at(-1));
      return {};
    }
    if (u.pathname.endsWith('/copy')) {
      const id = `synthetic-copy-${created.length}`;
      created.push(id);
      return { id };
    }
    if (u.pathname.endsWith('/permissions')) return { permissions: [{ emailAddress: 'kim@orgiast.jp', role: 'writer' }] };
    if (u.hostname === 'sheets.googleapis.com') throw new Error('synthetic failure');
    return { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  } }));
  assert.ok(created.length > 0);
  assert.deepEqual(deleted, created);
});

test('Drive images enforce 4MB and target image count limits', async () => {
  const result = await collectReadableContent({
    messages: [{ text: 'https://drive.google.com/file/d/synthetic/view' }],
    maxImages: 1,
    readGoogleUrl: async () => ({ images: [
      { mime: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')}` },
      { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
      { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    ] }),
  });
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.failures.map(f => f.reason), ['4MB超の画像', '画像上限超過']);
});

for (const [mime, target] of [
  ['application/msword', 'document'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
  ['application/vnd.ms-powerpoint', 'presentation'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation'],
  ['application/vnd.ms-excel', 'spreadsheet'],
]) {
  test(`Office conversion and cleanup: ${mime}`, async () => {
    let deleted = false;
    const result = await readGoogleDoc('synthetic-office', { request: async (url, opts = {}) => {
      const u = new URL(url);
      if (opts.method === 'DELETE') { deleted = true; return null; }
      if (u.pathname.endsWith('/copy')) {
        assert.equal(opts.body.mimeType, `application/vnd.google-apps.${target}`);
        return { id: 'synthetic-converted' };
      }
      if (u.pathname.endsWith('/permissions')) return { permissions: [{ emailAddress: 'kim@orgiast.jp', role: 'owner' }] };
      if (u.pathname.endsWith('/export')) return 'synthetic export';
      if (u.pathname.endsWith('/values:batchGet')) return { valueRanges: [{ values: [['synthetic value']] }] };
      if (u.hostname === 'sheets.googleapis.com') return { sheets: [{ properties: { sheetId: 0, title: 'Tab' } }] };
      return { mimeType: mime };
    } });
    assert.ok(result.text.length > 0);
    assert.equal(deleted, true);
  });
}

// ============================================================
// extractPdfViaDriveOcr — Drive OCR fallback
// ============================================================

test('extractPdfViaDriveOcr: multipart upload → export → delete', async () => {
  const pdfBytes = Buffer.from('%PDF-1.4 test');
  let uploadCalled = false, exportCalled = false, deleteCalled = false;
  const ocrReq = async (url, opts = {}) => {
    const u = url;
    if (u.includes('upload/drive') && u.includes('uploadType=multipart')) {
      uploadCalled = true;
      assert.equal(opts.method, 'POST');
      assert.ok(opts.contentType.startsWith('multipart/related; boundary=--ocr_boundary_'));
      assert.ok(opts.rawBody instanceof Buffer);
      assert.equal(new URL(u).searchParams.get('ocrLanguage'), 'ja');
      const boundary = opts.contentType.split('boundary=')[1];
      const metadataPart = opts.rawBody.toString().split('\r\n\r\n')[1].split('\r\n')[0];
      assert.deepEqual(JSON.parse(metadataPart), { name: 'autoreply-ocr-tmp', mimeType: 'application/vnd.google-apps.document', appProperties: { autoreplyOCR: '1' } });
      assert.ok(opts.rawBody.includes(pdfBytes));
      assert.ok(opts.rawBody.toString().endsWith(`\r\n--${boundary}--\r\n`));
      return { id: 'ocr-temp-123' };
    }
    if (u.includes('/export')) {
      exportCalled = true;
      assert.equal(opts.text, true);
      return 'Drive OCR extracted text';
    }
    if (opts.method === 'DELETE') {
      deleteCalled = true;
      return '';
    }
    throw new Error(`Unexpected: ${u} method=${opts.method}`);
  };
  const result = await extractPdfViaDriveOcr(pdfBytes, { request: ocrReq, user: 'kim@orgiast.jp' });
  assert.equal(result, 'Drive OCR extracted text');
  assert.equal(uploadCalled, true, 'upload should be called');
  assert.equal(exportCalled, true, 'export should be called');
  assert.equal(deleteCalled, true, 'delete should be called');
});

test('extractPdfViaDriveOcr: delete called even on export failure', async () => {
  const pdfBytes = Buffer.from('%PDF-1.4 test');
  let deleteCalled = false;
  const ocrReq = async (url, opts = {}) => {
    if (url.includes('upload/drive')) return { id: 'ocr-temp-fail' };
    if (opts.method === 'DELETE') { deleteCalled = true; return ''; }
    throw new Error('export failed');
  };
  await assert.rejects(() => extractPdfViaDriveOcr(pdfBytes, { request: ocrReq, user: 'kim@orgiast.jp' }), /export failed/);
  assert.equal(deleteCalled, true, 'temp file should be deleted even on export failure');
});

test('extractPdfViaDriveOcr: delete not called when upload returns no id', async () => {
  const pdfBytes = Buffer.from('%PDF-1.4 test');
  let deleteCalled = false;
  const ocrReq = async (url, opts = {}) => {
    if (url.includes('upload/drive')) return {};
    if (opts.method === 'DELETE') { deleteCalled = true; return ''; }
    throw new Error('should not reach');
  };
  await assert.rejects(() => extractPdfViaDriveOcr(pdfBytes, { request: ocrReq, user: 'kim@orgiast.jp' }), /PDF抽出 OCR 変換失敗/);
  assert.equal(deleteCalled, false, 'no temp file to delete when upload returned no id');
});

// ============================================================
// readGoogleDoc — Drive PDF fallback to Drive OCR
// ============================================================

test('readGoogleDoc: Drive PDF fallback to Drive OCR when Gemini 402', async () => {
  const pdfBytes = Buffer.from('%PDF-1.4 test');
  let uploadCalled = false, deleteCalled = false;
  const req = async (url, opts = {}) => {
    const u = url;
    // File metadata (fields= in query)
    if (u.includes('fields=')) return { id: 'pdf1', name: 'doc.pdf', mimeType: 'application/pdf' };
    // alt=media → PDF bytes
    if (u.includes('alt=media')) return pdfBytes;
    // Drive OCR upload
    if (u.includes('upload/drive') && u.includes('uploadType=multipart')) {
      uploadCalled = true;
      assert.ok(opts.rawBody instanceof Buffer);
      return { id: 'ocr-temp-pdf1' };
    }
    // Drive OCR export
    if (u.includes('/export') && u.includes('ocr-temp-pdf1')) {
      return 'Drive OCR fallback text';
    }
    // Drive OCR delete
    if (opts.method === 'DELETE') {
      deleteCalled = true;
      return '';
    }
    throw new Error(`Unexpected: ${u} method=${opts.method}`);
  };
  // extractPdfText throws 402 → fallback to Drive OCR
  const fallbackExtractPdf = async () => { throw new Error('PDF抽出 HTTP 402'); };
  const result = await readGoogleDoc('pdf1', { request: req, extractPdf: fallbackExtractPdf });
  assert.ok(result.text);
  assert.match(result.text, /Drive OCR fallback text/);
  assert.equal(result.images, null);
  assert.equal(uploadCalled, true, 'Drive OCR upload should be called as fallback');
  assert.equal(deleteCalled, true, 'temp OCR file should be deleted');
});

test('readGoogleDoc: Drive PDF both fail throws original error', async () => {
  const pdfBytes = Buffer.from('%PDF-1.4 test');
  let ocrAttempted = false;
  const req = async (url, opts = {}) => {
    if (url.includes('fields=')) return { id: 'pdf2', name: 'doc.pdf', mimeType: 'application/pdf' };
    if (url.includes('alt=media')) return pdfBytes;
    if (url.includes('upload/drive')) { ocrAttempted = true; return {}; } // no id → fail
    if (opts.method === 'DELETE') return '';
    throw new Error(`Unexpected: ${url}`);
  };
  const failExtractPdf = async () => { throw new Error('PDF抽出 HTTP 402'); };
  await assert.rejects(() => readGoogleDoc('pdf2', { request: req, extractPdf: failExtractPdf }), /Google ファイル取得失敗/);
  assert.equal(ocrAttempted, true, 'Drive OCR should be attempted');
});

// ============================================================
// collectReadableContent — attachment PDF fallback to Drive OCR
// ============================================================

test('collectReadableContent: attachment PDF falls back to Drive OCR when Gemini fails', async () => {
  const pdfBytes = Buffer.from('fake-pdf-bytes');
  let deleteCalled = false;
  const ocrReq = async (url, opts = {}) => {
    if (url.includes('upload/drive')) return { id: 'ocr-attach-temp' };
    if (url.includes('/export')) return 'OCR extracted from attachment PDF';
    if (opts.method === 'DELETE') { deleteCalled = true; return ''; }
    throw new Error(`Unexpected: ${url} method=${opts.method}`);
  };
  const failingExtract = async () => { throw new Error('PDF抽出 HTTP 402'); };
  const result = await collectReadableContent({
    messages: [{ attachments: [{ fileName: 'doc.pdf', mimeType: 'application/pdf', url: 'https://example.com/doc.pdf' }] }],
    downloadAttachment: async () => pdfBytes,
    extractPdf: failingExtract,
    ocrRequest: ocrReq,
  });
  assert.equal(result.documents.length, 1);
  assert.match(result.documents[0].text, /OCR extracted from attachment PDF/);
  assert.equal(result.failures.length, 0);
  assert.equal(deleteCalled, true, 'temp OCR file should be deleted');
});

test('collectReadableContent: attachment PDF Drive OCR also fails reports failure', async () => {
  const pdfBytes = Buffer.from('fake-pdf-bytes');
  const ocrReq = async (_url, _opts = {}) => { throw new Error('Drive OCR failure'); };
  const failingExtract = async () => { throw new Error('PDF抽出 HTTP 402'); };
  const result = await collectReadableContent({
    messages: [{ attachments: [{ fileName: 'bad.pdf', mimeType: 'application/pdf', url: 'https://example.com/bad.pdf' }] }],
    downloadAttachment: async () => pdfBytes,
    extractPdf: failingExtract,
    ocrRequest: ocrReq,
  });
  assert.equal(result.documents.length, 0);
  assert.equal(result.failures.length, 1);
});

test('collectReadableContent: text attachment unchanged by OCR fallback', async () => {
  const result = await collectReadableContent({
    messages: [{ attachments: [{ fileName: 'note.txt', mimeType: 'text/plain', url: 'https://example.com/note.txt' }] }],
    downloadAttachment: async () => Buffer.from('plain text content'),
  });
  assert.equal(result.documents.length, 1);
  assert.match(result.documents[0].text, /plain text content/);
  assert.equal(result.failures.length, 0);
});


test('googleClient: legacy JSON, text, buffer and DELETE requests retain behavior; multipart stays binary', async () => {
  const calls = [];
  const request = googleClient({
    getToken: async () => 'mock-token',
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return new Response(options.method === 'DELETE' ? null : '"response"', { status: options.method === 'DELETE' ? 204 : 200 });
    },
  });
  assert.equal(await request('https://example.invalid', { method: 'POST', body: { name: 'test' } }), 'response');
  assert.equal(calls[0].body, JSON.stringify({ name: 'test' }));
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].headers.Authorization, 'Bearer mock-token');
  assert.equal(await request('https://example.invalid', { text: true }), '"response"');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].body, undefined);
  assert.deepEqual(await request('https://example.invalid', { buffer: true }), Buffer.from('"response"'));
  assert.equal(await request('https://example.invalid', { method: 'DELETE' }), null);
  const rawBody = Buffer.from([0, 255, 128, 13, 10]);
  await request('https://example.invalid', { method: 'POST', rawBody, contentType: 'multipart/related; boundary=test' });
  assert.equal(calls[4].body, rawBody);
  assert.equal(calls[4].headers['Content-Type'], 'multipart/related; boundary=test');
});

for (const emptyGemini of [false, true]) {
  test(`attachment PDF: OCR retries team identity after kim export failure (empty Gemini=${emptyGemini})`, async () => {
    const deleted = [];
    const uploaded = [];
    const result = await collectReadableContent({
      messages: [{ attachments: [{ fileName: 'retry.pdf', mimeType: 'application/pdf', url: 'https://example.invalid/pdf' }] }],
      downloadAttachment: async () => Buffer.from('%PDF-test'),
      extractPdf: async () => { if (emptyGemini) return '  '; throw new Error('PDF抽出 HTTP 402'); },
      ocrRequest: async (url, opts) => {
        if (url.includes('upload/drive')) { uploaded.push(opts.user); return { id: opts.user }; }
        if (opts.method === 'DELETE') { deleted.push(opts.user); return null; }
        if (opts.user === 'kim@orgiast.jp') throw new Error('export failed');
        return 'team OCR text';
      },
    });
    assert.deepEqual(uploaded, ['kim@orgiast.jp', 'seisaku-team@orgiast.jp']);
    assert.deepEqual(deleted, uploaded);
    assert.equal(result.failures.length, 0);
    assert.equal(result.documents.length, 1);
    assert.match(result.documents[0].text, /team OCR text/);
  });
}
