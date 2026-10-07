#!/usr/bin/env node
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const USAGE = 'Usage: node tools/sheet-read.mjs <spreadsheetId|URL> [--tabs | --gid N | --tab TITLE] [--grep REGEXP] [--range A1:Z300] [--max-rows N] [--as EMAIL]\nWithout a tab selector, reads all tabs with title and row number. --max-rows limits output, never the search. TRUNCATED counts output rows (matches with --grep).';

export function parseArgs(argv) {
  const opts = { maxRows: 500, impersonate: 'kim@orgiast.jp' };
  const names = { '--gid': 'gid', '--tab': 'tab', '--grep': 'grep', '--range': 'range', '--max-rows': 'maxRows', '--as': 'impersonate' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--tabs') { opts.tabs = true; continue; }
    if (names[arg]) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`);
      opts[names[arg]] = argv[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (opts.input) throw new Error('Only one spreadsheet ID or URL is allowed');
    else opts.input = arg;
  }
  if (opts.help) return opts;
  if (!opts.input) throw new Error(USAGE);
  let urlGid;
  if (/^https?:\/\//i.test(opts.input)) {
    const url = new URL(opts.input);
    const match = url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)(?:\/|$)/);
    if (url.hostname !== 'docs.google.com' || !match) throw new Error('Expected a Google Sheets URL');
    opts.id = match[1];
    urlGid = new URLSearchParams(url.hash.slice(1)).get('gid') ?? url.searchParams.get('gid');
  } else opts.id = opts.input;
  if (!/^[\w-]+$/.test(opts.id)) throw new Error('Invalid spreadsheet ID');
  if (opts.gid !== undefined && opts.tab !== undefined) throw new Error('Choose --gid or --tab');
  if (opts.gid === undefined && opts.tab === undefined && urlGid !== null && urlGid !== undefined) opts.gid = urlGid;
  if (opts.gid !== undefined && !/^\d+$/.test(opts.gid)) throw new Error('Invalid gid');
  if (!/^\d+$/.test(String(opts.maxRows)) || !Number.isSafeInteger(Number(opts.maxRows)) || Number(opts.maxRows) < 1) throw new Error('--max-rows must be a positive integer');
  opts.maxRows = Number(opts.maxRows);
  if (opts.range !== undefined && !/^(?:[A-Za-z]+[1-9]\d*(?::[A-Za-z]+[1-9]\d*)?|[A-Za-z]+:[A-Za-z]+|[1-9]\d*:[1-9]\d*|[A-Za-z]+[1-9]\d*:[A-Za-z]+)$/.test(opts.range)) throw new Error('--range must be a tab-local A1 range, e.g. A1:Z300');
  if (opts.grep !== undefined) opts.pattern = new RegExp(opts.grep);
  if (opts.tabs && (opts.grep !== undefined || opts.range !== undefined)) throw new Error('--tabs cannot be combined with --grep or --range');
  return opts;
}

// Preserve one physical line per row, including cells containing tabs/newlines.
const tsv = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

export async function run(argv, { fetchImpl = globalThis.fetch, getToken = getDriveToken, stdout = console.log, stderr = console.error } = {}) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout(USAGE); return 0; }
    const token = await getToken({ scope: SHEETS_SCOPE, impersonate: opts.impersonate });
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${opts.id}`;
    const get = async (url) => {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response.json();
    };
    const metadata = await get(`${base}?fields=sheets.properties`);
    const sheets = (metadata.sheets ?? []).map((s) => s.properties);
    let total = 0;
    const emit = (line) => { total++; if (total <= opts.maxRows) stdout(line); };
    if (opts.tabs) {
      for (const s of sheets) emit(`${tsv(s.title)}\t${s.sheetId}\t${s.gridProperties?.rowCount ?? '?'}×${s.gridProperties?.columnCount ?? '?'}`);
    } else {
      const selected = sheets.filter((s) => (opts.gid === undefined || String(s.sheetId) === opts.gid) && (opts.tab === undefined || s.title === opts.tab));
      if (!selected.length) throw new Error('No matching tab found');
      const prefix = opts.pattern !== undefined || (opts.gid === undefined && opts.tab === undefined);
      for (const sheet of selected) {
        const range = `'${sheet.title.replace(/'/g, "''")}'${opts.range ? `!${opts.range}` : ''}`;
        const data = await get(`${base}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
        const firstRow = Number(opts.range?.match(/^(?:[A-Za-z]+)?(\d+)/)?.[1] ?? 1);
        for (const [index, row] of (data.values ?? []).entries()) {
          if (opts.pattern && !opts.pattern.test(row.join('\t'))) continue;
          const line = row.map(tsv).join('\t');
          emit(prefix ? `${tsv(sheet.title)}\t${firstRow + index}\t${line}` : line);
        }
      }
    }
    if (total > opts.maxRows) stdout(`TRUNCATED: ${total}行中${opts.maxRows}行`);
    return 0;
  } catch (error) {
    stderr(String(error?.message ?? error));
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
