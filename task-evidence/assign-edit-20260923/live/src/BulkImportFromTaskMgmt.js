/**
 * 既存タスク管理表「正式：reブースタスク進捗管理表」(SS 1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI / sheet "task")
 * からアクティブ案件 21 件を 案件一覧 へ一括取り込み。
 *
 * 元シート構造（wide format）:
 *   - 1 案件 = 3 列ブロック（名前 / 日付 / 進捗）
 *   - ブロック先頭列 = M(13), P(16), S(19), V(22), ... 3 列刻みで横並び
 *   - 行 6: ｸﾗｲｱﾝﾄ
 *   - 行 7: 展示会名
 *   - 行 8: 地域/会場
 *   - 行 9: 設営日
 *   - 行 10: 開催日程
 *   - 行 11: 実計/見積（HYPERLINK の display: "実施計画書（...）" / formula: =HYPERLINK(url, label)）
 *   - 行 13: 担当（"制作P：xxx" 等）
 *
 * 仕様:
 *   - HYPERLINK formula から実施計画書 URL を抽出
 *   - URL が空（"実施計画書URL" 等の placeholder）の案件は skip して結果に skipped 配列で報告
 *   - 重複（既に zissiId が案件一覧 K列にあるもの）は skip
 */

const _BULK_IMPORT_SS_ID = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
const _BULK_IMPORT_SHEET = 'task';
const _BULK_IMPORT_FIRST_COL = 13; // M
const _BULK_IMPORT_LAST_COL = 75;  // 21 case blocks (13 + 3*20 = 73 for last name col, +2 for date+progress = 75)
const _BULK_IMPORT_ROW_CLIENT = 5;
const _BULK_IMPORT_ROW_EVENT = 6;
const _BULK_IMPORT_ROW_VENUE = 7;
const _BULK_IMPORT_ROW_SETUP = 8;
const _BULK_IMPORT_ROW_PERIOD = 9;
const _BULK_IMPORT_ROW_ZISSI = 10;  // 実計/見積 行（A1 ベースで 11 行目 = row 10 0-indexed... wait）

// 注意: スプレッドシート読みは 1-indexed 行 = ヘッダー1行目 を 1 とカウント
//       上のサブエージェント分析では「行5=クライアント, 行11=実計/見積, 行13=担当」
//       これは 1-indexed 表記。GAS API も 1-indexed なのでそのまま使う。

// 実際のレイアウト (1-indexed):
// row 1: クライアント, row 2: 展示会名, row 3: 地域/会場, row 4: 設営日,
// row 5: 開催日程, row 6: 実計/見積 (cell hyperlink), row 7: 展示会HP,
// row 8: 担当, row 9: 次MTG, row 10: 前回済タスク数, row 11: 残タスク/済/不要
const _BULK_IMPORT_R_CLIENT = 1;
const _BULK_IMPORT_R_EVENT = 2;
const _BULK_IMPORT_R_VENUE = 3;
const _BULK_IMPORT_R_SETUP = 4;
const _BULK_IMPORT_R_PERIOD = 5;
const _BULK_IMPORT_R_ZISSI = 6;
const _BULK_IMPORT_R_OWNER = 8;

/**
 * 一括取り込み実行。
 * @return {object} { totalBlocks, imported, duplicates, skipped, errors, summary }
 */
