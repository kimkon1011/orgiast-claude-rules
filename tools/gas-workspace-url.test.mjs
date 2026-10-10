import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function load(file) {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), context);
  return context;
}
test('GAS 通知リンクは受け手必須、gid より前に authuser を指定', () => {
  const gas = load('../packages/feedback-gas/templates/FeedbackRelay.js');
  const ss = { getId: () => 'S' }, sheet = { getSheetId: () => 42 };
  assert.equal(gas._FeedbackRelay_sheetUrl({ authuser: 'recipient@example.com' }, ss, sheet),
    'https://docs.google.com/spreadsheets/d/S/edit?authuser=recipient%40example.com#gid=42');
  assert.throws(() => gas._FeedbackRelay_sheetUrl({ workspaceDomain: 'orgiast.jp' }, ss, sheet), /FEEDBACK_OPEN_EMAIL/);
});
test('共有台帳のリンクと案内は指定した受け手で一致', () => {
  const gas = load('../gas/fleet-status-sheet/LedgerUnifyLogic.gs');
  const rows = gas.buildIndexRows([], 'L', 'I', 'OLD', 'reader@example.com');
  for (const row of rows.filter(row => String(row[1]).startsWith('https://docs.google.com/'))) {
    assert.equal(new URL(row[1]).searchParams.get('authuser'), 'reader@example.com');
    assert.ok(row.includes('reader@example.com で開いてください'));
  }
  assert.throws(() => gas.buildIndexRows([], 'L', 'I', 'OLD'), /authuser/);
});
