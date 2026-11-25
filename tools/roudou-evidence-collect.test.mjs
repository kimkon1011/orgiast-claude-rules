import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectEvidence } from './roudou-evidence-collect.mjs';

const response = value => ({ ok: true, json: async () => value, text: async () => '' });

test('重複と自分の送信を除外し、domain権限を削除して保存する', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roudou-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ processedMessageIDs: ['done'] }));
  const messages = {
    '307': [
      { id: 'new', timestamp: '2026-11-25T04:13:00Z', isSender: false, type: 'IMAGE', attachments: [{ mimeType: 'image/jpeg', srcURL: 'mxc://photo' }] },
      { id: 'done', timestamp: '2026-11-25T04:12:00Z', isSender: false, attachments: [{ mimeType: 'image/png', srcURL: 'mxc://duplicate' }] },
      { id: 'mine', timestamp: '2026-11-25T04:11:00Z', isSender: true, attachments: [{ mimeType: 'application/pdf', srcURL: 'mxc://mine' }] },
    ],
  };
  const deleted = [];
  let permissionReads = 0;
  const drive = async (_token, url, options = {}) => {
    if (url.includes('/upload/')) return response({ id: 'drive-new', name: 'x' });
    if (options.method === 'DELETE') { deleted.push(url); return response({}); }
    if (url.includes('/permissions?')) {
      permissionReads++;
      return response({ permissions: permissionReads === 1 ? [
        { id: 'domain-1', type: 'domain', domain: 'orgiast.jp', role: 'reader' },
        { id: 'kim', type: 'user', emailAddress: 'kim@orgiast.jp', role: 'owner' },
        { id: 'nishi', type: 'user', emailAddress: 'nishi@orgiast.jp', role: 'writer' },
      ] : [
        { id: 'kim', type: 'user', emailAddress: 'kim@orgiast.jp', role: 'owner' },
        { id: 'nishi', type: 'user', emailAddress: 'nishi@orgiast.jp', role: 'writer' },
      ] });
    }
    throw new Error(`unexpected drive call: ${url}`);
  };
  const result = await collectEvidence({
    statePath, outputDir: path.join(root, 'out'), logDir: path.join(root, 'logs'), notify: false,
    list: async chatID => ({ items: messages[chatID] || [], hasMore: false }),
    download: async () => Buffer.from('photo'), tokenProvider: async () => 'token', drive, stdout: () => {},
  });
  assert.equal(result.uploaded.length, 1);
  assert.match(result.uploaded[0].name, /^furukawa-307-new-202611251313\.jpg$/);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /permissions\/domain-1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath)).processedMessageIDs, ['done', 'new']);
  assert.equal(fs.readdirSync(path.join(root, 'out')).length, 1);
});

test('dry-runは候補表示だけで状態・Driveを変更しない', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roudou-evidence-dry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let driveCalls = 0;
  const result = await collectEvidence({
    dryRun: true, statePath: path.join(root, 'missing.json'), outputDir: path.join(root, 'out'), logDir: path.join(root, 'logs'),
    list: async chatID => ({ items: chatID === '548' ? [{ id: 'pdf', timestamp: '2026-11-25T00:00:00Z', isSender: false, attachments: [{ mimeType: 'application/pdf', srcURL: 'mxc://pdf' }] }] : [], hasMore: false }),
    drive: async () => { driveCalls++; }, stdout: () => {},
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(driveCalls, 0);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
});
