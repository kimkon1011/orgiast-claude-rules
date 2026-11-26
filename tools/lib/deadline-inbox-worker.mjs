// Isolate synchronous inbox directory scans and per-item lock waits from the
// deadline-watch event loop so its individual timeout can terminate the worker.
import fs from 'node:fs';
import { listItems, batchDeadlineOps } from '../kim-inbox.mjs';
import { retireVehicleAsks } from '../vehicle-inspection-watch.mjs';
import { defaultHome } from '../deadline-ledger.mjs';
import { isEntry } from '../is-entry.mjs';

export function main(argv, home = defaultHome()) {
  const [operation, ...rest] = argv;
  if (operation === 'list') return listItems(home, { status: 'open' }).filter(i => i.kind === 'deadline').map(i => i.key);
  if (operation === 'retire') { retireVehicleAsks(home, { name: rest[0], plate: rest[1] }); return null; }
  if (operation === 'batch') {
    const raw = rest[0] ? fs.readFileSync(rest[0], 'utf8') : fs.readFileSync(0, 'utf8');
    const ops = JSON.parse(raw);
    const results = batchDeadlineOps(home, ops);
    for (const result of results) {
      if (!result.ok || !result.vehicleName || !result.plate) continue;
      retireVehicleAsks(home, { name: result.vehicleName, plate: result.plate });
    }
    return results;
  }
  throw new Error('Unknown deadline inbox worker operation');
}
if (isEntry(import.meta.url)) console.log(JSON.stringify(main(process.argv.slice(2))));
