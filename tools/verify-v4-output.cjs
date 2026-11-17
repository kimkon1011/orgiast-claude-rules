const XLSX = require('xlsx');
const TMP = 'C:/Users/USER/AppData/Local/Temp';
const wb = XLSX.readFile(`${TMP}/rebooth-fee-v4-result.xlsx`);

// 1. Check tabs
process.stdout.write('=== タブ一覧 ===\n');
wb.SheetNames.forEach(n => process.stdout.write(`  - ${n}\n`));

// 2. Verify v3 renamed
const hasV3Rename = wb.SheetNames.some(n => n.includes('【誤り・旧ブロック使用】'));
process.stdout.write(`\n✅ v3リネーム: ${hasV3Rename ? 'OK' : 'FAIL'}\n`);

// 3. Verify v4 exists
const v4Name = wb.SheetNames.find(n => n.includes('料金表v4'));
process.stdout.write(`✅ v4タブ存在: ${v4Name ? 'OK' : 'FAIL'} - ${v4Name || 'N/A'}\n`);

// 4. Read v4 content
if (v4Name) {
  const ws = wb.Sheets[v4Name];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  
  process.stdout.write('\n=== v4タブ内容（最初の80行）===\n');
  for (let i = 0; i < Math.min(data.length, 80); i++) {
    const row = data[i];
    const cells = row.map((v, c) => {
      const s = String(v ?? '').trim();
      return s ? `${XLSX.utils.encode_cell({r:i,c})}=${s.substring(0,80)}` : null;
    }).filter(Boolean);
    if (cells.length > 0) process.stdout.write(`Row ${i}: ${cells.join(' | ')}\n`);
  }
  if (data.length > 80) process.stdout.write(`... ${data.length - 80} more rows\n`);
  process.stdout.write(`\nTotal rows: ${data.length}\n`);
  
  // 5. Verify key amounts
  process.stdout.write('\n=== 金額検証 ===\n');
  let checks = 0, passed = 0;
  
  // Search for key cells
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    // Check row starting with "S" and having 20000
    if (String(row[0]).trim() === 'S' && String(row[1]).includes('9〜18')) {
      const d = String(row[3]);
      const e = String(row[4]);
      process.stdout.write(`S区分: D${i}=${d} (expect 20000), E${i}=${e} (expect 40000) → Sheet2!H1 ✓\n`);
      checks++; if (d.includes('20000')) passed++;
      checks++; if (e.includes('40000')) passed++;
    }
    if (String(row[0]).trim() === 'M' && String(row[1]).includes('18〜27')) {
      const d = String(row[3]);
      const e = String(row[4]);
      process.stdout.write(`M区分: D${i}=${d} (expect 20000), E${i}=${e} (expect 40000) → Sheet2!H1 ✓\n`);
      checks++; if (d.includes('20000')) passed++;
      checks++; if (e.includes('40000')) passed++;
    }
    if (String(row[0]).trim() === 'L' && String(row[1]).includes('27〜36')) {
      const d = String(row[3]);
      const e = String(row[4]);
      process.stdout.write(`L区分: D${i}=${d} (expect 20000), E${i}=${e} (expect 40000) → Sheet2!H1 ✓\n`);
      checks++; if (d.includes('20000')) passed++;
      checks++; if (e.includes('40000')) passed++;
    }
    if (String(row[0]).trim() === 'XL' && String(row[1]).includes('37〜54')) {
      const d = String(row[3]);
      const e = String(row[4]);
      process.stdout.write(`XL区分: D${i}=${d} (expect 20,000+8,000), E${i}=${e} (expect 40,000+4,000) → Sheet2!H1 ✓\n`);
      checks++; if (d.includes('20,000+8,000')) passed++;
      checks++; if (e.includes('40,000+4,000')) passed++;
    }
    // Check correction rates from Sheet2!H1
    if (String(row[0]).includes('修正6回目') && String(row[0]).includes('36㎡以下')) {
      const c = String(row[2]);
      process.stdout.write(`修正6回目(36㎡以下): C${i}=${c} (expect 10,000円/回) → Sheet2!H1 ✓\n`);
      checks++; if (c.includes('10,000')) passed++;
    }
    // Check 1案追加
    if (String(row[0]).trim() === '1案追加（36㎡以下）') {
      const b = String(row[1]);
      process.stdout.write(`1案追加(36㎡以下): B${i}=${b} (expect 10,000円) → Sheet2!H1 ✓\n`);
      checks++; if (b.includes('10,000')) passed++;
    }
    // Check 継続リサイズ
    if (String(row[0]).includes('36㎡以下') && String(row[0]).includes('継続リサイズ') === false && String(row[0]).includes('出典セル') === false) {
      // check if it's the 継続リサイズ row
      if (String(row[1]).includes('15,000')) {
        process.stdout.write(`継続リサイズ36㎡以下: B${i}=${String(row[1])} → Sheet2!K1 ✓\n`);
        checks++; if (String(row[1]).includes('15,000')) passed++;
      }
    }
    // Check 直接やりとり
    if (String(row[0]).includes('お客様との直接やりとり') && String(row[0]).includes('【E】') === false) {
      const b = String(row[1]);
      process.stdout.write(`直接やりとり: B${i}=${b} (expect 10,000円) → Sheet2!N14 ✓\n`);
      checks++; if (b.includes('10,000')) passed++;
    }
    // Check 新規デザイン物
    if (String(row[0]).includes('追加の新規デザイン物') || String(row[0]).includes('追加新規デザイン物')) {
      const b = String(row[1]);
      process.stdout.write(`追加新規デザイン物: B${i}=${b} (expect 6,000円/点) → Sheet2!N17 ✓\n`);
      checks++; if (b.includes('6,000')) passed++;
    }
  }
  
  process.stdout.write(`\n✅ 検証: ${passed}/${checks} 一致\n`);
  if (passed < checks) {
    process.stdout.write(`⚠ ${checks - passed} 項目が期待値と一致しません\n`);
  }
  
  // 6. List 要kim判断 items
  process.stdout.write('\n=== 要kim判断の全項目 ===\n');
  data.forEach((row, i) => {
    row.forEach((cell, c) => {
      const s = String(cell || '');
      if (s.includes('要kim判断')) {
        process.stdout.write(`  ${XLSX.utils.encode_cell({r:i,c})}: ${s.substring(0, 100)}\n`);
      }
    });
  });
}