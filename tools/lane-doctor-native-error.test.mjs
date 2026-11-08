import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deadLanes } from './lib/lane-health.mjs';
const src = fs.readFileSync(new URL('./lane-doctor.mjs', import.meta.url), 'utf8');
test('native 失敗はエラー末尾を残し、認証・上限なら physical_operation にしない（2026-10-15 作業用011）', () => {
  assert.match(src, /health\.lanes\[p\]\.error = /);
  assert.match(src, /result\.nativeRepair && health\.lanes\[p\]\.reason === 'probe_failed'/);
});
test('native probe は --kind implement で codex を確実に起動し、クールダウン保留を WSL 不在と誤診断しない', () => {
  assert.match(src, /'--kind', 'implement', '--force-native'/);
  assert.match(src, /const deferred = \/codex_cooldown\/\.test\(text\)/);
  assert.match(src, /\(limited \|\| deferred\) \? 'cooldown'/);
});
test('kim-PC へ送る dead レーンにエラー末尾を含める', () => {
  const d = deadLanes({ lanes: { codex: { alive: false, reason: 'dead:oauth_consent', error: 'HTTP 401 unauthorized' } } });
  assert.deepEqual(d, [{ lane: 'codex', reason: 'dead:oauth_consent', error: 'HTTP 401 unauthorized' }]);
});
