import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { progressHome } from './test-helpers/auto-progress-home.mjs';
import { isKimSeat } from './kim-inbox.mjs';
import { usesKimDoneInbox } from './lib/auto-progress-done-inbox.mjs';
import { resolveOwner } from './lib/fleet-owner.mjs';

test('完了通知のfixtureはkimのhostname・global Git emailを隔離し、明示したkim席は保持する', t => {
  const home = progressHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previous = process.env.GIT_CONFIG_GLOBAL;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  });
  const config = path.join(home, 'gitconfig');
  fs.writeFileSync(config, '[user]\n\temail = kim@orgiast.jp\n');
  process.env.GIT_CONFIG_GLOBAL = config;
  for (const hostname of ['kim-PC', 'DESKTOP-2D0R4LI', 'linux-ci']) {
    const mocked = t.mock.method(os, 'hostname', () => hostname);
    assert.equal(resolveOwner({ home }), 'test-owner@example.com');
    assert.equal(isKimSeat(home), false, hostname);
    assert.equal(usesKimDoneInbox({ owner: 'staff@example.test' }, home), false);
    assert.equal(usesKimDoneInbox({ owner: 'kim@orgiast.jp' }, home), true);
    mocked.mock.restore();
  }
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'seisaku-team@orgiast.jp' } }));
  assert.equal(isKimSeat(home), true);
  assert.equal(usesKimDoneInbox({}, home), true);
});