function BulkImportFromTaskMgmt_run(opts) {
  opts = opts || {};
  const ss = SpreadsheetApp.openById(_BULK_IMPORT_SS_ID);
  const sheet = ss.getSheetByName(_BULK_IMPORT_SHEET);
  if (!sheet) throw new Error('sheet not found: ' + _BULK_IMPORT_SHEET);

  // 各案件の名前列 = 13, 16, 19, ... シートの最終列まで動的に検出
  // (2026-08-01: 22案件目以降がシート右側に追加されるようになったため 21 固定を廃止)
  const sheetLastCol = sheet.getLastColumn();
  const blocks = [];
  for (let col = 13; col + 2 <= sheetLastCol; col += 3) {
    blocks.push(col);
  }
  const lastCol = blocks[blocks.length - 1];

  // 一括 read（値）+ 行 6（実計/見積）は richTextValue / formula 両方確認
  const valuesRange = sheet.getRange(_BULK_IMPORT_R_CLIENT, 1, _BULK_IMPORT_R_OWNER - _BULK_IMPORT_R_CLIENT + 1, lastCol);
  const values = valuesRange.getValues();
  const zissiRange = sheet.getRange(_BULK_IMPORT_R_ZISSI, 1, 1, lastCol);
  const zissiFormulasRow = zissiRange.getFormulas()[0];
  const zissiRichTextRow = zissiRange.getRichTextValues()[0];

  const imported = [];
  const duplicates = [];
  const skipped = [];
  const errors = [];

  // values は 9 行（行5〜13）。idx で参照する: 0=行5, 1=行6, ...
  function row(r) { return values[r - _BULK_IMPORT_R_CLIENT]; }

  blocks.forEach(function (col1) {
    // col1 は 1-indexed の名前列番号。Sheets配列は 0-indexed なので col1-1
    const c = col1 - 1;
    const clientName = String((row(_BULK_IMPORT_R_CLIENT)[c] || '')).trim();
    const eventName = String((row(_BULK_IMPORT_R_EVENT)[c] || '')).trim();
    const venue = String((row(_BULK_IMPORT_R_VENUE)[c] || '')).trim();
    const setupDate = row(_BULK_IMPORT_R_SETUP)[c];
    const periodCell = String((row(_BULK_IMPORT_R_PERIOD)[c] || '')).trim();
    const ownerCell = String((row(_BULK_IMPORT_R_OWNER)[c] || '')).trim();
    const zissiFormula = String(zissiFormulasRow[c] || '');
    const zissiRich = zissiRichTextRow[c];

    // クライアント名 or 展示会名 が空のブロックは skip
    if (!clientName && !eventName) {
      skipped.push({ col: col1, reason: 'empty block' });
      return;
    }

    // URL 抽出: (1) HYPERLINK formula, (2) cell hyperlink (richTextValue.getLinkUrl),
    //          (2b) セル文字列内の plain URL (https://docs.google.com/spreadsheets/d/...)
    //          (3) フォールバック: タイトル文字列から案件コード抽出 → Drive 検索
    let zissiUrl = '';
    const fm = zissiFormula.match(/HYPERLINK\(\s*["']([^"']+)["']/i);
    if (fm) {
      zissiUrl = fm[1];
    } else if (zissiRich) {
      const linkUrl = zissiRich.getLinkUrl();
      if (linkUrl) {
        zissiUrl = linkUrl;
      } else {
        const runs = zissiRich.getRuns();
        for (let k = 0; k < runs.length; k++) {
          const u = runs[k].getLinkUrl();
          if (u) { zissiUrl = u; break; }
        }
      }
    }
    // (2b) セル文字列内の plain URL を拾う（HYPERLINK 化されてないが URL が含まれている場合）
    const cellTextForUrl = String(zissiRich ? zissiRich.getText() : '') ||
      String(sheet.getRange(_BULK_IMPORT_R_ZISSI, col1).getValue() || '');
    if (!zissiUrl) {
      const urlMatch = cellTextForUrl.match(/https?:\/\/docs\.google\.com\/(?:a\/[^/]+\/)?spreadsheets\/d\/[A-Za-z0-9_-]+[^\s)]*/);
      if (urlMatch) zissiUrl = urlMatch[0];
    }

    // (2c) 案件一覧マスター (14RC6...) の D列を参照
    //      master text 内のコード (例: 251103PDR) を 案件一覧マスター I列 で完全一致検索
    //      → 一致したら同じ行の D列 (実施計画URL) を採用
    //      コード一致が無く clientName で 1 件に絞れたら採用
    if (!zissiUrl) {
      const codeMatch = cellTextForUrl.match(/[（(](\d{6}[A-Z]{2,5})[_\s]/);
      const codeFromText = codeMatch ? codeMatch[1] : '';
      const url = _Bulk_lookupKessanMaster(codeFromText, clientName);
      if (url) zissiUrl = url;
    }
    // (3) タイトル文字列から案件コード (例: 260408TRS) を抽出 → Drive で検索
    if (!zissiUrl) {
      const cellText = String(zissiRich ? zissiRich.getText() : '') ||
        String(sheet.getRange(_BULK_IMPORT_R_ZISSI, col1).getValue() || '');
      const codeMatch = cellText.match(/[（(](\d{6}[A-Z]{2,5})[_\s]/);
      if (codeMatch) {
        const code = codeMatch[1];
        try {
          const it = DriveApp.searchFiles(
            "title contains '" + code + "' and title contains '実施計画書' and " +
            "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false"
          );
          while (it.hasNext()) {
            const f = it.next();
            if (f.getName().indexOf('提出') >= 0) continue;
            zissiUrl = f.getUrl();
            break;
          }
        } catch (e) { /* skip */ }
      }
    }

    // (4) クライアント名 + イベント名キーワード で Drive 検索（eventKey 必須）
    //     master の zissi コードが古い/不一致でも、ファイル名でマッチさせる
    //     ※ clientName だけ一致のファイルは別案件の可能性が高いので採用しない
    if (!zissiUrl && clientName) {
      const clientKey = clientName.replace(/^株式会社|株式会社$|^（株）|（株）$/g, '').trim();
      // eventName から最初の意味のあるキーワードを抽出（記号/年号/共通語を除外）
      const eventKeys = _Bulk_extractEventKeywords(eventName);
      if (clientKey && eventKeys.length > 0) {
        try {
          const escClient = clientKey.replace(/'/g, '\\\'');
          const q = "title contains '実施計画書' and title contains '" + escClient +
            "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
          const it = DriveApp.searchFiles(q);
          const matches = [];
          while (it.hasNext()) {
            const f = it.next();
            const name = f.getName();
            if (name.indexOf('コピー') >= 0) continue;
            if (name.indexOf('提出') >= 0) continue;
            if (/(テスト|サンプル|テンプレート|template)/i.test(name)) continue;
            // eventKeys のいずれかが含まれるファイルだけ採用
            const hit = eventKeys.some(function (k) { return name.indexOf(k) >= 0; });
            if (!hit) continue;
            matches.push({ file: f, modifiedTime: f.getLastUpdated().getTime() });
          }
          if (matches.length > 0) {
            matches.sort(function (a, b) { return b.modifiedTime - a.modifiedTime; });
            zissiUrl = matches[0].file.getUrl();
          }
        } catch (e) { /* skip */ }
      }
    }

    if (!zissiUrl) {
      skipped.push({
        col: col1,
        clientName: clientName,
        eventName: eventName,
        reason: '実施計画書 URL なし（行11 が HYPERLINK でない）'
      });
      return;
    }

    // 開催期間パース: "2025年10月20日〜22日" → start=2025/10/20, end=2025/10/22
    const period = _Bulk_parsePeriod(periodCell);
    const startDate = period.start || (setupDate instanceof Date ? Utilities.formatDate(setupDate, 'Asia/Tokyo', 'yyyy/MM/dd') : '');
    const endDate = period.end || '';

    const caseName = eventName + (venue ? ' / ' + venue : '');

    // masterCol-based 重複チェック: 同じ (masterSsId, masterCol) で既存ケースがあれば skip
    //   - kessan lookup などで zissi URL が以前の取込時と変わっても、case を二重作成しないため
    const existingByMasterCol = _Bulk_findCaseByMasterCol(_BULK_IMPORT_SS_ID, col1);
    if (existingByMasterCol) {
      duplicates.push({ col: col1, clientName, eventName, existingCaseId: existingByMasterCol.caseId, reason: 'same masterCol' });
      return;
    }

    try {
      const result = CaseList_importFromZissiUrl(zissiUrl, {
        clientName: clientName,
        caseName: caseName,
        startDate: startDate,
        endDate: endDate,
        phase: 2,
        masterSsId: _BULK_IMPORT_SS_ID,
        masterCol: col1
      });
      if (result.duplicate) {
        duplicates.push({ col: col1, clientName, eventName, existingCaseId: result.caseId });
      } else {
        imported.push({ col: col1, caseId: result.caseId, clientName, eventName, startDate, endDate, zissiUrl });
      }
    } catch (e) {
      errors.push({ col: col1, clientName, eventName, error: e.message });
    }
  });

  return {
    totalBlocks: blocks.length,
    imported: imported,
    duplicates: duplicates,
    skipped: skipped,
    errors: errors,
    summary: {
      importedCount: imported.length,
      duplicateCount: duplicates.length,
      skippedCount: skipped.length,
      errorCount: errors.length
    }
  };
}

/**
 * 毎日 深夜 3:00 (JST) に bulk import を自動実行する time-based trigger を登録。
 * 既存トリガーがあれば削除してから再作成（時刻変更にも対応）。
 */
function BulkImportFromTaskMgmt_setupDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'BulkImportFromTaskMgmt_run') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  ScriptApp.newTrigger('BulkImportFromTaskMgmt_run')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
  return { removedOld: removed, created: true, hourJst: 3 };
}

