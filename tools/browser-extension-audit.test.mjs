import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { scanBrowserExtensions } from './browser-extension-audit.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-audit-'));
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 13': { user_name: 'seisaku-team@orgiast.jp' } } } }));
  return root;
}
function add(root, profile, id, setting, localeName) {
  const dir = path.join(root, profile); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Secure Preferences');
  let data = { extensions: { settings: {} } }; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  data.extensions.settings[id] = setting; fs.writeFileSync(file, JSON.stringify(data));
  if (localeName) { const locale = path.join(dir, 'Extensions', id, setting.manifest.version, '_locales', 'ja'); fs.mkdirSync(locale, { recursive: true }); fs.writeFileSync(path.join(locale, 'messages.json'), JSON.stringify({ appName: { message: localeName } })); }
}

test('名前・アカウント・risk・builtinを解決し決定順にする', () => {
  const root = fixture();
  add(root, 'Profile 13', 'sider', { manifest: { name: '__MSG_appName__', version: '1' }, state: 1, active_permissions: { api: ['cookies', 'userScripts'], explicit_host: ['<all_urls>'] } }, 'Sider');
  add(root, 'Default', 'wide', { manifest: { name: 'Wide', version: '2' }, state: 1, active_permissions: { explicit_host: ['*://*/*'] }, was_installed_by_default: true });
  add(root, 'Default', 'narrow', { manifest: { name: 'Narrow', version: '3' }, disable_reasons: [], active_permissions: { explicit_host: ['https://example.com/*'] } });
  const a = scanBrowserExtensions({ roots: [{ browser: 'Chrome', root }] });
  const b = scanBrowserExtensions({ roots: [{ browser: 'Chrome', root }] });
  assert.deepEqual(a, b); assert.deepEqual(a.rows.map((r) => r.risk), ['high', 'medium', 'low']);
  assert.equal(a.rows[0].name, 'Sider'); assert.equal(a.rows[0].account, 'seisaku-team@orgiast.jp'); assert.equal(a.rows[1].builtin, true);
});

test('壊れたJSONと設定なしプロファイルを数えて継続する', () => {
  const root = fixture(); fs.mkdirSync(path.join(root, 'Default')); fs.writeFileSync(path.join(root, 'Default', 'Secure Preferences'), '{broken'); fs.mkdirSync(path.join(root, 'Profile 2'));
  const result = scanBrowserExtensions({ roots: [{ browser: 'Chrome', root }] });
  assert.equal(result.rows.length, 0); assert.equal(result.unreadableProfiles, 2);
});

test('extPlanReplaceは同一PCだけ置換し空labelを拒否する', () => {
  const source = fs.readFileSync(new URL('../gas/fleet-status-sheet/ExtensionAudit.gs', import.meta.url), 'utf8');
  const helpers = fs.readFileSync(new URL('../gas/fleet-status-sheet/UpsertLogic.gs', import.meta.url), 'utf8');
  const context = {}; vm.createContext(context); vm.runInContext((helpers + '\n' + source).replace(/\bconst\s+/g, 'var '), context);
  const h = Object.values(context.EXT_HEADERS_); const c = context.fleetFindHeaderIndex(h, context.EXT_HEADERS_.label);
  const other = h.map(() => ''); other[c] = 'other'; const mine = h.map(() => ''); mine[c] = 'mine';
  const payload = { label: 'mine', reportedAt: 'now', rows: [{ browser: 'Chrome', profile: 'Default', account: '', name: 'X', id: 'id', version: '1', enabled: true, risk: 'high', builtin: false, broadHost: true, keyPerms: ['cookies'] }] };
  const first = context.extPlanReplace(h, [other, mine], payload); assert.deepEqual([...first.deleteRowNumbers], [3]); assert.equal(first.appendRows.length, 1);
  const after = [other, ...first.appendRows]; const second = context.extPlanReplace(h, after, payload); assert.deepEqual([...second.deleteRowNumbers], [3]); assert.equal(after[0][c], 'other');
  assert.throws(() => context.extPlanReplace(h, [], { ...payload, label: '' }), /label_required/);
  assert.throws(() => context.extPlanReplace(h.slice(0, -1), [], payload), /required header not found/);
});
