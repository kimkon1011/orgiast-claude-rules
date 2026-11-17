const XLSX = require('xlsx');
const wb = XLSX.readFile('C:/Users/USER/AppData/Local/Temp/rebooth-fee-v4-result.xlsx');
const ws = wb.Sheets['料金表v4_2026.2改定準拠_1117'];
process.stdout.write('ref: ' + (ws['!ref'] || 'undefined') + '\n');
if (ws['!ref']) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  process.stdout.write('range: ' + JSON.stringify(range) + '\n');
  let count = 0;
  for (let r = 0; r <= range.e.r; r++) {
    let hasCell = false;
    for (let c = 0; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) { hasCell = true; break; }
    }
    if (hasCell) {
      count++;
      if (count <= 10) {
        const cells = [];
        for (let c = 0; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          if (ws[addr]) cells.push(addr + '=' + String(ws[addr].v).substring(0, 60));
        }
        process.stdout.write('row ' + r + ': ' + cells.join(', ') + '\n');
      }
    }
  }
  process.stdout.write('total non-empty rows: ' + count + '\n');
} else {
  process.stdout.write('Sheet is empty (no ref)\n');
  // Enumerate all keys
  const keys = Object.keys(ws).filter(k => !k.startsWith('!'));
  process.stdout.write('cell keys count: ' + keys.length + '\n');
  if (keys.length > 0) {
    process.stdout.write('first 5 keys: ' + keys.slice(0, 5).join(', ') + '\n');
    process.stdout.write('first cell: ' + keys[0] + '=' + String(ws[keys[0]].v).substring(0, 60) + '\n');
  }
}