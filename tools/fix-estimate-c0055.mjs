#!/usr/bin/env node
// fix-estimate-c0055.mjs — Apply c0055-estimate-3stage-patch fixes to xlsx
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync, deflateRawSync } from 'node:zlib';

const XLSX_PATH = '/tmp/estimate.xlsx';
const OUTPUT_PATH = '/tmp/estimate-fixed.xlsx';
const SPREADSHEET_ID = '1sWjVnX7amm5rgg9J_n_rsThiCZYile4aS1xfHayU0lk';

console.log('=== C0055 Estimate Fix ===\n');

// --- ZIP helpers ---
function findEOCD(buf) {
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}
function readCD(buf) {
  const eocd = findEOCD(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    entries.push({
      name: buf.subarray(offset + 46, offset + 46 + buf.readUInt16LE(offset + 28)).toString(),
      compSize: buf.readUInt32LE(offset + 20),
      uncompSize: buf.readUInt32LE(offset + 24),
      localOffset: buf.readUInt32LE(offset + 42),
      method: buf.readUInt16LE(offset + 10),
      extraLen: buf.readUInt16LE(offset + 30),
      commLen: buf.readUInt16LE(offset + 32),
      crc32: buf.readUInt32LE(offset + 16),
    });
    offset += 46 + buf.readUInt16LE(offset + 28) + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  return { entries, eocd, count };
}

function extractEntry(buf, entry) {
  const local = entry.localOffset;
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  return entry.method === 0 ? data : inflateRawSync(data);
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildLocalHeader(name, compSize, uncompSize, method, crc) {
  const nameBuf = Buffer.from(name, 'utf8');
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(20, 4);       // version needed
  buf.writeUInt16LE(0, 6);        // flags
  buf.writeUInt16LE(method, 8);
  buf.writeUInt16LE(0, 10);       // mod time
  buf.writeUInt16LE(0, 12);       // mod date
  buf.writeUInt32LE(crc, 14);
  buf.writeUInt32LE(compSize, 18);
  buf.writeUInt32LE(uncompSize, 22);
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28);       // extra field length
  nameBuf.copy(buf, 30);
  return buf;
}

function buildCDEntry(name, compSize, uncompSize, method, crc, localOffset) {
  const nameBuf = Buffer.from(name, 'utf8');
  const buf = Buffer.alloc(46 + nameBuf.length);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE(20, 4);   // version made by
  buf.writeUInt16LE(20, 6);   // version needed
  buf.writeUInt16LE(0, 8);    // flags
  buf.writeUInt16LE(method, 10);
  buf.writeUInt16LE(0, 12);   // mod time
  buf.writeUInt16LE(0, 14);   // mod date
  buf.writeUInt32LE(crc, 16);
  buf.writeUInt32LE(compSize, 20);
  buf.writeUInt32LE(uncompSize, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  buf.writeUInt16LE(0, 30);   // extra field length
  buf.writeUInt16LE(0, 32);   // comment length
  buf.writeUInt16LE(0, 34);   // disk start
  buf.writeUInt16LE(0, 36);   // internal attrs
  buf.writeUInt32LE(0, 38);   // external attrs
  buf.writeUInt32LE(localOffset, 42);
  nameBuf.copy(buf, 46);
  return buf;
}

// --- Main ---
const buffer = readFileSync(XLSX_PATH);
const { entries, eocd, count } = readCD(buffer);
console.log(`Read ${count} entries from xlsx\n`);

// Read and modify entries
const modifiedEntries = [];

for (const entry of entries) {
  let content = extractEntry(buffer, entry);
  let modified = false;

  if (entry.name === 'xl/sharedStrings.xml') {
    // Fix shared strings: SI[40] and SI[142]
    let xml = content.toString('utf8');
    const sis = [...xml.matchAll(/<si>.*?<\/si>/gs)];

    // SI[40]: 270501CYL → 270528FAB
    const s40 = sis[40][0];
    xml = xml.replace(s40, s40.replace('270501CYL', '270528FAB'));

    // SI[142]: 折口様 → お問い合わせ
    const s142 = sis[142][0];
    xml = xml.replace(s142, s142.replace('折口様', 'お問い合わせ'));

    content = Buffer.from(xml, 'utf8');
    modified = true;
    console.log('[FIXED] sharedStrings: SI[40] 270501CYL→270528FAB, SI[142] 折口様→お問い合わせ');
  }
  else if (entry.name === 'xl/worksheets/sheet2.xml') {
    // 管理画面: Remove rows 48-49 (debris), hide sheets ６×３
    let xml = content.toString('utf8');
    const beforeCount = (xml.match(/<row /g) || []).length;

    // Remove rows 48, 49
    xml = xml.replace(/<row r="49"[^>]*>[\s\S]*?<\/row>\r?\n?/s, '');
    xml = xml.replace(/<row r="48"[^>]*>[\s\S]*?<\/row>\r?\n?/s, '');

    content = Buffer.from(xml, 'utf8');
    modified = true;
    console.log(`[FIXED] 管理画面: removed rows 48-49 (${beforeCount}→${(xml.match(/<row /g) || []).length} rows)`);
  }
  else if (entry.name === 'xl/worksheets/sheet10.xml') {
    // 見積: Fix L1 (estimate number) and N2 (date)
    let xml = content.toString('utf8');

    // L1: 220803001 → 261104001 (serial 2.20803001E8 → 2.61104001E8)
    xml = xml.replace(/(<c r="L1"[^>]*>)<v>[^<]*<\/v>(<\/c>)/, '$1<v>2.61104001E8</v>$2');
    console.log('[FIXED] 見積 L1: 220803001→261104001');

    // N2: 45542.0 (2024-09-07) → 46334.0 (2026-11-04)
    xml = xml.replace(/(<c r="N2"[^>]*>)<v>[^<]*<\/v>(<\/c>)/, '$1<v>46334.0</v>$2');
    console.log('[FIXED] 見積 N2: 2024-09-07→2026-11-04');

    content = Buffer.from(xml, 'utf8');
    modified = true;
  }
  else if (entry.name === 'xl/workbook.xml') {
    // Hide sheets: ６×３　初回 (sheetId=3), ６×３　２回目 (sheetId=4)
    let xml = content.toString('utf8');
    xml = xml.replace(/<sheet[^>]*name="６×３　初回"[^>]*\/?>/, m => m.includes('hidden') ? m : m.replace('visible', 'hidden').replace(/state="[^"]*"/, 'state="hidden"'));
    xml = xml.replace(/<sheet[^>]*name="６×３　２回目"[^>]*\/?>/, m => m.includes('hidden') ? m : m.replace('visible', 'hidden').replace(/state="[^"]*"/, 'state="hidden"'));
    // If no state attribute, add one
    if (!xml.includes('state="hidden"')) {
      xml = xml.replace(/<sheet\s/, '<sheet state="hidden" ');
    }
    content = Buffer.from(xml, 'utf8');
    modified = true;
    console.log('[FIXED] workbook: hid ６×３ sheets');
  }

  if (modified) {
    const crc = crc32(content);
    const compressed = content.length > 100 ? deflateRawSync(content, { level: 6 }) : content;
    const useDeflate = compressed.length < content.length;
    modifiedEntries.push({
      name: entry.name,
      data: useDeflate ? compressed : content,
      method: useDeflate ? 8 : 0,
      crc,
      uncompSize: content.length,
    });
  } else {
    // Keep original entry data
    modifiedEntries.push({ name: entry.name, data: null, method: entry.method, crc: entry.crc32, uncompSize: entry.uncompSize });
  }
}

// --- Rebuild ZIP ---
console.log('\n--- Rebuilding xlsx ---');
const localHeaders = [];
const fileData = [];
let localOffset = 0;

// We need to rebuild only modified entries, but the unchanged ones can be kept as-is
// For simplicity, rebuild all entries

const newEntries = [];
let currentOffset = 0;

// Read all original entries (or use modified data)
for (const me of modifiedEntries) {
  if (me.data) {
    // Modified - rebuild local header
    const lh = buildLocalHeader(me.name, me.data.length, me.uncompSize, me.method, me.crc);
    const entryBuf = Buffer.concat([lh, me.data]);
    newEntries.push({ name: me.name, buf: entryBuf, localOffset: currentOffset, compSize: me.data.length, uncompSize: me.uncompSize, method: me.method, crc: me.crc });
    currentOffset += entryBuf.length;
  } else {
    // Unmodified - keep original entry by copying its local header + data from original
    const origEntry = entries.find(e => e.name === me.name);
    const local = origEntry.localOffset;
    const nameLen = buffer.readUInt16LE(local + 26);
    const extraLen = buffer.readUInt16LE(local + 28);
    const lhEnd = local + 30 + nameLen + extraLen;
    const entryLen = lhEnd - local + origEntry.compSize;
    const entryBuf = buffer.subarray(local, local + entryLen);
    newEntries.push({ name: me.name, buf: entryBuf, localOffset: currentOffset, compSize: origEntry.compSize, uncompSize: origEntry.uncompSize, method: origEntry.method, crc: origEntry.crc32 });
    currentOffset += entryBuf.length;
  }
}

// Build new ZIP
const chunks = [];
for (const ne of newEntries) {
  chunks.push(ne.buf);
}

const cdEntries = [];
for (const ne of newEntries) {
  const cd = buildCDEntry(ne.name, ne.compSize, ne.uncompSize, ne.method, ne.crc, ne.localOffset);
  cdEntries.push(cd);
  chunks.push(cd);
}

// EOCD
const cdOffset = currentOffset;
const cdSize = cdEntries.reduce((s, e) => s + e.length, 0);
const eocdBuf = Buffer.alloc(22);
eocdBuf.writeUInt32LE(0x06054b50, 0);
eocdBuf.writeUInt16LE(0, 4);     // disk number
eocdBuf.writeUInt16LE(0, 6);     // disk with CD
eocdBuf.writeUInt16LE(newEntries.length, 8);  // total entries on disk
eocdBuf.writeUInt16LE(newEntries.length, 10); // total entries
eocdBuf.writeUInt32LE(cdSize, 12);
eocdBuf.writeUInt32LE(cdOffset, 16);
eocdBuf.writeUInt16LE(0, 20);    // comment length
chunks.push(eocdBuf);

const output = Buffer.concat(chunks);
writeFileSync(OUTPUT_PATH, output);
console.log(`\nWritten: ${OUTPUT_PATH} (${output.length} bytes)`);
console.log('Done.');