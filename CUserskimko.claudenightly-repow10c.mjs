import { createSheetsClient } from 'file:///C:/Users/kimko/.claude/nightly-repo/tools/lib/sheets-dwd.mjs';

const SHEET_ID = '1Qa5bPpvjgpm2lFPfeG08jVMem1FWk1QkbsCHSf5eS4o';

const c = createSheetsClient();

// Get the current value of K11
const k11Data = await c.get(SHEET_ID, "'打ち手'!K11");
const k11Value = k11Data[0][0];

console.log('Original K11 value:');
console.log(k11Value);

// Split into lines
const lines = k11Value.split('\n');

// Count occurrences of "11/22 011NEXT:" lines
const kimNoteLines = lines.filter(line => line.includes('11/22 011NEXT:')).length;
console.log(`Before deduplication: ${lines.length} lines, ${kimNoteLines} "11/22 011NEXT:" lines`);

// Remove duplicate lines while preserving order
const uniqueLines = [];
const seenLines = new Set();

for (const line of lines) {
  if (!seenLines.has(line)) {
    uniqueLines.push(line);
    seenLines.add(line);
  }
}

const newValue = uniqueLines.join('\n');

// Count occurrences of "11/22 011NEXT:" lines after deduplication
const newKimNoteLines = uniqueLines.filter(line => line.includes('11/22 011NEXT:')).length;
console.log(`After deduplication: ${uniqueLines.length} lines, ${newKimNoteLines} "11/22 011NEXT:" lines`);

// Update only if different
if (newValue !== k11Value) {
  console.log('Updating K11 with deduplicated content...');
  await c.update(SHEET_ID, "'打ち手'!K11", [[newValue]]);
  
  // Read back to verify
  const verifyData = await c.get(SHEET_ID, "'打ち手'!K11");
  const verifyValue = verifyData[0][0];
  const verifyLines = verifyValue.split('\n');
  const verifyKimNoteLines = verifyLines.filter(line => line.includes('11/22 011NEXT:')).length;
  
  console.log(`Verified: ${verifyLines.length} lines, ${verifyKimNoteLines} "11/22 011NEXT:" lines`);
} else {
  console.log('No duplicates found, no update needed.');
}
