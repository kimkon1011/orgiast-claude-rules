import XLSX from 'xlsx';
const wb = XLSX.readFile('C:/Users/USER/.qwen/tmp/landing-page-server.xlsx');
console.log('Sheet names:', JSON.stringify(wb.SheetNames));
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  console.log('\n=== Sheet:', name, '===');
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  console.log('Total rows:', data.length);
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (row && row.length > 0) {
      console.log(`Row ${i+1}:`, JSON.stringify(row));
    }
  }
}