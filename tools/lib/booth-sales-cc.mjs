import fs from 'node:fs';

const CONFIG_URL = new URL('../../config/booth-sales-cc.json', import.meta.url);

function addressList(value) {
  return (Array.isArray(value) ? value : [value ?? ''])
    .flatMap(item => String(item).split(','))
    .map(item => item.trim())
    .filter(Boolean);
}

function bareAddress(value) {
  return value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/iu)?.[0]?.toLowerCase();
}

export function loadBoothCcConfig(readFile = fs.readFileSync) {
  return JSON.parse(readFile(CONFIG_URL, 'utf8').replace(/^\uFEFF/u, ''));
}

export function applyBoothCc({ to, cc, subject = '', body = '', booth = false }, config = loadBoothCcConfig()) {
  const copies = addressList(cc);
  const external = addressList(to).map(bareAddress).filter(Boolean).some(address => !address.endsWith('@orgiast.jp'));
  const matchedKeyword = config.keywords.find(keyword => `${subject}\n${body}`.toLocaleLowerCase('ja').includes(keyword.toLocaleLowerCase('ja')));
  if (!external) return { cc: copies, added: false, reason: 'internal_only' };
  if (!booth && !matchedKeyword) return { cc: copies, added: false, reason: 'not_booth_sales' };
  const existing = new Set(copies.map(bareAddress).filter(Boolean));
  const additions = config.cc.filter(address => !existing.has(address.toLowerCase()));
  return {
    cc: [...copies, ...additions],
    added: additions.length > 0,
    reason: booth ? 'explicit_booth_flag' : `keyword:${matchedKeyword}`,
  };
}
