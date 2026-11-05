#!/usr/bin/env node
import { channelRequest } from './lib/gws-proxy.mjs';

const SID = '1sWjVnX7amm5rgg9J_n_rsThiCZYile4aS1xfHayU0lk';

async function main() {
  // Try direct channel request with sheets service
  const result = await channelRequest('gws', {
    body: {
      service: 'sheets',
      path: `/v4/spreadsheets/${SID}/values/%E8%A7%A3%E8%AA%AC!B50:B74`,
      method: 'GET'
    }
  });
  console.log('Sheets result:', JSON.stringify(result, null, 2));
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });