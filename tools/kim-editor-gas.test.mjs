import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const file of ['mail-bulk-approve-gas/Setup.js', 'feedback-kit/gas/templates/FeedbackRelay.js']) {
  test(`${file}: silent writer grant and read-back, failure propagates`, () => {
    for (const persists of [true, false]) {
      let granted = false;
      const calls = [];
      const ctx = vm.createContext({ ScriptApp: { getOAuthToken: () => 'fixture' }, UrlFetchApp: { fetch: (url, options) => {
        calls.push({ url, ...options });
        if (options.method === 'post') granted = persists;
        const permissions = granted ? [{ type: 'user', role: 'writer', emailAddress: 'kim@orgiast.jp' }] : [];
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ permissions }) };
      } } });
      vm.runInContext(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), ctx);
      const artifact = { getId: () => 'file' };
      if (persists) assert.equal(ctx.ensureKimEditor_(artifact), artifact);
      else assert.throws(() => ctx.ensureKimEditor_(artifact), /read-back/);
      const grant = calls.find(c => c.method === 'post');
      assert.match(grant.url, /sendNotificationEmail=false/);
      assert.equal(JSON.parse(grant.payload).role, 'writer');
      assert.ok(calls.at(-1).url.includes('/permissions'));
    }
  });
}
test('GAS kim DM becomes a durable Drive inbox entry without touching Discord', () => {
  const contents = [], calls = [];
  const file = { getId: () => 'queued' };
  const ctx = vm.createContext({ MimeType: { PLAIN_TEXT: 'text/plain' }, Utilities: { getUuid: () => 'unique' },
    DriveApp: { getRootFolder: () => ({ createFile: (name, text) => { contents.push({ name, text }); return file; } }) },
    ScriptApp: { getOAuthToken: () => 'fixture' },
    UrlFetchApp: { fetch: (url, options) => { calls.push({ url, ...options }); return { getResponseCode: () => 200 }; } },
  });
  vm.runInContext(fs.readFileSync(new URL('feedback-kit/gas/templates/FeedbackRelay.js', import.meta.url), 'utf8'), ctx);
  ctx.ensureKimEditor_ = value => { assert.equal(value, file); return value; };
  assert.equal(ctx._FeedbackRelay_postDm('unused', '715210673642012733', '報告本文', []), true);
  assert.equal(JSON.parse(contents[0].text).text, '報告本文');
  assert.ok(calls.every(c => c.url.startsWith('https://www.googleapis.com/drive/')));
  assert.equal(JSON.parse(calls[0].payload).properties.orgiastKimInbox, 'pending');
});
