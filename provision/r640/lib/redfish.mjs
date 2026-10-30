import { setTimeout as delay } from 'node:timers/promises';

export const SYSTEM = '/redfish/v1/Systems/System.Embedded.1';
export const MANAGER = '/redfish/v1/Managers/iDRAC.Embedded.1';
export class Redfish {
  constructor({ idracUrl, idracUsername, idracPassword }, fetcher = fetch) {
    this.base = new URL(idracUrl);
    if (this.base.protocol !== 'https:' || this.base.username || this.base.password) throw new Error('iDRAC requires HTTPS with trusted CA');
    this.authorization = 'Basic ' + Buffer.from(`${idracUsername}:${idracPassword}`).toString('base64');
    this.fetcher = fetcher;
  }
  async request(method, route, body) {
    const url = new URL(route, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith('/redfish/v1/')) throw new Error('invalid Redfish link');
    const response = await this.fetcher(url, { method, redirect: 'error', headers: { Authorization: this.authorization, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Object.assign(new Error(`Redfish HTTP ${response.status}`), { status: response.status });
    let data = {};
    if (response.status !== 204) { const text = await response.text(); if (text) data = JSON.parse(text); }
    return { data, location: response.headers.get('Location') };
  }
  async get(route) { return (await this.request('GET', route)).data; }
  async reboot() {
    const system = await this.get(SYSTEM);
    await this.request('POST', `${SYSTEM}/Actions/ComputerSystem.Reset`, { ResetType: system.PowerState === 'Off' ? 'On' : 'ForceRestart' });
  }
  async wait(location, sleep = delay, scheduled = false) {
    if (!location) throw new Error('Redfish operation has no task/job Location');
    // Dell returns TaskService Location; staged PERC jobs expose scheduling at Jobs.
    const jobId = location.split('/').at(-1);
    if (jobId.startsWith('JID_')) location = `${MANAGER}/Oem/Dell/Jobs/${jobId}`;
    for (let attempt = 0; attempt < 180; attempt++) {
      const data = await this.get(location);
      const state = data.JobState || data.TaskState;
      if (['Failed', 'Exception', 'Killed', 'Cancelled', 'CompletedWithErrors', 'Interrupted'].includes(state) || data.TaskStatus === 'Critical') throw new Error('Redfish job failed');
      if (state === 'Completed' || (scheduled && state === 'Scheduled')) return;
      await sleep(5000);
    }
    throw new Error('Redfish job timeout');
  }
}
export function controllerModel(description) {
  if (/H730P/i.test(description)) return 'H730P';
  if (/H330/i.test(description) && !/HBA330/i.test(description)) return 'H330';
  throw new Error('unsupported or ambiguous PERC model');
}
export async function inventory(api, requested = 'auto') {
  if (!['auto', 'H330', 'H730P'].includes(requested)) throw new Error('invalid --perc');
  const list = await api.get(`${SYSTEM}/Storage`);
  const candidates = [];
  for (const member of list.Members ?? []) {
    const storage = await api.get(member['@odata.id']);
    const description = JSON.stringify(storage.StorageControllers || storage.Name);
    if (/\bH(?:330|730P)\b/i.test(description)) candidates.push({ storage, route: member['@odata.id'], model: controllerModel(description) });
  }
  if (candidates.length !== 1) throw new Error('expected exactly one supported PERC');
  const result = candidates[0];
  if (requested !== 'auto' && requested !== result.model) throw new Error('PERC differs from requested model');
  const id = result.storage.Id;
  result.controllerRoute = `${result.route}/Controllers/${id}`;
  try {
    result.controller = await api.get(result.controllerRoute);
  } catch (e) { if (![404, 405].includes(e.status)) throw e; result.controller = null; }
  result.mode = result.controller?.Oem?.Dell?.DellStorageController?.ControllerMode;
  const settings = result.controller?.['@Redfish.Settings']?.SettingsObject?.['@odata.id'];
  result.settingsRoute = settings || (result.controller ? `${result.controllerRoute}/Settings` : null);
  result.drives = [];
  for (const d of result.storage.Drives ?? []) result.drives.push({ ...(await api.get(d['@odata.id'])), route: d['@odata.id'] });
  result.volumesRoute = result.storage.Volumes?.['@odata.id'];
  if (!result.volumesRoute) throw new Error('volume collection missing');
  result.volumes = (await api.get(result.volumesRoute)).Members ?? [];
  return result;
}
export function storagePlan(info, site, requestedMode = 'auto') {
  if (!['auto', 'mdadm', 'hardware'].includes(requestedMode)) throw new Error('invalid storage mode');
  const drives = site.diskSerials.map(serial => info.drives.find(d => d.SerialNumber?.trim() === serial));
  if (drives.some(d => !d || d.MediaType !== 'SSD' || d.Protocol !== 'SATA' || d.CapacityBytes < site.minimumDiskGiB * 1024 ** 3 || d.Status?.Health !== 'OK')) throw new Error('SSD inventory differs from approved serials/capacity/health');
  // Never adopt/delete a pre-existing array automatically, even with wipe confirmation.
  if (info.volumes.length) throw new Error('existing virtual disks require a separate reviewed migration');
  const hbaSupported = info.mode === 'HBA' || (info.settingsRoute && ['RAID', 'HBA'].includes(info.mode));
  const mode = requestedMode === 'auto' ? (hbaSupported ? 'mdadm' : 'hardware') : requestedMode;
  if (mode === 'mdadm' && !hbaSupported) throw new Error('HBA remote mode unavailable');
  if (mode === 'hardware' && info.mode === 'HBA' && !info.settingsRoute) throw new Error('cannot switch HBA to RAID remotely');
  return { mode, drives, targetMode: mode === 'mdadm' ? 'HBA' : 'RAID' };
}
export async function bootstrap(api, { confirmWipe = false, perc = 'auto', storage = 'auto', site, images, sleep = delay } = {}) {
  if (!confirmWipe) throw new Error('--confirm-wipe required before iDRAC access');
  const info = await inventory(api, perc);
  const plan = storagePlan(info, site, storage);
  const image = images[plan.mode];
  if (!image || image.storageMode !== plan.mode || JSON.stringify(image.diskSerials) !== JSON.stringify(site.diskSerials) || image.minimumDiskGiB !== site.minimumDiskGiB || !/^[a-f0-9]{64}$/.test(image.sha256 ?? '')) throw new Error('matching prepared ISO manifest required');
  const imageUrl = new URL(image.url);
  if (imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password || imageUrl.search) throw new Error('ISO requires credential-free HTTPS URL on restricted provisioning LAN');
  if (info.mode && info.mode !== plan.targetMode) {
    const change = await api.request('PATCH', info.settingsRoute, { '@Redfish.SettingsApplyTime': { ApplyTime: 'OnReset' }, Oem: { Dell: { DellStorageController: { ControllerMode: plan.targetMode } } } });
    await api.wait(change.location, sleep, true);
    await api.reboot(); await api.wait(change.location, sleep);
    const actual = await api.get(info.controllerRoute);
    if (actual.Oem?.Dell?.DellStorageController?.ControllerMode !== plan.targetMode) throw new Error('controller mode readback mismatch');
  }
  if (plan.mode === 'hardware') {
    const creation = await api.request('POST', info.volumesRoute, { Name: 'orgiast-os', RAIDType: 'RAID1', '@Redfish.SettingsApplyTime': { ApplyTime: 'OnReset' }, Links: { Drives: plan.drives.map(d => ({ '@odata.id': d.route })) } });
    await api.wait(creation.location, sleep, true);
    await api.reboot(); await api.wait(creation.location, sleep);
    const volumes = await api.get(info.volumesRoute);
    if (volumes.Members?.length !== 1) throw new Error('RAID1 readback count mismatch');
    const volume = await api.get(volumes.Members[0]['@odata.id']);
    if (volume.RAIDType !== 'RAID1' || volume.Status?.Health !== 'OK') throw new Error('RAID1 readback failed');
  }
  const mediaCollection = await api.get(`${MANAGER}/VirtualMedia`);
  let media;
  for (const m of mediaCollection.Members ?? []) { const d = await api.get(m['@odata.id']); if (d.MediaTypes?.includes('CD')) { media = { ...d, route: m['@odata.id'] }; break; } }
  if (!media) throw new Error('virtual CD unavailable: check iDRAC Enterprise license');
  if (media.Inserted) throw new Error('existing virtual media must be reviewed/ejected first');
  const insert = media.Actions?.['#VirtualMedia.InsertMedia']?.target;
  if (!insert) throw new Error('virtual media InsertMedia unavailable');
  const mounted = await api.request('POST', insert, { Image: image.url, Inserted: true, WriteProtected: true });
  if (mounted.location) await api.wait(mounted.location, sleep);
  const readback = await api.get(media.route);
  if (!readback.Inserted || readback.Image !== image.url) throw new Error('virtual media readback mismatch');
  await api.request('PATCH', SYSTEM, { Boot: { BootSourceOverrideTarget: 'Cd', BootSourceOverrideEnabled: 'Once', BootSourceOverrideMode: 'UEFI' } });
  await api.reboot();
  return { controller: info.model, storage: plan.mode, mounted: true, hostVerification: 'pending' };
}
