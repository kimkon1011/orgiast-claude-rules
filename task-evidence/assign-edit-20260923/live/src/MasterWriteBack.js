/**
 * 生成成果物 (依頼文/見積/スケジュール/打診文/手順書 等) を master 側
 * 「正式：reブースタスク進捗管理表」の "Claude生成物" シートに追記。
 *
 * シート構造（自動作成）:
 *   A 案件ID  B クライアント名  C 案件名  D 成果物タイプ  E 件名/タイトル  F URL  G 生成日時  H masterCol  I 備考
 *
 * 失敗（master 側書き込み権限なし等）は warn して swallow — 生成本体は失敗させない。
 */

const _MASTER_SS_ID = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
const _MASTER_ARTIFACT_SHEET = 'Claude生成物';
const _MASTER_ARTIFACT_HEADERS = [
  '案件ID', 'クライアント名', '案件名', '成果物タイプ', '件名/タイトル', 'URL', '生成日時', 'masterCol', '備考'
];

/** 種別が部分一致する最後の行から URL を返す（純粋ロジック）。 */
function _MasterWriteBack_findArtifactUrlInRows(rows, caseId, artifactTypeSubstring) {
  var wantedCase = String(caseId || '');
  var wantedType = String(artifactTypeSubstring || '');
  if (!wantedCase || !wantedType) return '';
  for (var i = (rows || []).length - 1; i >= 0; i--) {
    var row = rows[i] || [];
    if (String(row[0] || '') === wantedCase && String(row[3] || '').indexOf(wantedType) >= 0) {
      return String(row[5] || '');
    }
  }
  return '';
}