/**
 * 案件一覧シートから (masterSsId, masterCol) で既存ケースを検索
 */
function _Bulk_findCaseByMasterCol(masterSsId, masterCol) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  // M列(13) = masterSsId, N列(14) = masterCol
  const data = sheet.getRange(2, 1, lastRow - 1, 14).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][12]) === String(masterSsId) && Number(data[i][13]) === Number(masterCol)) {
      return { caseId: String(data[i][0]), rowIndex: i + 2 };
    }
  }
  return null;
}

// 案件一覧マスター (kessan master) の参照定数とキャッシュ
const _KESSAN_MASTER_SS_ID = '14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY';
const _KESSAN_MASTER_GID = 849096576;
const _KESSAN_COL_CLIENT = 3;   // C列: 顧客名
const _KESSAN_COL_ZISSI_URL = 4; // D列: 実施計画URL
const _KESSAN_COL_CODE = 9;     // I列: ｺｰﾄﾞ
let _kessanIndexCache = null;

function _Bulk_buildKessanIndex() {
  if (_kessanIndexCache) return _kessanIndexCache;
  const ss = SpreadsheetApp.openById(_KESSAN_MASTER_SS_ID);
  const sheets = ss.getSheets();
  let sheet = null;
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === _KESSAN_MASTER_GID) { sheet = sheets[i]; break; }
  }
  if (!sheet) sheet = sheets[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { _kessanIndexCache = { byCode: {}, byClient: {} }; return _kessanIndexCache; }
  const values = sheet.getRange(2, 1, lastRow - 1, Math.max(_KESSAN_COL_CODE, _KESSAN_COL_ZISSI_URL)).getValues();
  const byCode = {};
  const byClient = {};
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const client = String(row[_KESSAN_COL_CLIENT - 1] || '').trim().replace(/[\r\n]+/g, '');
    const url = String(row[_KESSAN_COL_ZISSI_URL - 1] || '').trim();
    const code = String(row[_KESSAN_COL_CODE - 1] || '').trim().replace(/_\d+$/, ''); // 末尾 _2 等を剥がす
    if (!url || url.indexOf('docs.google.com/spreadsheets/') < 0) continue;
    if (code && !byCode[code]) byCode[code] = url;
    if (client) {
      if (!byClient[client]) byClient[client] = [];
      byClient[client].push({ url: url, code: code });
    }
  }
  _kessanIndexCache = { byCode: byCode, byClient: byClient };
  return _kessanIndexCache;
}

