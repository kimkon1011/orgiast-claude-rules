import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(new URL('../../config/mail-groups.json', import.meta.url), 'utf8'));
export function routeMailbox(user, query = '') {
  const address = String(user || '').trim().toLowerCase();
  if (!config.groups.includes(address)) return { user: address, query };
  return { user: config.mailbox, query: `to:${address}${query ? ` (${query})` : ''}`,
    notice: `${address} はGoogleグループです。${config.mailbox} の to:${address} 検索に切り替えました。` };
}
