// 学会タスク進捗管理表 task タブに2行挿入
import fs from 'node:fs';
import crypto from 'node:crypto';

const SS = '1reLACNGD1K7U58heIBVH-YWC9CWErGHSfOy4unfgOYs';
const KEY = JSON.parse(fs.readFileSync(process.env.USERPROFILE + '/.claude/keys/aujust-sheets-reader.json', 'utf8'));

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: KEY.client_email, sub: 'kim@orgiast.jp', scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(head + '.' + claim);
  const jwt = head + '.' + claim + '.' + b64url(sign.sign(KEY.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const json = await res.json();
  if (!res.ok) throw new Error('token ' + res.status + ' ' + JSON.stringify(json));
  return json.access_token;
}

const t = await token();
const SHEET_ID = 1125846536;  // task タブ
const PHONE_URL = 'https://docs.google.com/spreadsheets/d/1jAOwP41YeF09ftdhCp5RdCcnNW305ewu053HVk7VGBM/edit#gid=574752432';
const HYPERLINK_FMT = `=HYPERLINK("${PHONE_URL}","リンクW")`;

// 下の行から先に処理: 撤収時対応(304行目)の下 → 報酬金額通知(296行目)の下
// 0-indexed: 撤収時対応=index 303, 報酬金額通知=index 295
const requests = [
  // Step 1: insert at 304 (0-indexed), after 【翌日】アイテムの撤収時対応
  {
    insertDimension: {
      range: { sheetId: SHEET_ID, dimension: 'ROWS', startIndex: 304, endIndex: 305 },
      inheritFromBefore: true,
    },
  },
  // Step 2: insert at 296 (0-indexed), after 【設営日】ブース運営スタッフに報酬金額を通知
  {
    insertDimension: {
      range: { sheetId: SHEET_ID, dimension: 'ROWS', startIndex: 296, endIndex: 297 },
      inheritFromBefore: true,
    },
  },
];

// Write data to the new rows
// After insert: index 296 = new row (after 報酬金額通知), index 305 = new row (after 撤収時対応)
const rowA = {
  startRowIndex: 296, endRowIndex: 297,
  startColumnIndex: 0, endColumnIndex: 8,
  rows: [{
    values: [
      // A
      { userEnteredValue: { stringValue: 'ﾌﾞｰｽ/学会' } },
      // B (空)
      {},
      // C
      { userEnteredValue: { stringValue: '備品手配' } },
      // D
      { userEnteredValue: { stringValue: '【設営日】学会セットのスマホ番号（S00x）と電源の確認・写真報告' } },
      // E (空)
      {},
      // F
      { userEnteredValue: { numberValue: 100 } },
      // G
      { userEnteredValue: { formulaValue: HYPERLINK_FMT } },
      // H
      { userEnteredValue: { stringValue: 'スマホの番号シールと点いた画面を1枚撮り当日チャンネルへ「スマホ S00x 電源◯ 電池◯%」。管理表の在庫場所（例 S003=学A②）と違う・入っていない時は学会制作チャンネルで即報告。撤去時も箱に戻す前に番号写真を送る。' } },
    ],
  }],
};

const rowB = {
  startRowIndex: 305, endRowIndex: 306,
  startColumnIndex: 0, endColumnIndex: 8,
  rows: [{
    values: [
      { userEnteredValue: { stringValue: 'ﾌﾞｰｽ/学会' } },
      {},
      { userEnteredValue: { stringValue: '備品手配' } },
      { userEnteredValue: { stringValue: '【戻り翌日】倉庫の戻り報告でスマホ番号（S00x）を照合する' } },
      {},
      { userEnteredValue: { numberValue: 100 } },
      { userEnteredValue: { formulaValue: HYPERLINK_FMT } },
      { userEnteredValue: { stringValue: '戻り報告に「スマホ：S00x」があり在庫場所と一致するか確認。無い・違う時はその日に倉庫へ確認し、無ければ翌日に最後の会場・運送会社・お客様へ忘れ物の問い合わせ。' } },
    ],
  }],
};

function updateRequest(row) {
  return {
    updateCells: {
      range: {
        sheetId: SHEET_ID,
        startRowIndex: row.startRowIndex, endRowIndex: row.endRowIndex,
        startColumnIndex: row.startColumnIndex, endColumnIndex: row.endColumnIndex,
      },
      rows: row.rows,
      fields: 'userEnteredValue',
    },
  };
}
requests.push(updateRequest(rowA), updateRequest(rowB));

const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SS}:batchUpdate`, {
  method: 'POST',
  headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' },
  body: JSON.stringify({ requests }),
});
const result = await res.json();
if (!res.ok) {
  console.error('ERROR:', res.status, JSON.stringify(result));
  process.exit(1);
}
console.log('OK: batchUpdate 成功');
console.log(JSON.stringify(result, null, 2).slice(0, 500));

// 読み戻し
console.log('\n=== 読み戻し: rows 294〜308 ===');
const readRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SS}/values/task!A294:H310?valueRenderOption=FORMATTED_VALUE`, { headers: { authorization: 'Bearer ' + t } });
const readBody = await readRes.json();
if (!readRes.ok) throw new Error(JSON.stringify(readBody));
(readBody.values || []).forEach((r, i) => {
  const rowNum = 294 + i;
  const d = (r[3] || '').slice(0, 50);
  console.log(rowNum + ' A=' + (r[0]||'') + ' C=' + (r[2]||'') + ' D=' + d + ' F=' + (r[5]||'') + ' G=' + (r[6]||'').slice(0,30));
});