/**
 * 案件一覧シート上で「既に登録済みの zissiId」セットを返す
 * （同一クライアントで複数候補があるとき、別ケースに紐付き済みの URL を除外するため）
 */
function _Bulk_getExistingZissiIdSet() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  const set = {};
  if (!sheet) return set;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return set;
  const data = sheet.getRange(2, 11, lastRow - 1, 1).getValues(); // K列 = zissiId
  for (let i = 0; i < data.length; i++) {
    const id = String(data[i][0] || '').trim();
    if (id) set[id] = true;
  }
  return set;
}

function _Bulk_extractSheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * 案件一覧マスター から zissiUrl を引く。
 * 1) コード完全一致を最優先
 * 2) コード一致が無い場合、clientName で集約した URL を取得し、
 *    すでに別ケースに紐付き済みのものを除外 → 残り 1 件なら採用
 * 3) それでも絞れない場合は元の動作（uniq.length === 1）を維持
 */
function _Bulk_lookupKessanMaster(code, clientName) {
  try {
    const idx = _Bulk_buildKessanIndex();
    if (code && idx.byCode[code]) return idx.byCode[code];
    if (!clientName) return '';
    const clientKey = clientName.replace(/^株式会社|株式会社$|^（株）|（株）$|[\r\n\s]/g, '').trim();
    if (!clientKey) return '';
    const collected = [];
    Object.keys(idx.byClient).forEach(function (k) {
      const nk = k.replace(/^株式会社|株式会社$|^（株）|（株）$|[\r\n\s]/g, '');
      if (nk.indexOf(clientKey) >= 0 || clientKey.indexOf(nk) >= 0) {
        idx.byClient[k].forEach(function (e) { collected.push(e); });
      }
    });
    const seen = {};
    const uniq = [];
    collected.forEach(function (e) {
      if (!seen[e.url]) { seen[e.url] = true; uniq.push(e); }
    });
    if (uniq.length === 0) return '';
    if (uniq.length === 1) return uniq[0].url;
    // 複数候補 → 既に別ケースに紐付き済みの URL を除外
    const usedIds = _Bulk_getExistingZissiIdSet();
    const available = uniq.filter(function (e) {
      const id = _Bulk_extractSheetIdFromUrl(e.url);
      return id && !usedIds[id];
    });
    if (available.length === 1) return available[0].url;
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * eventName からファイル名マッチ用のキーワード配列を返す。
 * - 改行/全角空白/句読点で分割
 * - 共通語 (展示会/ブース/出展/2024/2025/2026 など) と短すぎる(2字未満)を除外
 * - 配列が空ならマッチング不能と判定して呼び出し側で fallback skip
 */
function _Bulk_extractEventKeywords(eventName) {
  if (!eventName) return [];
  const STOPWORDS = /^(展示会|ブース|出展|出展ブース|reブース|REブース|キット|フェア|ビジネス|ジャパン|JAPAN|展|セミナー|国際|総合|大会|学術|学術大会|総会|株式会社|2024|2025|2026|2027|春|秋|夏|冬|東京|大阪|名古屋|九州|福岡|沖縄|中部|関東|関西|第[\d０-９]+回|Vol\.\d+|VOL\d+|Week|WEEK|EXPO|expo)$/i;
  const parts = String(eventName)
    .replace(/[【】（）()「」『』［］\[\]［］、,，\.　\n\r\t]/g, ' ')
    .split(/\s+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) {
      if (!s || s.length < 2) return false;
      if (STOPWORDS.test(s)) return false;
      return true;
    });
  // 重複排除
  const seen = {};
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i];
    if (!seen[w]) { seen[w] = true; out.push(w); }
    if (out.length >= 5) break; // top 5 keywords
  }
  return out;
}

