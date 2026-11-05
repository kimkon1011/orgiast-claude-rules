#!/usr/bin/env node
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';

process.env.GOOGLE_IMPERSONATE = 'seisaku-team@orgiast.jp';

const SID = '1sWjVnX7amm5rgg9J_n_rsThiCZYile4aS1xfHayU0lk';

async function main() {
  const token = await getDriveToken({ impersonate: 'seisaku-team@orgiast.jp' });

  // 1. Get sheet names
  const meta = await (await driveApi(token, `https://sheets.googleapis.com/v4/spreadsheets/${SID}?fields=sheets.properties`)).json();
  console.log('=== SHEETS ===');
  meta.sheets.forEach(s => console.log(`  ${s.properties.title} (id:${s.properties.sheetId})`));

  // 2. Read "見積" sheet (the main estimate)
  for (const sheetName of ['見積', '見積 (2)', '管理画面（正式）※シート名変更禁止', '解説', '外注先支払い']) {
    try {
      const res = await driveApi(token, `https://sheets.googleapis.com/v4/spreadsheets/${SID}/values/${encodeURIComponent(sheetName)}!A1:Z200`);
      const data = await res.json();
      if (data.values) {
        console.log(`\n=== ${sheetName} (${data.values.length} rows) ===`);
        data.values.forEach((row, i) => {
          const rowStr = row.map((v, ci) => `${String.fromCharCode(65+ci)}${i+1}=${v}`).join('  |  ');
          if (rowStr.trim()) console.log(`  ${rowStr}`);
        });
      } else {
        console.log(`\n=== ${sheetName}: empty or error ===`);
        console.log(JSON.stringify(data));
      }
    } catch(e) {
      console.log(`\n=== ${sheetName}: ${e.message} ===`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });