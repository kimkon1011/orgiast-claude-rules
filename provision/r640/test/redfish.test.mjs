import test from 'node:test';
import assert from 'node:assert/strict';
import { Redfish, SYSTEM, MANAGER, controllerModel, bootstrap } from '../lib/redfish.mjs';

const site = { diskSerials: ['ssd-a', 'ssd-b'], minimumDiskGiB: 240 };
const images = Object.fromEntries(['mdadm', 'hardware'].map(storageMode => [storageMode, { ...site, storageMode, sha256: 'a'.repeat(64), url: `https://iso.example.invalid/${storageMode}.iso` }]));
function fixture({ model = 'H330', mode = 'RAID', controllerMissing = false, existing = false, badSerial = false, jobFails = false, badMedia = false } = {}) {
  const calls = [], controller = `${SYSTEM}/Storage/RAID.Integrated.1-1`, storage = `${SYSTEM}/Storage`;
  const ctrl = `${controller}/Controllers/RAID.Integrated.1-1`, volumes = `${controller}/Volumes`, media = `${MANAGER}/VirtualMedia/CD`;
  let target = mode, jobKind, rebooted = false, created = existing, inserted = false;
  const get = route => {
    if (route === storage) return { Members: [{ '@odata.id': controller }] };
    if (route === controller) return { Id: 'RAID.Integrated.1-1', StorageControllers: [{ Model: `PERC ${model} Mini` }], Drives: [0, 1].map(i => ({ '@odata.id': `${controller}/Drives/${i}` })), Volumes: { '@odata.id': volumes } };
    if (route === ctrl) return controllerMissing ? null : { Oem: { Dell: { DellStorageController: { ControllerMode: mode } } } };
    if (route.includes('/Drives/')) return { SerialNumber: badSerial ? 'unknown' : site.diskSerials[+route.at(-1)], MediaType: 'SSD', Protocol: 'SATA', CapacityBytes: 256 * 1024**3, Status: { Health: 'OK' } };
    if (route === volumes) return { Members: created ? [{ '@odata.id': volumes + '/VD1' }] : [] };
    if (route === volumes + '/VD1') return { RAIDType: 'RAID1', Status: { Health: 'OK' } };
    if (route.includes('/Jobs/')) return { JobState: jobFails ? 'Failed' : rebooted ? 'Completed' : 'Scheduled' };
    if (route === SYSTEM) return { PowerState: 'On' };
    if (route === `${MANAGER}/VirtualMedia`) return { Members: [{ '@odata.id': media }] };
    if (route === media) return { MediaTypes: ['CD'], Inserted: badMedia ? false : inserted, Image: inserted ? images[target === 'HBA' ? 'mdadm' : 'hardware'].url : null, Actions: { '#VirtualMedia.InsertMedia': { target: media + '/Actions/VirtualMedia.InsertMedia' } } };
    throw new Error(`unmocked GET ${route}`);
  };
  const fetcher = async (url, opts) => {
    const route = url.pathname, body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method: opts.method, route, body });
    assert.match(opts.headers.Authorization, /^Basic /);
    assert.equal(opts.redirect, 'error');
    if (opts.method === 'GET') { const data = get(route); return new Response(JSON.stringify(data ?? {}), { status: data === null ? 404 : 200 }); }
    if (route === ctrl + '/Settings') { target = body.Oem.Dell.DellStorageController.ControllerMode; jobKind = 'mode'; rebooted = false; return new Response('{}', { status: 202, headers: { Location: '/redfish/v1/TaskService/Tasks/JID_TEST' } }); }
    if (route === volumes) { jobKind = 'volume'; rebooted = false; return new Response('{}', { status: 202, headers: { Location: '/redfish/v1/TaskService/Tasks/JID_TEST' } }); }
    if (route === `${SYSTEM}/Actions/ComputerSystem.Reset`) { rebooted = true; mode = target; if (jobKind === 'volume') created = true; return new Response(null, { status: 204 }); }
    if (route.endsWith('/Actions/VirtualMedia.InsertMedia')) { inserted = true; return new Response(null, { status: 204 }); }
    if (route === SYSTEM && opts.method === 'PATCH') return new Response(null, { status: 204 });
    throw new Error('unmocked mutation');
  };
  return { calls, api: new Redfish({ idracUrl: 'https://idrac.example.invalid', idracUsername: 'test', idracPassword: 'test-only' }, fetcher) };
}
const options = { confirmWipe: true, site, images, sleep: async () => {} };
test('confirmation checked before any request; unknown PERC fails closed', async () => {
  const f = fixture();
  await assert.rejects(bootstrap(f.api, { site, images }), /confirm-wipe/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => controllerModel('H740P'), /unsupported/);
  assert.throws(() => controllerModel('HBA330'), /unsupported/);
});
for (const model of ['H330', 'H730P']) test(`${model}: inventory -> scheduled HBA -> reboot/readback -> insert -> one-time boot`, async () => {
  const f = fixture({ model });
  const result = await bootstrap(f.api, options);
  assert.equal(result.controller, model); assert.equal(result.storage, 'mdadm');
  const writes = f.calls.filter(c => c.method !== 'GET');
  assert.deepEqual(writes.map(c => c.method), ['PATCH', 'POST', 'POST', 'PATCH', 'POST']);
  assert.equal(writes[0].body.Oem.Dell.DellStorageController.ControllerMode, 'HBA');
  assert.ok(writes[2].route.endsWith('InsertMedia'));
  assert.equal(writes[3].body.Boot.BootSourceOverrideEnabled, 'Once');
  assert.ok(f.calls.some(c => c.route.includes('/Oem/Dell/Jobs/')));
});
test('unavailable remote HBA uses hardware RAID1, then verifies volume', async () => {
  const f = fixture({ model: 'H730P', controllerMissing: true });
  const result = await bootstrap(f.api, options);
  assert.equal(result.storage, 'hardware');
  const creation = f.calls.find(c => c.method === 'POST' && c.route.endsWith('/Volumes'));
  assert.equal(creation.body.RAIDType, 'RAID1'); assert.equal(creation.body.Links.Drives.length, 2);
  assert.ok(f.calls.find(c => c.method === 'GET' && c.route.endsWith('/Volumes/VD1')));
});
test('explicit hardware variant switches from HBA back to RAID', async () => {
  const f = fixture({ mode: 'HBA' });
  assert.equal((await bootstrap(f.api, { ...options, storage: 'hardware' })).storage, 'hardware');
  assert.equal(f.calls.find(c => c.route.endsWith('/Settings')).body.Oem.Dell.DellStorageController.ControllerMode, 'RAID');
});
test('existing arrays, serial mismatch and wrong ISO abort before writes', async () => {
  for (const spec of [{ existing: true }, { badSerial: true }, {}]) {
    const f = fixture(spec);
    await assert.rejects(bootstrap(f.api, { ...options, images: Object.keys(spec).length ? images : {} }));
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  }
});
test('failed scheduled job never mounts ISO or reboots', async () => {
  const f = fixture({ jobFails: true });
  await assert.rejects(bootstrap(f.api, options), /job failed/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
test('bad media readback never sets boot override', async () => {
  const f = fixture({ mode: 'HBA', badMedia: true });
  await assert.rejects(bootstrap(f.api, options), /media readback/);
  assert.equal(f.calls.filter(c => c.method === 'PATCH' && c.route === SYSTEM).length, 0);
});
test('credentials never follow foreign Redfish links', async () => {
  const f = fixture();
  await assert.rejects(f.api.get('https://other.invalid/redfish/v1/steal'), /invalid Redfish link/);
  assert.equal(f.calls.length, 0);
});