function _Bulk_parsePeriod(s) {
  if (!s) return { start: '', end: '' };
  const str = String(s).trim();
  // パターン: "2025年10月20日〜22日"
  let m = str.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*[〜~～\-ー－]\s*(?:(\d{1,2})月)?\s*(\d{1,2})日/);
  if (m) {
    const y = m[1], m1 = m[2], d1 = m[3], m2 = m[4] || m[2], d2 = m[5];
    return {
      start: y + '/' + ('0' + m1).slice(-2) + '/' + ('0' + d1).slice(-2),
      end: y + '/' + ('0' + m2).slice(-2) + '/' + ('0' + d2).slice(-2)
    };
  }
  // パターン: "2026/04/15〜17" / "2026/4/8~10"
  m = str.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*[〜~～\-ー－]\s*(?:(\d{1,2})\/)?(\d{1,2})/);
  if (m) {
    const y = m[1], m1 = m[2], d1 = m[3], m2 = m[4] || m[2], d2 = m[5];
    return {
      start: y + '/' + ('0' + m1).slice(-2) + '/' + ('0' + d1).slice(-2),
      end: y + '/' + ('0' + m2).slice(-2) + '/' + ('0' + d2).slice(-2)
    };
  }
  // パターン: "10/8-10日" — 年なしは諦め
  return { start: '', end: '' };
}
