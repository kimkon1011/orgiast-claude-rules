// Isolate synchronous inbox directory scans and per-item lock waits from the
// deadline-watch event loop so its individual timeout can terminate the worker.
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { listItems, applyDeadlineBatch } from '../kim-inbox.mjs';
import { retireVehicleAsks } from '../vehicle-inspection-watch.mjs';
import { defaultHome } from '../deadline-ledger.mjs';
import { isEntry } from '../is-entry.mjs';

export async function retryBatch(home, actions, { apply = applyDeadlineBatch, sleep = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return apply(home, actions); }
    catch (error) {
      if (!error.message.includes('台帳が使用中') || attempt >= 3) throw error;
      await sleep(100 * 2 ** attempt);
    }
  }
}
export async function main([operation, name, plate], home = defaultHome()) {
  if (operation === 'batch') return retryBatch(home, JSON.parse(fs.readFileSync(name, 'utf8')));
  if (operation === 'list') return listItems(home, { status: 'open' }).filter(i => i.kind === 'deadline').map(i => i.key);
  if (operation === 'retire') { retireVehicleAsks(home, { name, plate }); return null; }
  throw new Error('Unknown deadline inbox worker operation');
}
if (isEntry(import.meta.url)) console.log(JSON.stringify(await main(process.argv.slice(2))));