/** Claude生成物シートから、種別が部分一致する最新行の URL を返す。無ければ空文字。 */
function MasterWriteBack_findArtifactUrl(caseId, artifactTypeSubstring) {
  try {
    var c = CaseList_getById(caseId);
    if (!c || !c.masterSsId) return '';
    var sheet = SpreadsheetApp.openById(c.masterSsId).getSheetByName(_MASTER_ARTIFACT_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return '';
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
    return _MasterWriteBack_findArtifactUrlInRows(rows, caseId, artifactTypeSubstring);
  } catch (e) { return ''; }
}

/** Claude生成物シートから、その案件の全成果物を最新順で返す。 */
function MasterWriteBack_listArtifacts(caseId) {
  try {
    var c = CaseList_getById(caseId);
    if (!c || !c.masterSsId) return [];
    var sheet = SpreadsheetApp.openById(c.masterSsId).getSheetByName(_MASTER_ARTIFACT_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return [];
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
    return rows.filter(function (row) {
      return String(row[0] || '') === String(caseId || '');
    }).map(function (row) {
      var date = row[6] instanceof Date ? row[6] : new Date(String(row[6] || ''));
      return {
        type: String(row[3] || ''),
        title: String(row[4] || ''),
        url: String(row[5] || ''),
        createdAt: isNaN(date.getTime()) ? '' : date.toISOString()
      };
    }).sort(function (a, b) {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  } catch (e) { return []; }
}

/**
 * Claude生成物シートから重複行を削除。
 * 同じ (caseId, 成果物タイプ) の組み合わせは最新 1 行だけ残す（生成日時で最新を判定）。
 */
function MasterWriteBack_dedupe() {
  const ss = SpreadsheetApp.openById(_MASTER_SS_ID);
  const sheet = ss.getSheetByName(_MASTER_ARTIFACT_SHEET);
  if (!sheet) return { ok: false, error: 'Claude生成物 シートが無い' };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, removed: 0 };
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  // key = caseId + '|' + artifactType → 最新行の元 index を保持
  const latest = {};
  for (let i = 0; i < data.length; i++) {
    const caseId = String(data[i][0] || '').trim();
    const artifactType = String(data[i][3] || '').trim();
    const ts = data[i][6] instanceof Date ? data[i][6].getTime() : 0;
    if (!caseId || !artifactType) continue;
    const key = caseId + '|' + artifactType;
    if (!latest[key] || latest[key].ts < ts) {
      latest[key] = { idx: i, ts: ts };
    }
  }
  const keepSet = {};
  Object.keys(latest).forEach(function (k) { keepSet[latest[k].idx] = true; });
  // 残す行だけ収集
  const kept = [];
  for (let i = 0; i < data.length; i++) {
    if (keepSet[i]) kept.push(data[i]);
  }
  const removed = data.length - kept.length;
  // 全データ削除 → kept で書き戻し
  sheet.getRange(2, 1, data.length, sheet.getLastColumn()).clearContent();
  if (kept.length > 0) {
    sheet.getRange(2, 1, kept.length, kept[0].length).setValues(kept);
  }
  return { ok: true, originalRows: data.length, removed: removed, kept: kept.length };
}

/**
 * 成果物 1 件を master 側に追記。
 * @param {string} caseId 案件ID (C0001 etc.)
 * @param {string} artifactType 例: 'デザイナー依頼文', '見積', 'スケジュール', '施工会社打診', '設営撤去手順', '搬入出計画'
 * @param {string} title 件名 / ドキュメントタイトル
 * @param {string} url 成果物 URL
 * @param {string} [note] 任意の備考
 */
function MasterWriteBack_recordArtifact(caseId, artifactType, title, url, note) {
  try {
    const c = CaseList_getById(caseId);
    if (!c) return { ok: false, error: 'case not found: ' + caseId };
    if (!c.masterSsId) return { ok: false, error: 'masterSsId 未設定 (この案件は master 由来ではない)' };

    const ss = SpreadsheetApp.openById(c.masterSsId);
    let sheet = ss.getSheetByName(_MASTER_ARTIFACT_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(_MASTER_ARTIFACT_SHEET);
      sheet.appendRow(_MASTER_ARTIFACT_HEADERS);
      sheet.getRange(1, 1, 1, _MASTER_ARTIFACT_HEADERS.length)
        .setFontWeight('bold').setBackground('#cfe2f3');
      sheet.setFrozenRows(1);
      sheet.setColumnWidth(5, 280); // タイトル
      sheet.setColumnWidth(6, 280); // URL
    }
    // 同一 (caseId, artifactType) が既にあれば 上書き、無ければ append
    const row = [
      caseId,
      c.clientName,
      c.caseName,
      artifactType,
      title || '',
      url || '',
      new Date(),
      c.masterCol || '',
      note || ''
    ];
    const lastRow = sheet.getLastRow();
    let updatedRow = 0;
    if (lastRow >= 2) {
      const existing = sheet.getRange(2, 1, lastRow - 1, 4).getValues(); // 列 A(caseId), B, C, D(artifactType)
      for (let i = existing.length - 1; i >= 0; i--) {
        if (String(existing[i][0]) === String(caseId) && String(existing[i][3]) === String(artifactType)) {
          updatedRow = i + 2;
          sheet.getRange(updatedRow, 1, 1, row.length).setValues([row]);
          break;
        }
      }
    }
    if (!updatedRow) {
      sheet.appendRow(row);
      const appendedRow = sheet.getLastRow();
      return { ok: true, row: Number(appendedRow), updatedRow: 'appended' };
    }
    return { ok: true, row: Number(updatedRow), updatedRow: updatedRow };
  } catch (e) {
    console.warn('MasterWriteBack failed: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/** Claude生成物シートの URL。行番号が分かればその行へジャンプする。 */
function MasterWriteBack_artifactSheetUrl(caseId, rowNumber) {
  try {
    const c = CaseList_getById(caseId);
    if (!c || !c.masterSsId) return '';
    const ss = SpreadsheetApp.openById(c.masterSsId);
    const sheet = ss.getSheetByName(_MASTER_ARTIFACT_SHEET);
    if (!sheet) return '';
    var sheetUrl = PanelLinks_sheetUrl(ss, sheet);
    return rowNumber ? sheetUrl.replace('#gid=', '&range=A' + Number(rowNumber) + '#gid=') : sheetUrl;
  } catch (e) { return ''; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  _MasterWriteBack_findArtifactUrlInRows: _MasterWriteBack_findArtifactUrlInRows
};
