import { getDriveToken } from './tools/lib/drive-auth.mjs';
import { gwsFetch } from './tools/lib/gws-proxy.mjs';
import XLSX from 'xlsx';
import fs from 'fs';

const kanri = XLSX.readFile('C:/Users/USER/AppData/Local/Temp/rebooth-fee/kanri.xlsx');
const dd = XLSX.utils.sheet_to_json(kanri.Sheets['デザイナー様用'], { header: 1, defval: '' });

function parseArea(area) {
  if (!area) return null;
  const s = String(area).replace(/[,]/g, '').trim();
  let m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*㎡/);
  if (m) return parseFloat(m[1]);
  m = s.match(/\/?\s*([0-9]+(?:\.[0-9]+)?)\s*㎡/);
  if (m) return parseFloat(m[1]);
  m = s.match(/([0-9]+)\s*×\s*([0-9]+)/);
  if (m) return (parseInt(m[1])/1000) * (parseInt(m[2])/1000);
  return null;
}
function toNum(v) {
  if (v === undefined || v === null || v === '' || v === 0) return 0;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(/[¥,\s]/g, '')) || 0;
}

const cases = [];
for (let r = 2; r < dd.length; r++) {
  const row = dd[r];
  const name = (row[1] || '').toString().trim();
  if (!name) continue;
  const pn = toNum(row[20]), sn = toNum(row[21]), mn = toNum(row[22]);
  if (pn === 0 && sn === 0 && mn === 0) continue;
  cases.push({
    name: name.replace(/\n/g, ' ').substring(0, 60),
    sqm: parseArea(row[5]),
    pn, sn, mn, total: pn+sn+mn,
    designer: (row[4] || '').toString().trim(),
  });
}

const feeTable = [
  { label: 'SS', sqmMin: 0, sqmMax: 9, desc: '3m×3m以下（トラス不可）', proposal: 15000, execute: 30000 },
  { label: 'S',  sqmMin: 9, sqmMax: 18, desc: '9〜18㎡（2コマ相当）', proposal: 20000, execute: 30000 },
  { label: 'M',  sqmMin: 18, sqmMax: 27, desc: '18〜27㎡（3コマ相当）', proposal: 30000, execute: 30000 },
  { label: 'L',  sqmMin: 27, sqmMax: 36, desc: '27〜36㎡（4コマ相当）', proposal: 30000, execute: 40000 },
];

function calcBySqm(sqm) {
  if (!sqm) return null;
  if (sqm <= 9) return feeTable[0];
  if (sqm <= 18) return feeTable[1];
  if (sqm <= 27) return feeTable[2];
  if (sqm <= 36) return feeTable[3];
  if (sqm <= 54) {
    const extra = Math.ceil((sqm - 36) / 9);
    return { label: 'XL', proposal: 30000 + extra * 8000, execute: 40000 + extra * 4000 };
  }
  const extra = Math.ceil((sqm - 54) / 9);
  return { label: 'XXL', proposal: 46000 + extra * 8000, execute: 48000 + extra * 4000 };
}

const comparisonRows = [];
let sumRecord = 0, sumNew = 0;
cases.forEach(c => {
  const nf = calcBySqm(c.sqm);
  const nt = nf ? nf.proposal + nf.execute : 0;
  sumRecord += c.total;
  sumNew += nt;
  comparisonRows.push({ name: c.name, sqm: c.sqm, recordTotal: c.total, newTotal: nt });
});

const SPREADSHEET_ID = '19HUVuNP3I3hRTsaPCbXKP6VcYi9ojDPgmC7a3r_Jj9g';
const SCOPE = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';

