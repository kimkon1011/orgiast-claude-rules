#!/usr/bin/env node
/**
 * Batch update a Google Sheets spreadsheet:
 * - Rename a sheet (tab)
 * - Add a new sheet with data
 * 
 * Uses sheets.googleapis.com through the gws proxy.
 * Usage: node tools/batch-update-sheets.mjs --id <sheetId> --rename "oldName" "newName" --add "newTabName" --data <jsonFile>
 *   or: node tools/batch-update-sheets.mjs --id <sheetId> --rename "oldName" "newName" --rename-only
 *
 * --data file: JSON array of arrays (rows), first row = header
 */
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { readFileSync, existsSync } from 'node:fs';
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
    else if (argv[i] === '--rename') { args.oldName = argv[++i]; args.newName = argv[++i]; }
    else if (argv[i] === '--add') args.addName = argv[++i];
    else if (argv[i] === '--data') args.dataFile = argv[++i];
    else if (argv[i] === '--rename-only') args.renameOnly = true;
    else throw new Error(`unknown: ${argv[i]}`);
  }
  if (!args.id) throw new Error('--id required');
  
  const as = 'seisaku-team@orgiast.jp';
  const token = await getDriveToken({ impersonate: as });
  
  // Get current sheets
  const sheets = await getSheets(token, args.id);
  console.log('Current sheets:', sheets.map(s => s.properties.title).join(', '));
  
  const requests = [];
  
  // Rename sheet
  if (args.oldName && args.newName) {
    const sheet = sheets.find(s => s.properties.title === args.oldName);
    if (sheet) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: sheet.properties.sheetId, title: args.newName },
          fields: 'title',
        },
      });
      console.log(`Renaming sheet ${args.oldName} (id=${sheet.properties.sheetId}) → ${args.newName}`);
    } else {
      console.log(`Sheet "${args.oldName}" not found. Available: ${sheets.map(s => s.properties.title).join(', ')}`);
    }
  }
  
  if (args.renameOnly) {
    if (requests.length > 0) {
      const result = await batchUpdate(token, args.id, requests);
      console.log('Rename result:', JSON.stringify(result));
    }
    return;
  }
  
  // Add new sheet
  if (args.addName) {
    requests.push({
      addSheet: { properties: { title: args.addName } },
    });
    console.log(`Adding sheet: ${args.addName}`);
  }
  
  if (requests.length > 0) {
    const result = await batchUpdate(token, args.id, requests);
    // Get the sheet IDs
    const updatedSheets = await getSheets(token, args.id);
    
    // If we added a sheet, populate it
    if (args.addName && args.dataFile) {
      const addedSheet = updatedSheets.find(s => s.properties.title === args.addName);
      if (!addedSheet) throw new Error(`Sheet "${args.addName}" was not created`);
      const sheetId = addedSheet.properties.sheetId;
      
      const data = JSON.parse(readFileSync(args.dataFile, 'utf-8'));
      if (!Array.isArray(data) || data.length === 0) throw new Error('Data must be a non-empty array of arrays');
      
      const maxCols = Math.max(...data.map(row => row.length));
      
      // Build the update cells request
      const rows = data.map((row, i) => ({
        values: row.map((cell, j) => ({
          userEnteredValue: typeof cell === 'number' ? { numberValue: cell }
                         : cell !== '' ? { stringValue: String(cell) }
                         : null,
        })),
      }));
      
      // Populate data in smaller batches (sheets API has a 10MB request limit)
      const BATCH_SIZE = 50;
      for (let startRow = 0; startRow < data.length; startRow += BATCH_SIZE) {
        const endRow = Math.min(startRow + BATCH_SIZE, data.length);
        const batchRows = rows.slice(startRow, endRow);
        
        const updateReq = {
          updateCells: {
            start: { sheetId, rowIndex: startRow, columnIndex: 0 },
            rows: batchRows,
            fields: 'userEnteredValue',
          },
        };
        
        console.log(`Writing rows ${startRow}-${endRow-1}...`);
        await batchUpdate(token, args.id, [updateReq]);
      }
      
      console.log(`Populated sheet "${args.addName}" with ${data.length} rows`);
    }
    
    console.log('Update completed successfully');
  }
}

if (isEntry(import.meta.url)) {
  main().catch(err => {
    console.error(`batch-update-sheets: ${err.message}`);
    process.exitCode = 1;
  });
}