// Isolate synchronous inbox directory scans and per-item lock waits from the
// deadline-watch event loop so its individual timeout can terminate the worker.
import { listItems } from '../kim-inbox.mjs';
import { retireVehicleAsks } from '../vehicle-inspection-watch.mjs';
import { defaultHome } from '../deadline-ledger.mjs';
import { isEntry } from '../is-entry.mjs';

export function main([operation, name, plate], home = defaultHome()) {
  if (operation === 'list') return listItems(home, { status: 'open' }).filter(i => i.kind === 'deadline').map(i => i.key);
  if (operation === 'retire') { retireVehicleAsks(home, { name, plate }); return null; }
  throw new Error('Unknown deadline inbox worker operation');
}
if (isEntry(import.meta.url)) console.log(JSON.stringify(main(process.argv.slice(2))));