async function main() {
  const token = await getDriveToken({ impersonate: 'seisaku-team@orgiast.jp', scope: SCOPE });
  console.log('Token OK, type:', typeof token, 'len:', token.length);

  const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;

  // 既存シート確認
  const metaRes = await gwsFetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
  const meta = await metaRes.json();
  const existing = meta.sheets.map(s => s.properties.title);
  console.log('Existing sheets:', existing);

  const tab1 = '料金表v2_20261117';
  const tab2 = '新旧比較_20261117';

  if (!existing.includes(tab1)) {
    const res = await gwsFetch(`${BASE}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab1 } } }] })
    });
    const j = await res.json();
    if (!res.ok) throw new Error('addSheet1: ' + JSON.stringify(j));
    console.log('Tab1 added');
  }
  if (!existing.includes(tab2)) {
    const res = await gwsFetch(`${BASE}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab2 } } }] })
    });
    const j = await res.json();
    if (!res.ok) throw new Error('addSheet2: ' + JSON.stringify(j));
    console.log('Tab2 added');
  }

  const tab1Data = [
    ['Reブース デザイナー依頼費 料金表v2（2026-11-17）'],
    ['金額はすべて税別。提案費＝プレゼンまで。受注費＝受注後の実施デザインで提案費に追加。'],
    ['修正回数：提案段階・受注後のそれぞれ5回まで基本料金に含む。6回目以降は1回3,000円。'],
    ['加算オプション以外のブース構造（トラス・LEDUPの配置設計）は基本料金に含む。'],
    [],
    ['【1】基本料金（面積で決める）'],
    ['区分','実面積','目安','提案費','受注費（追加）','受注時の合計','備考'],
    ['SS','0〜9㎡','3m×3m以下（トラス不可）',15000,30000,45000,'小区画減額区分'],
    ['S','9〜18㎡','2コマ相当',20000,30000,50000,''],
    ['M','18〜27㎡','3コマ相当',30000,30000,60000,''],
    ['L','27〜36㎡','4コマ相当',30000,40000,70000,''],
    ['XL','37〜54㎡','9㎡刻み加算',30000,40000,70000,'36㎡基準+9㎡増ごとに提案+8,000/実施+4,000'],
    ['XXL','55㎡以上','9㎡刻み加算',46000,48000,94000,'54㎡基準+9㎡増ごとに提案+8,000/実施+4,000'],
    [],
    ['【2】加算オプション'],
    ['項目','内容','単位','提案費加算','受注費加算','備考'],
    ['LEDUP印刷面のデザイン','LEDUPに入れる印刷面のグラフィック','1面',0,6000,'実績：6,000円/点'],
    ['展示ポスター・チラシのデザイン','ブース内ポスター・チラシ（片面）','1点',0,6000,'実績：6,000円/点'],
    [],
    ['【3】その他加算（現行ルール継承）'],
    ['項目','金額','備考'],
    ['1案追加（提案段階）','10,000円','実績あり（パース3色展開等）'],
    ['継続リサイズ（36㎡以下）','提案15,000＋受注30,000円','実績あり（複数案件）'],
    ['継続リサイズ（37㎡以上）','+20%/9㎡','現行ルール継承'],
    ['お客様との直接やりとり','10,000円','シート2記載。使用実績未確認'],
    ['修正6回目以降','3,000円/回','現行ルール継承'],
    [],
    ['【4】根拠'],
    ['区分SS（〜9㎡）提案15,000円','実績最小6.48㎡案件で15,000+30,000。トラス不要の減額'],
    ['区分S（9〜18㎡）提案20,000円','実績平均20,625円。15,000と30,000の中間'],
    ['区分M（18〜27㎡）提案30,000円','実績全件30,000+30,000'],
    ['区分L（27〜36㎡）提案30,000/実施40,000','実績平均23,571/32,857。36㎡案件は30,000+30,000が実績'],
    ['XL/XXL加算（+8,000/4,000）','シート2案Bの加算率を継承。実績が少ないため要検証'],
  ];

  const tab2Data = [
    ['新旧比較表（2026-11-17）'],
    [],
    ['★料金体系比較'],
    ['項目','前回版','現行ルール(シート2)','新版v2','変更理由'],
    ['36㎡以下 提案費','25,000(L)','20,000','SS:15,000/S:20,000/M:30,000/L:30,000','面積細分化。SSは減額区分'],
    ['36㎡以下 受注費','40,000(L)','40,000','SS:30,000/S:30,000/M:30,000/L:40,000','面積に応じ調整'],
    ['37㎡以上 提案費','35,000〜(XL)','20,000+8,000/9㎡','30,000+8,000/9㎡','基準額を実績に合わせ引上げ'],
    ['37㎡以上 受注費','55,000〜(XL)','40,000+4,000/9㎡','40,000+4,000/9㎡','現行ルール維持'],
    ['修正5回無料','なし','なし','新設','提案・受注各5回まで無料'],
    ['LEDUP印刷面','6,000/面','記載なし','6,000/面','実績維持'],
    ['展示ポスター・チラシ','6,000/点','記載なし','6,000/点','実績維持'],
    ['1案追加','記載なし','10,000','10,000','継承'],
    ['継続リサイズ','記載なし','15,000+30,000','15,000+30,000','継承'],
    ['直接やりとり','記載なし','10,000','10,000','継承'],
    [],
    [],
    ['★案件別比較'],
    ['案件名','面積','記録額','実支払額','新版理論額','差額','備考'],
    ...comparisonRows.map(c => [c.name.substring(0,30), c.sqm||'', c.recordTotal, '', c.newTotal, c.newTotal - c.recordTotal, c.sqm ? '' : '面積未確認']),
    ['合計','',sumRecord,'',sumNew,sumNew-sumRecord,''],
  ];

  // Use POST to batchUpdate instead of PUT to values.update
  // Convert values to batch update request
  async function sheetsPut(range, data) {
    const url = `${BASE}:batchUpdate`;
    const request = {
      requests: [{
        updateCells: {
          range: {
            sheetId: null, // will be resolved by name
            startRowIndex: 0,
            startColumnIndex: 0
          },
          rows: data.map(row => ({
            values: row.map(cell => ({
              userEnteredValue: typeof cell === 'number' ? { numberValue: cell } : { stringValue: String(cell||'') }
            }))
          })),
          fields: 'userEnteredValue'
        }
      }]
    };
    // We need to get sheetId first
    const metaRes2 = await gwsFetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
    const meta2 = await metaRes2.json();
    const sheet = meta2.sheets.find(s => s.properties.title === range.split('!')[0]);
    if (!sheet) throw new Error('Sheet not found: ' + range);
    request.requests[0].updateCells.range.sheetId = sheet.properties.sheetId;

    console.log('POST batchUpdate for', range, 'sheetId:', sheet.properties.sheetId);
    const r = await gwsFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    const j = await r.json();
    if (!r.ok) {
      console.error('Response status:', r.status);
      console.error('Response body:', JSON.stringify(j));
      throw new Error('write failed: ' + (j.error?.message || r.status));
    }
    console.log('Written OK');
    return j;
  }

  await sheetsPut(tab1+'!A1:G'+tab1Data.length, tab1Data);
  await sheetsPut(tab2+'!A1:G'+tab2Data.length, tab2Data);

  // Read back
  const readRes1 = await gwsFetch(`${BASE}/values/${encodeURIComponent(tab1+'!A1:G')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const read1 = await readRes1.json();
  const read1rows = read1.values || [];

  const readRes2 = await gwsFetch(`${BASE}/values/${encodeURIComponent(tab2+'!A1:G')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const read2 = await readRes2.json();
  const read2rows = read2.values || [];

  let m1 = 0;
  for (let r = 0; r < Math.min(tab1Data.length, read1rows.length); r++) {
    for (let c = 0; c < Math.min(tab1Data[r].length, read1rows[r].length); c++) {
      const w = String(tab1Data[r][c]||'');
      const v = String(read1rows[r][c]||'');
      if (w.replace(/\s/g,'') !== v.replace(/\s/g,'')) m1++;
    }
  }
  let m2 = 0;
  for (let r = 0; r < Math.min(tab2Data.length, read2rows.length); r++) {
    for (let c = 0; c < Math.min(tab2Data[r].length, read2rows[r].length); c++) {
      const w = String(tab2Data[r][c]||'');
      const v = String(read2rows[r][c]||'');
      if (w.replace(/\s/g,'') !== v.replace(/\s/g,'')) m2++;
    }
  }
  console.log('Tab1 readback:', read1rows.length, 'rows,', m1, 'mismatches');
  console.log('Tab2 readback:', read2rows.length, 'rows,', m2, 'mismatches');

  // Permissions (best-effort)
  let kimRole = '確認不可（APIエラー）';
  try {
    const permRes = await gwsFetch(`https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}/permissions`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const perm = await permRes.json();
    const kimP = (perm.permissions||[]).find(p => p.emailAddress === 'kim@orgiast.jp');
    kimRole = kimP ? kimP.role : 'なし';
  } catch (e) {
    kimRole = '確認不可（' + e.message.substring(0, 40) + '）';
  }
  console.log('kim@ permission:', kimRole);

  // result.md
  const lines = [];
  lines.push('# Reブース デザイナー依頼費 料金表 刷新結果');
  lines.push('');
  lines.push('## 読んだタブ一覧と各行数');
  lines.push('- デザイナー様用: 993行（うち金額データ行33件）');
  lines.push('- ディレクター様用: 991行');
  lines.push('- シート2: 18行');
  lines.push('');
  lines.push('## シート2の実記載ルールと想定との差異');
  lines.push('シート2には2つの料金案が併記。想定は案Bに近い。');
  lines.push('- 案A（営業中/col[4]）: 36㎡以下 提案30,000 / 37㎡以上 +6,000/9㎡ / 修正10,000/回 / 受注後30,000');
  lines.push('- 案B（受注/col[7]）: 36㎡以下 提案20,000 / 37㎡以上 +8,000/9㎡ / 修正10,000/回 / 受注後40,000+4,000/9㎡');
  lines.push('- 継続リサイズ（col[10]）: 36㎡以下 提案15,000+受注30,000 / 37㎡以上 +20%/9㎡');
  lines.push('- 直接やりとり: 10,000円');
  lines.push('');
  lines.push('## 新料金表の要約表');
  lines.push('|区分|実面積|提案費|受注費（追加）|');
  lines.push('|---|---|---|---|');
  lines.push('|SS|0〜9㎡|15,000|30,000|');
  lines.push('|S|9〜18㎡|20,000|30,000|');
  lines.push('|M|18〜27㎡|30,000|30,000|');
  lines.push('|L|27〜36㎡|30,000|40,000|');
  lines.push('|XL|37〜54㎡|30,000+8,000/9㎡|40,000+4,000/9㎡|');
  lines.push('|XXL|55㎡〜|46,000+8,000/9㎡|48,000+4,000/9㎡|');
  lines.push('|修正|各5回無料→6回目以降3,000/回');
  lines.push('|LEDUP印刷面|6,000/面|');
  lines.push('|ポスター・チラシ|6,000/点|');
  lines.push('');
  lines.push('## 新旧比較の主要差分');
  lines.push('1. 面積区分をSS/S/M/L/XL/XXLの6段階に細分化');
  lines.push('2. SS区分（〜9㎡=トラス不可）を新設し減額（提案15,000）');
  lines.push('3. 修正5回まで無料を新設（提案・受注各5回）');
  lines.push('4. 加算オプションを2項目に限定し、トラス・LEDUP配置設計は基本料金に含むことを明記');
  lines.push('5. XL/XXLの加算率はシート2案B（+8,000/+4,000/9㎡）を継承');
  lines.push('');
  lines.push('## 金額集計');
  lines.push('- 全' + cases.length + '件の記録額合計: ¥' + sumRecord.toLocaleString());
  lines.push('- 実支払額合計: 未照会（添付ファイルからの金額抽出が困難なため）');
  lines.push('- 新版理論額合計: ¥' + sumNew.toLocaleString());
  lines.push('- 差額（新版-記録）: ¥' + (sumNew-sumRecord).toLocaleString());
  lines.push('');
  lines.push('## 追加したタブ');
  lines.push('- ' + tab1 + ': ' + tab1Data.length + '行, 読戻' + read1rows.length + '行, 不一致' + m1 + 'セル');
  lines.push('- ' + tab2 + ': ' + tab2Data.length + '行, 読戻' + read2rows.length + '行, 不一致' + m2 + 'セル');
  lines.push('');
  lines.push('## kim@orgiast.jp の権限: ' + kimRole);
  lines.push('');
  lines.push('## 支払記録照会結果');
  lines.push('gmail-search.mjs で seisaku-team@ の受信トレイから山田さおり関連の請求書メールを検索。');
  lines.push('山田沙織（合同会社Rデザイン）からの毎月の請求書メールを確認。');
  lines.push('ただし添付ファイル（PDF/画像）に金額が記載されているため、テキスト抽出による金額取得は未実施。');
  lines.push('→ 支払記録: 添付ファイルの金額抽出が困難なため未照会');
  lines.push('');
  lines.push('## 要決定事項');
  lines.push('1. SS区分（〜9㎡）の提案費15,000円 — トラス不可の小区画として妥当か');
  lines.push('2. L区分（27〜36㎡）の提案費30,000円 — 実績平均23,571円。25,000円も選択肢');
  lines.push('3. 修正5回無料の導入 — 実績での修正回数実態が未確認');
  lines.push('4. XL/XXLの加算刻み幅 — 実績が少ないため検証不足');
  lines.push('5. 1案追加・継続リサイズの統合 or 別建て');
  lines.push('6. 直接やりとり加算10,000円 — 使用実績未確認');

  const result = lines.join('\n');
  fs.writeFileSync('C:/Users/USER/AppData/Local/Temp/rebooth-fee/result.md', result, 'utf8');
  console.log('\n' + result);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });