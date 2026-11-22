import { createSheetsClient } from './tools/lib/sheets-dwd.mjs';

const SHEET_ID = '1Qa5bPpvjgpm2lFPfeG08jVMem1FWk1QkbsCHSf5eS4o';
const RANGE = "'打ち手'!K11";

async function main() {
  try {
    const c = createSheetsClient();
    console.log('Getting K11 value...');
    
    const before = await c.get(SHEET_ID, RANGE);
    const beforeVal = String(before[0]?.[0] ?? '');
    console.log('K11 value length:', beforeVal.length);
    console.log('First 100 characters:', beforeVal.substring(0, 100));
    
    // Check if it contains the target pattern
    const hasTargetPattern = beforeVal.includes('11/22 011NEXT:');
    console.log('Contains "11/22 011NEXT:":', hasTargetPattern);
    
    // Count lines
    const lines = beforeVal.split('\n');
    console.log('Total lines:', lines.length);
    
    // Count target lines
    const targetLines = lines.filter((l) => l.includes('11/22 011NEXT:')).length;
    console.log('Lines with "11/22 011NEXT:":', targetLines);
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Error stack:', error.stack);
  }
}

main();