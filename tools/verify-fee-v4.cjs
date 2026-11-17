/**
 * Verify v4 fee table against Sheet2 (2026.2改定 block)
 * Reads the output xlsx and checks every amount
 */
const XLSX = require('xlsx');
const TMP = 'C:/Users/USER/AppData/Local/Temp';

const wb = XLSX.readFile(`${TMP}/rebooth-fee-v4-result.xlsx`);

// Verify tab names
const names = wb.SheetNames;
console.log('=== タブ一覧 ===');
names.forEach(n => console.log(`  - ${n}`));

// Check v3 tab renamed
const v3Renamed = names.find(n => n.includes('【誤り・旧ブロック使用】'));
console.log(`\n✅ v3リネーム: ${v3Renamed ? 'OK' : 'FAIL!'} - ${v3Renamed || '見つかりません'}`);

// Check v4 tab exists
const v4Tab = names.find(n => n.includes('料金表v4'));
console.log(`✅ v4タブ存在: ${v4Tab ? 'OK' : 'FAIL!'} - ${v4Tab || '見つかりません'}`);

// Read v4 sheet
const ws = wb.Sheets[v4Tab];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// Print all data for inspection
console.log('\n=== v4タブ全体 ===');
data.forEach((row, i) => {
  const cells = row.map((v, c) => {
    const addr = XLSX.utils.encode_cell({ r: i, c });
    const str = String(v ?? '').trim();
    return str ? `${addr}=${str}` : null;
  }).filter(Boolean);
  if (cells.length > 0) {
    console.log(`Row ${i}: ${cells.join(' | ')}`);
  }
});

// ── Verification ──
const results = [];
function check(label, expected, actual, source) {
  const match = expected === actual;
  results.push({ label, expected, actual, source, match: match ? '✓' : '✗' });
  if (!match) {
    console.log(`\n❌ ${label}: 期待値=${expected}, 実値=${actual}, 出典=${source}`);
  } else {
    console.log(`✓ ${label}: ${actual} (出典: ${source})`);
  }
}

// Expected values from Sheet2 H1 (2026.2改定)
console.log('\n=== 検証: シート2 2026.2改定ブロックとの一致 ===');

// Find key values in the data
let foundS = false, foundSS = false, foundXL = false;
data.forEach((row, i) => {
  const a = String(row[0] || '').trim();
  const d = String(row[3] || '').trim();  // 提案費
  const e = String(row[4] || '').trim();  // 受注費
  
  if (a === 'S' && row[1] && String(row[1]).includes('9〜18')) {
    check(`S区分 提案費`, '20000', d, 'シート2!H1');
    check(`S区分 受注費(追加)`, '40000', e, 'シート2!H1');
    foundS = true;
  }
  if (a === 'M' && row[1] && String(row[1]).includes('18〜27')) {
    check(`M区分 提案費`, '20000', d, 'シート2!H1');
    check(`M区分 受注費(追加)`, '40000', e, 'シート2!H1');
  }
  if (a === 'L' && row[1] && String(row[1]).includes('27〜36')) {
    check(`L区分 提案費`, '20000', d, 'シート2!H1');
    check(`L区分 受注費(追加)`, '40000', e, 'シート2!H1');
  }
  if (a === 'XL' && row[1] && String(row[1]).includes('37〜54')) {
    check(`XL区分 提案費(基本+加算)`, '20,000+8,000', d, 'シート2!H1');
    check(`XL区分 受注費(基本+加算)`, '40,000+4,000', e, 'シート2!H1');
    foundXL = true;
  }
  if (a === 'SS' && row[1] && String(row[1]).includes('0〜9')) {
    check(`SS区分 提案費`, `要kim判断`, d, 'シート2にSS区分なし');
    foundSS = true;
  }
});

console.log(`\n✅ S区分検出: ${foundS ? 'OK' : 'FAIL'}`);
console.log(`✅ SS区分検出: ${foundSS ? 'OK' : 'FAIL'}`);
console.log(`✅ XL区分検出: ${foundXL ? 'OK' : 'FAIL'}`);

// Check source references
console.log('\n=== 要kim判断の項目 ===');
data.forEach((row, i) => {
  const a = String(row[0] || '').trim();
  if (a.includes('要kim判断') || a.toLowerCase().includes('要kim')) {
    console.log(`Row ${i}: ${row.slice(0, 4).join(' | ')}`);
  }
});
// Also check cells containing "要kim判断"
let kimItems = [];
data.forEach((row, i) => {
  row.forEach((cell, c) => {
    const s = String(cell || '');
    if (s.includes('要kim判断')) {
      kimItems.push(`${XLSX.utils.encode_cell({ r: i, c })}: ${s.substring(0, 100)}`);
    }
  });
});
console.log('要kim判断の全出現:');
kimItems.forEach(item => console.log(`  ${item}`));

// Summary
console.log('\n=== 検証結果サマリ ===');
const passed = results.filter(r => r.match === '✓').length;
const failed = results.filter(r => r.match === '✗').length;
console.log(`一致: ${passed}, 不一致: ${failed}`);
if (failed > 0) {
  console.log('\n⚠ 不一致の項目:');
  results.filter(r => r.match === '✗').forEach(r => {
    console.log(`  ${r.label}: 期待値=${r.expected}, 実値=${r.actual}`);
  });
}