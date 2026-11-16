import test from 'node:test';
import assert from 'node:assert/strict';
import { repairPass, targets } from './secretary-uptime.mjs';
function fixture(failed = [], recover = true) {
  const actions = [], messages = [];
  let repaired = false;
  const io = {
    probe: async url => ({ ok: (repaired && recover) || !failed.includes(Object.keys(targets).find(k => targets[k] === url)), status: (repaired && recover) ? 200 : failed.includes(Object.keys(targets).find(k => targets[k] === url)) ? 502 : 200 }),
    backend: async () => failed.includes('tailscale') ? 'Stopped' : 'Running',
    up: async () => { actions.push('up'); },
    funnel: async () => { actions.push('funnel'); },
    restart: async name => { actions.push(name); },
    wait: async () => { repaired = true; },
    notify: async message => { messages.push(message); },
  };
  return { io, actions, messages };
}
test('healthy run does not restart or notify', async () => {
  const f = fixture(); const result = await repairPass(f.io);
  assert.equal(result.ok, true); assert.deepEqual(f.actions, []); assert.deepEqual(f.messages, []);
});
test('stopped Tailscale and hung/missing HTTP servers repair in bounded order', async () => {
  const f = fixture(['tailscale','gateway','secretary','external']);
  const result = await repairPass(f.io);
  assert.deepEqual(f.actions, ['up','funnel','secretary','gateway']); assert.equal(result.ok, true);
  assert.deepEqual(result.state.activeCauses, []);
});
test('local 200 is insufficient; external failure queues ask and exits nonzero', async () => {
  const f = fixture(['external'], false); const result = await repairPass(f.io);
  assert.equal(result.ok, false); assert.equal(f.messages.length, 1); assert.match(f.messages[0], /external/);
  assert.deepEqual(f.actions, ['funnel']);
});
test('three separate incidents within 24h notify even after recovery', async () => {
  const now = Date.now(); const f = fixture(['gateway']);
  const result = await repairPass(f.io, { events: [{ at: now - 9000, cause: 'gateway' }, { at: now - 3000, cause: 'gateway' }, { at: now - 90000000, cause: 'gateway' }] }, now);
  assert.equal(result.state.events.length, 3); assert.equal(f.messages.length, 1); assert.equal(result.ok, true);
});
test('persistent outage counts once; failed inbox delivery retries on next run', async () => {
  const now = Date.now(); const f = fixture(['external'], false);
  f.io.notify = async () => { throw new Error('inbox unavailable'); };
  const first = await repairPass(f.io, {}, now);
  assert.equal(first.state.notified, null);
  const next = fixture(['external'], false);
  const second = await repairPass(next.io, first.state, now + 300000);
  assert.equal(second.state.events.length, 1); assert.equal(next.messages.length, 1);
});
test('restart failure does not prevent repair of the other server', async () => {
  const f = fixture(['secretary','gateway'], false);
  f.io.restart = async name => { f.actions.push(name); if (name === 'secretary') throw new Error('wrong process'); };
  const result = await repairPass(f.io);
  assert.deepEqual(f.actions, ['secretary','gateway']); assert.equal(result.ok, false); assert.equal(f.messages.length, 1);
});
