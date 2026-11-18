#!/usr/bin/env node
// Read-only: metadata + values of KGC estimate spreadsheet
import { sheetsGet, sheetsMetadata } from './lib/sheets-dwd.mjs';
import { isEntry } from './is-entry.mjs';

async function main() {
  const id = "1dDkc2-K8zXXO5Lq2i4lbeouLXseT6b73OOZ7qYvVEAI";

  // Get sheet metadata (tab names)
  const meta = await sheetsMetadata(id);
  console.log("=== Sheet metadata ===");
  for (const s of meta.sheets) {
    console.log(`  sheetId=${s.properties.sheetId} title="${s.properties.title}" rowCount=${s.properties.gridProperties?.rowCount || '?'} columnCount=${s.properties.gridProperties?.columnCount || '?'}`);
  }

  // Read each tab
  for (const s of meta.sheets) {
    const title = s.properties.title;
    const rc = s.properties.gridProperties?.rowCount || 100;
    try {
      const vals = await sheetsGet(id, `'${title.replace(/'/g, "''")}'!A5:O${Math.min(rc + 5, 200)}`);
      console.log(`\n=== Sheet: "${title}" (${vals.length} rows) ===`);
      for (let i = 0; i < vals.length; i++) {
        console.log(`  row${i+5}: [${vals[i].map(v => JSON.stringify(v)).join(', ')}]`);
      }
    } catch (e) {
      console.log(`\n=== Sheet: "${title}" === READ ERROR: ${e.message}`);
    }
  }
}

if (isEntry(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });