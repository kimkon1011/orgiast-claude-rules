import { loadLedger, buildAlert, bodyText } from '../tools/unsent-ledger.mjs';

const ledger = loadLedger();
const built = buildAlert(ledger, { now: new Date() });
const md = built.markdown;
const sections = md.split(/^## /m);
const rows = sections.map((s, i) => {
  const title = i === 0 ? '(header)' : s.split('\n', 1)[0];
  return { title, bytes: Buffer.byteLength(i === 0 ? s : `## ${s}`, 'utf8') };
});
const stopped = ledger.items.filter((x) => x.status === '止まった');
let bodyBytes = 0;
let big = [];
for (const item of stopped) {
  const b = bodyText(item);
  bodyBytes += Buffer.byteLength(b, 'utf8');
  if (b.length > 2000) big.push({ id: item.id, len: b.length, reason: item.status_reason });
}
big.sort((a, b) => b.len - a.len);
console.log(JSON.stringify({
  total: Buffer.byteLength(md, 'utf8'),
  sections: rows,
  checkErrors: built.counts.checkErrors,
  unsent: built.counts.unsent,
  stoppedShownBodiesSample: big.slice(0, 10),
}, null, 2));
