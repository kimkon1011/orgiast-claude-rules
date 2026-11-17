const XLSX = require('xlsx');
const TMP = 'C:/Users/USER/AppData/Local/Temp';

function dumpSheet(wb, sheetName, label) {
  const ws = wb.Sheets[sheetName];
  if (!ws) { process.stdout.write(`[${label}] Sheet "${sheetName}" not found.\n`); return; }
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  process.stdout.write(`\n===== ${label}: ${sheetName} =====\n`);
  const maxRows = 999;
  for (let r = 0; r < Math.min(data.length, maxRows); r++) {
    const row = data[r];
    const cells = row.map((v, c) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      const str = String(v ?? '').trim();
      return str ? `${addr}=${str}` : null;
    }).filter(Boolean);
    if (cells.length > 0) {
      process.stdout.write(`Row ${r}: ${cells.join(' | ')}\n`);
    }
  }
  if (data.length > maxRows) process.stdout.write(`... (${data.length - maxRows} more rows truncated)\n`);
}

const target = process.argv[2];

if (target === 'all-sheets') {
  const wb = XLSX.readFile(`${TMP}/case-management.xlsx`);
  process.stdout.write('=== All sheets in case-management ===\n');
  wb.SheetNames.forEach(s => process.stdout.write(`  - ${s}\n`));
  for (const sn of wb.SheetNames) {
    dumpSheet(wb, sn, 'case');
  }
} else if (target === 'sheet2') {
  const wb = XLSX.readFile(`${TMP}/case-management.xlsx`);
  dumpSheet(wb, 'シート2', 'case');
} else if (target === 'fee-v3') {
  const wb = XLSX.readFile(`${TMP}/rebooth-fee-v3.xlsx`);
  process.stdout.write('=== All sheets in fee-v3 ===\n');
  wb.SheetNames.forEach(s => process.stdout.write(`  - ${s}\n`));
  for (const sn of wb.SheetNames) {
    dumpSheet(wb, sn, 'v3');
  }
} else if (target === 'designer') {
  const wb = XLSX.readFile(`${TMP}/case-management.xlsx`);
  for (const sn of wb.SheetNames) {
    if (sn.includes('デザイナー') || sn.includes('ディレクター')) {
      dumpSheet(wb, sn, `case:${sn}`);
    }
  }
} else {
  process.stdout.write('Usage: read-xlsx.cjs <all-sheets|sheet2|fee-v3|designer>\n');
}