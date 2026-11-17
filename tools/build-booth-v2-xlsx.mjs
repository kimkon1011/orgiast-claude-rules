import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('C:/Users/USER/AppData/Local/Temp/booth-xlsx/node_modules/xlsx');

const source = 'C:/Users/USER/terminals/gb-r-1300-booth-list.md';
const output = 'C:/Users/USER/terminals/gb-r-1300-booth-list-v2.xlsx';
const docSource = 'C:/Users/USER/terminals/gb-r-1300-booth-email.md';
const text = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
const names = ['展示会15件', '出展企業50社', '過去実績と選定理由', 'メール下書き'];
function section(name) {
  const marker = `## ${name}`;
  const start = text.indexOf(marker) + marker.length;
  const end = text.indexOf('\n## ', start);
  return (end < 0 ? text.slice(start) : text.slice(start, end)).trim();
}
function tableRows(body) {
  const rows = body.split(/\r?\n/).filter(x => x.trim().startsWith('|')).map(line =>
    line.trim().slice(1, -1).split('|').map(cell => cell.trim().replaceAll('<br>', '\n')));
  return [rows[0], ...rows.slice(2)];
}
const wb = XLSX.utils.book_new();
for (const name of names.slice(0, 3)) {
  const ws = XLSX.utils.aoa_to_sheet(tableRows(section(name)));
  ws['!autofilter'] = { ref: ws['!ref'] };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const range = XLSX.utils.decode_range(ws['!ref']);
  ws['!cols'] = Array.from({length: range.e.c + 1}, (_, c) => ({ wch: Math.min(42, Math.max(12, ...Array.from({length: Math.min(range.e.r + 1, 30)}, (__, r) => String(ws[XLSX.utils.encode_cell({r,c})]?.v ?? '').length + 2))) }));
  XLSX.utils.book_append_sheet(wb, ws, name);
}
const email = section('メール下書き');
fs.writeFileSync(docSource, email + '\n', 'utf8');
const emailWs = XLSX.utils.aoa_to_sheet(email.split(/\r?\n/).map(line => [line]));
emailWs['!freeze'] = { xSplit: 0, ySplit: 1 };
emailWs['!cols'] = [{ wch: 120 }];
XLSX.utils.book_append_sheet(wb, emailWs, 'メール下書き');
XLSX.writeFile(wb, output);
const check = XLSX.readFile(output);
console.log(`xlsx=${output}`);
for (const name of check.SheetNames) {
  const range = XLSX.utils.decode_range(check.Sheets[name]['!ref']);
  console.log(`${name}: rows=${range.e.r + 1} cols=${range.e.c + 1}`);
}
console.log(`doc_source=${docSource}`);
