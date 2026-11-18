import { sheetsMetadata } from './lib/sheets-dwd.mjs';

const SHEET_ID = '1eLllahzpTeDQt0A8KT1D1XeYItEkqzbFlwYQhXUy75M';

try {
  const meta = await sheetsMetadata(SHEET_ID);
  console.log('Sheet URL:', meta.spreadsheetUrl);
  for (const s of meta.sheets) {
    const p = s.properties;
    console.log(`Tab: "${p.title}" (sheetId=${p.sheetId}, rows=${p.gridProperties?.rowCount ?? '?'}, cols=${p.gridProperties?.columnCount ?? '?'})`);
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}