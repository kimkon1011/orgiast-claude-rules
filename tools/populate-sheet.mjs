#!/usr/bin/env node
/**
 * Populate an existing sheet with data.
 * Usage: node tools/populate-sheet.mjs --id <spreadsheetId> --sheet <sheetName> --data <jsonFile>
 */
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { readFileSync } from 'node:fs';
import { isEntry } from './is-entry.mjs';

async function getSheets(token, spreadsheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`;
  const res = await driveApi(token, url);
  const json = await res.json();
  return json.sheets || [];
}

async function batchUpdate(token, spreadsheetId, requests) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
  const res = await driveApi(token, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`batchUpdate error ${res.status}: ${text}`);
  }
  return res.json();
}

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') args.id = argv[++i];
    else if (argv[i] === '--sheet') args.sheet = argv[++i];
    else if (argv[i] === '--data') args.dataFile = argv[++i];
    else if (argv[i] === '--delete-sheet') args.deleteSheet = argv[++i];
    else throw new Error(`unknown: ${argv[i]}`);
  }
  if (!args.id) throw new Error('--id required');

  const as = 'seisaku-team@orgiast.jp';
  const token = await getDriveToken({ impersonate: as });
  
  if (args.deleteSheet) {
    const sheets = await getSheets(token, args.id);
    const sheet = sheets.find(s => s.properties.title === args.deleteSheet);
    if (sheet) {
      console.log(`Deleting sheet "${args.deleteSheet}" (id=${sheet.properties.sheetId})`);
      await batchUpdate(token, args.id, [{
        deleteSheet: { sheetId: sheet.properties.sheetId },
      }]);
      console.log('Deleted');
    } else {
      console.log(`Sheet "${args.deleteSheet}" not found`);
    }
    return;
  }
  
  const sheets = await getSheets(token, args.id);
  const sheet = sheets.find(s => s.properties.title === args.sheet);
  if (!sheet) throw new Error(`Sheet "${args.sheet}" not found`);
  const sheetId = sheet.properties.sheetId;
  
  const data = JSON.parse(readFileSync(args.dataFile, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('Data must be a non-empty array of arrays');
  
  console.log(`Populating sheet "${args.sheet}" (id=${sheetId}) with ${data.length} rows, ${Math.max(...data.map(r => r.length))} cols`);
  
  // First clear existing content
  await batchUpdate(token, args.id, [{
    updateCells: {
      range: { sheetId, startRowIndex: 0, startColumnIndex: 0 },
      fields: 'userEnteredValue',
    },
  }]);
  
  // Write in batches of 50 rows
  const BATCH_SIZE = 50;
  for (let startRow = 0; startRow < data.length; startRow += BATCH_SIZE) {
    const endRow = Math.min(startRow + BATCH_SIZE, data.length);
    const batchRows = data.slice(startRow, endRow).map(row => ({
      values: row.map(cell => {
        if (typeof cell === 'number') return { userEnteredValue: { numberValue: cell } };
        if (cell === '' || cell === null || cell === undefined) return {};
        return { userEnteredValue: { stringValue: String(cell) } };
      }),
    }));
    
    console.log(`Writing rows ${startRow}-${endRow-1}...`);
    await batchUpdate(token, args.id, [{
      updateCells: {
        start: { sheetId, rowIndex: startRow, columnIndex: 0 },
        rows: batchRows,
        fields: 'userEnteredValue',
      },
    }]);
  }
  
  console.log('Done');
}

if (isEntry(import.meta.url)) {
  main().catch(err => {
    console.error(`populate-sheet: ${err.message}`);
    process.exitCode = 1;
  });
}