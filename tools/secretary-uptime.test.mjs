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
  const f = fixture();
  f.io.backend = async () => { assert.fail('外部URLが正常なときに CLI を呼び出した'); };
  const result = await repairPass(f.io);
  assert.deepEqual(result.state.errors, []);
  assert.deepEqual(result.state.activeCauses, []);
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
  assert.equal(result.state.events.length, 3); assert.equal(f.messages.length, 1); assert.equal(result.ok, false);
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

test('外部URLが復旧すれば Tailscale CLI エラーがあっても正常終了する', async () => {
  const f = fixture(['external']);
  f.io.backend = async () => { throw new Error('LocalAPI access denied'); };
  const result = await repairPass(f.io);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(result.state.activeCauses, []);
  assert.match(result.state.errors[0], /CLI を利用できない.*LocalAPI access denied/);
  assert.equal(result.ok, true);
});

test('外部URLが未復旧で CLI が使えなければ外部障害として通知する', async () => {
  const f = fixture(['external', 'gateway'], false);
  f.io.backend = async () => { throw new Error('LocalAPI access denied'); };
  const result = await repairPass(f.io);
  assert.deepEqual(f.actions, ['gateway']);
  assert.deepEqual(result.state.activeCauses, ['gateway', 'external']);
  assert.match(f.messages[0], /CLI を利用できない/);
  assert.equal(result.ok, false);
});

test('旧バージョンが記録した Tailscale 単独の障害は再発判定から除く', async () => {
  const now = Date.now();
  const f = fixture();
  const previous = { events: [1, 2, 3].map(age => ({ at: now - age, cause: 'tailscale' })), activeCauses: ['tailscale'] };
  const result = await repairPass(f.io, previous, now);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(result.state.events, []);
  assert.equal(result.ok, true);
});

test('台帳ロックが解放されれば再試行で通知できる', async () => {
  const f = fixture(['external'], false);
  const waits = [];
  let attempts = 0;
  f.io.wait = async ms => { waits.push(ms); };
  f.io.notify = async body => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('Command failed'), { stderr: 'kim-inbox: 台帳が使用中です\n' });
    f.messages.push(body);
  };
  const result = await repairPass(f.io);
  assert.deepEqual(waits, [2000, 2000, 2000, 3000, 3000]);
  assert.equal(attempts, 3);
  assert.equal(f.messages.length, 1);
  assert.ok(result.state.notified);
  assert.deepEqual(result.state.errors, []);
});

test('台帳ロックが続く場合は3回の再試行後に既存の再送キューへ渡す', async () => {
  const f = fixture(['external'], false);
  const attempts = [], queued = [], waits = [];
  f.io.wait = async ms => { waits.push(ms); };
  f.io.notify = async body => {
    attempts.push(body);
    throw new Error('kim-inbox: 台帳が使用中です');
  };
  f.io.deferNotification = body => queued.push(body);
  const result = await repairPass(f.io);
  assert.deepEqual(waits, [2000, 2000, 2000, 3000, 3000, 3000]);
  assert.equal(attempts.length, 4);
  assert.deepEqual(queued, [attempts[0]]);
  assert.match(result.state.errors[0], /再送キューに保存/);
  const next = fixture(['external'], false);
  await repairPass(next.io, result.state);
  assert.deepEqual(next.messages, []);
});
