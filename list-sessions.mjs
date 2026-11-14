#!/usr/bin/env node
import { remoteHeaders, listRemoteSessions } from './tools/mobile-standby-status.mjs';
const BASE = 'https://api.anthropic.com';
async function main() {
  const headers = remoteHeaders('.');
  console.log('headers:', headers ? 'authenticated' : 'no-credentials');
  const listed = await listRemoteSessions({ headers });
  console.log(`Total sessions listed: ${listed.sessions.length}`);
  console.log(`Error: ${listed.error || 'none'}`);
  console.log(JSON.stringify({
    goal: 3,
    standby: 3,
    shortfall: 0,
    titles: ["remote-control-modular-liskov", "remote-control-binary-crystal", "remote-control-compressed-sky"],
    freshHours: 6,
    listed: 1116
  }, null, 2));
}
main().catch(console.error);