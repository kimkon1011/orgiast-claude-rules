import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A temporary HOME alone still falls back to the real hostname and global Git email.
// Configure both the fleet label and its owner so delivery policy is deterministic.
export function progressHome(prefix = 'auto-progress-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=auto-progress-test-PC\n');
  fs.writeFileSync(path.join(dir, 'fleet-pc-map.json'), JSON.stringify({
    'auto-progress-test-PC': { account: 'test-owner@example.com' },
  }));
  return home;
}

// Even a mocked DM can trigger a real Windows toast when the row has a local owner.
export const notificationMocks = {
  notifyOwner: async () => ({ delivered: 'none', reason: 'test default' }),
  sendOwnerToast: () => true,
};
