import { createSheetsClient } from './tools/lib/sheets-dwd.mjs';

const SHEET_ID = '1Qa5bPpvjgpm2lFPfeG08jVMem1FWk1QkbsCHSf5eS4o';
const RANGE = "'打ち手'!K11";

async function main() {
  try {
    const c = createSheetsClient();

    const before = await c.get(SHEET_ID, RANGE);
    const beforeVal = String(before[0]?.[0] ?? '');
    const lines = beforeVal.split('\n');
    const beforeCount = lines.length;
    const beforeTarget = lines.filter((l) => l.startsWith('11/22 011NEXT:')).length;

    console.log('BEFORE lines:', beforeCount, '/ "11/22 011NEXT:" lines:', beforeTarget);

    // 重複除去（同一行は最初の1つだけ残す、順序維持）
    const seen = new Set();
    const deduped = lines.filter((l) => {
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    });

    if (deduped.length !== lines.length) {
      const newVal = deduped.join('\n');
      await c.update(SHEET_ID, RANGE, [[newVal]]);
      const after = await c.get(SHEET_ID, RANGE);
      const afterVal = String(after[0]?.[0] ?? '');
      const afterLines = afterVal.split('\n');
      const afterCount = afterLines.length;
      const afterTarget = afterLines.filter((l) => l.startsWith('11/22 011NEXT:')).length;
      console.log('AFTER lines:', afterCount, '/ "11/22 011NEXT:" lines:', afterTarget);
    } else {
      console.log('NO CHANGE (duplicates: 0) / lines:', beforeCount, '/ "11/22 011NEXT:" lines:', beforeTarget);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();