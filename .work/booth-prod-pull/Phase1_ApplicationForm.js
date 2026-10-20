/**
 * Phase1_ApplicationForm: 見積から申込書 PDF を生成し、金額一致を検証して案件フォルダに保存する。
 *
 * 流れ:
 * 1) 案件の見積シートを特定し、明細・金額（税抜、消費税、税込）を読み込む。
 * 2) ApplicationForm_buildModel でモデル作成。
 * 3) ApplicationForm_validate で検証。金額不一致や必須欠落があれば BLOCKED 記録して終了。
 * 4) テンプレ Google Docs を複製し、{{placeholder}} を置換。
 * 5) PDF 化して「02見積・申込書」フォルダおよび申込書保存フォルダに保存。
 * 6) Claude_タスク台帳 の行 37（または見積・申込書タスク）に完了と PDF URL を記録。
 */

var APPLICATION_FORM_DEFAULT_SAVE_FOLDER_ID = '10uOOHt64yG_oUx4iRiS4V7Jnbu5nWubJ';
var APPLICATION_FORM_TEMPLATE_PROP_KEY = 'APPLICATION_FORM_TEMPLATE_DOC_ID';

/**
 * 案件フォルダ配下の「02見積・申込書」フォルダを取得または作成する
 */
function _AppForm_ensureEstimateFolder(projectFolder) {
  var it = projectFolder.getFoldersByName('02見積・申込書');
  if (it.hasNext()) return it.next();
  // 類似名「02見積」「02 見積」「02見積り」等があればそれを優先
  var allFolders = projectFolder.getFolders();
  while (allFolders.hasNext()) {
    var sub = allFolders.next();
    var name = sub.getName();
    if (/^02\s*見積/.test(name) || name === '02見積・申込書') return sub;
  }
  return projectFolder.createFolder('02見積・申込書');
}

/**
 * 申込書テンプレート Doc ID を取得（無ければ自動生成して Script Property に保存）
 */
function _AppForm_getOrCreateTemplateDocId() {
  var props = PropertiesService.getScriptProperties();
  var docId = props.getProperty(APPLICATION_FORM_TEMPLATE_PROP_KEY);
  if (docId) {
    try {
      DocumentApp.openById(docId);
      return docId;
    } catch (e) {
      console.warn('既存の APPLICATION_FORM_TEMPLATE_DOC_ID が開けません。再作成します: ' + e);
    }
  }

  // テンプレート新規作成
  var doc = DocumentApp.create('【テンプレート】申込書');
  var body = doc.getBody();

  body.appendParagraph('【出展装飾 申込書】').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('申込日: {{applicationDate}}').setAlignment(DocumentApp.HorizontalAlignment.RIGHT);

  body.appendParagraph('■ お客様情報').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('貴社名: {{clientName}}\nご担当者: {{contactName}}\nご住所: {{address}}\nお電話: {{tel}}\nメール: {{email}}');

  body.appendParagraph('■ 出展概要').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('展示会名: {{exhibitionName}}\n会期: {{period}}');

  body.appendParagraph('■ お申込み金額（税込）').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('税込合計金額: ¥{{totalIncludingTax}} (税抜: ¥{{totalExcludingTax}} / 消費税: ¥{{consumptionTax}})').setHeading(DocumentApp.ParagraphHeading.HEADING1);

  body.appendParagraph('■ お申込み明細').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('{{itemsDetailTable}}');

  body.appendParagraph('■ お支払条件').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('{{paymentTerms}}');

  body.appendParagraph('■ キャンセル規定').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('{{cancelPolicy}}');

  body.appendParagraph('\n\n上記内容を確認の上、本書の通り申し込みます。\n\n年　　月　　日\n\n貴社名: _____________________________________\n\n代表者印またはご担当印: 　　　　　　　　　　　　　　　[ 印 ]');

  doc.saveAndClose();
  docId = doc.getId();
  props.setProperty(APPLICATION_FORM_TEMPLATE_PROP_KEY, docId);
  return docId;
}

/**
 * 案件の見積シートから明細および合計金額を読み込む
 */
function _AppForm_readEstimateData(caseInfo) {
  var files = _CostProfit_scanFiles(caseInfo);
  var latest = _CostProfit_findLatestOwnEstimate(files, caseInfo.caseId);
  if (!latest) return null;

  var ss = SpreadsheetApp.openById(latest.driveFileId);
  var target = _Estimate_findDetailHeaderRow(ss);
  if (!target) return null;

  var sheet = target.sheet;
  var rows = sheet.getLastRow();
  var values = sheet.getRange(1, 1, rows, 14).getValues();

  var items = [];
  var totalEx = 0;
  var startRow = target.row + 1; // ヘッダの次行以降

  for (var r = startRow; r < values.length; r++) {
    var row = values[r];
    var firstCol = String(row[0] || '').trim();
    if (/^(項目計|小計|合計|オプション)$/.test(firstCol)) break;
    var itemName = String(row[1] || '').trim();
    if (!itemName) continue;
    // テンプレのガード行・カテゴリだけの行は明細として数えない (_EstimateUpdate_readCurrent と同じ判定)。
    // これを欠くとガード行が申込書の明細に混入する。単価0の正当な明細は除外されない(空白かどうかで判定)。
    var priceBlank = (row[4] === '' || row[4] === null || row[4] === undefined);
    var qtyBlank = (row[5] === '' || row[5] === null || row[5] === undefined);
    if (priceBlank && qtyBlank) continue;
    var price = Number(row[4]) || 0;
    var qty = Number(row[5]) || 0;
    var unit = String(row[6] || '式').trim();
    var amount = Number(row[11]) || (price * qty);
    items.push({
      category: firstCol,
      itemName: itemName,
      content: String(row[2] || '').trim(),
      note: String(row[3] || '').trim(),
      unitPrice: price,
      qty: qty,
      qtyUnit: unit,
      amount: amount
    });
    totalEx += amount;
  }

  // 合計金額の検出（シートの数式/表示セルがあれば利用）
  var totalIn = 0;
  var totalCell = _Invoice_findTotalCell(sheet.getDataRange().getDisplayValues());
  if (totalCell) {
    var rawVal = sheet.getRange(totalCell.row, totalCell.col).getValue();
    if (typeof rawVal === 'number' && rawVal > 0) totalIn = rawVal;
  }
  if (!totalIn) {
    totalIn = Math.round(totalEx * 1.1);
  }

  var tax = totalIn - totalEx;

  // キャンセル規定があれば拾う
  var props = PropertiesService.getScriptProperties();
  var cancelPolicy = props.getProperty('APPLICATION_CANCEL_POLICY') || APPLICATION_DEFAULT_CANCEL_POLICY;

  return {
    driveFileId: latest.driveFileId,
    sheetName: sheet.getName(),
    items: items,
    totalExcludingTax: totalEx,
    consumptionTax: tax,
    totalIncludingTax: totalIn,
    cancelPolicy: cancelPolicy
  };
}

/**
 * 申込書ドキュメントの置換
 */
function _AppForm_populateDoc(doc, model) {
  var body = doc.getBody();
  body.replaceText('\\{\\{applicationDate\\}\\}', model.applicationDate || '');
  body.replaceText('\\{\\{clientName\\}\\}', model.clientName || '');
  body.replaceText('\\{\\{contactName\\}\\}', model.contactName ? model.contactName + ' 様' : 'ご担当者 様');
  body.replaceText('\\{\\{address\\}\\}', model.address || '');
  body.replaceText('\\{\\{tel\\}\\}', model.tel || '');
  body.replaceText('\\{\\{email\\}\\}', model.email || '');
  body.replaceText('\\{\\{exhibitionName\\}\\}', model.exhibitionName || '');
  body.replaceText('\\{\\{period\\}\\}', model.period || '');
  body.replaceText('\\{\\{totalIncludingTax\\}\\}', Number(model.totalIncludingTax).toLocaleString());
  body.replaceText('\\{\\{totalExcludingTax\\}\\}', Number(model.totalExcludingTax).toLocaleString());
  body.replaceText('\\{\\{consumptionTax\\}\\}', Number(model.consumptionTax).toLocaleString());
  body.replaceText('\\{\\{paymentTerms\\}\\}', model.paymentTerms || '');
  body.replaceText('\\{\\{cancelPolicy\\}\\}', model.cancelPolicy || '');

  // 明細表の整形
  var detailLines = (model.items || []).map(function (it) {
    var line = it.name;
    if (it.spec) line += ' (' + it.spec + ')';
    line += ' : ' + it.qty + (it.unit || '') + ' × ¥' + it.unitPrice.toLocaleString() + ' = ¥' + it.amount.toLocaleString();
    if (it.note) line += ' ※' + it.note;
    return line;
  });
  body.replaceText('\\{\\{itemsDetailTable\\}\\}', detailLines.join('\n') || '（明細なし）');
}

/**
 * Claude_タスク台帳 の行 37「見積書・申込書（概算）作成」または該当行に記録する
 */
function _AppForm_recordTaskLedger(caseId, status, resultText) {
  try {
    var c = CaseList_getById(caseId);
    if (!c || !c.zissiId) return;
    var zissi = _Zissi_open(c);
    var sheet = zissi.getSheetByName(TASK_LEDGER_SHEET_NAME);
    if (!sheet) return;

    var rows = sheet.getLastRow();
    if (rows < 2) return;
    var values = sheet.getRange(2, 1, rows - 1, 4).getValues(); // A:D
    var targetRowIndex = -1;

    // 行 37 (1-based sheet row 37 => row index in sheet is 37) が該当するか確認
    if (rows >= 37) {
      var task37Name = String(sheet.getRange(37, 4).getValue() || '');
      if (/見積.*申込|申込.*見積/.test(task37Name)) {
        targetRowIndex = 37;
      }
    }

    if (targetRowIndex < 0) {
      for (var i = 0; i < values.length; i++) {
        var name = String(values[i][3] || '');
        if (/見積.*申込|申込.*見積|見積書・申込書/.test(name)) {
          targetRowIndex = i + 2;
          break;
        }
      }
    }

    if (targetRowIndex > 0) {
      _TaskLedger_writePatch(caseId, targetRowIndex, {
        status: status,
        result: resultText,
        ranAt: new Date(),
        updatedAt: new Date()
      });
    }
  } catch (e) {
    console.warn('タスク台帳記録失敗: ' + (e.message || e));
  }
}

/**
 * Phase1_ApplicationForm_run(caseId): 見積から申込書 PDF を生成
 */
function Phase1_ApplicationForm_run(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  var estimate = _AppForm_readEstimateData(c);
  if (!estimate) {
    var blockedMsg = 'BLOCKED: 見積書が見つからないか明細を読み取れませんでした';
    _AppForm_recordTaskLedger(caseId, '未着手', blockedMsg);
    return { ok: false, error: blockedMsg, panelStatus: '❌ ' + blockedMsg };
  }

  var today = new Date();
  var model = ApplicationForm_buildModel(estimate, c, today);
  var validation = ApplicationForm_validate(model, estimate);

  if (!validation.ok) {
    var blocked = 'BLOCKED: ' + validation.errors.join(', ');
    _AppForm_recordTaskLedger(caseId, '未着手', blocked);
    return { ok: false, errors: validation.errors, message: blocked, panelStatus: '❌ ' + blocked };
  }

  var rootId = Case_resolveProjectRoot(c);
  var projectFolder = rootId ? DriveApp.getFolderById(rootId) : DriveApp.getFolderById(c.folderId);
  var estimateFolder = _AppForm_ensureEstimateFolder(projectFolder);

  // 申込書保存共通フォルダ
  var props = PropertiesService.getScriptProperties();
  var centralFolderId = props.getProperty('APPLICATION_FORM_SAVE_FOLDER_ID') || APPLICATION_FORM_DEFAULT_SAVE_FOLDER_ID;
  var centralFolder = null;
  try {
    if (centralFolderId) centralFolder = DriveApp.getFolderById(centralFolderId);
  } catch (e) {
    console.warn('申込書共通保存フォルダ取得失敗: ' + e);
  }

  // テンプレート Docs 複製
  var tplId = _AppForm_getOrCreateTemplateDocId();
  var fileName = ApplicationForm_fileName(c, today);
  var docTitle = fileName.replace(/\.pdf$/i, '');
  var copy = DriveApp.getFileById(tplId).makeCopy(docTitle, estimateFolder);
  var doc = DocumentApp.openById(copy.getId());

  _AppForm_populateDoc(doc, model);
  doc.saveAndClose();

  // PDF 化
  var pdfBlob = copy.getAs('application/pdf').setName(fileName);
  var pdfFile = estimateFolder.createFile(pdfBlob);
  try { pdfFile.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}

  // 共通フォルダにも保存
  if (centralFolder && centralFolder.getId() !== estimateFolder.getId()) {
    try {
      var copyCentral = centralFolder.createFile(pdfBlob);
      try { copyCentral.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    } catch (e) {
      console.warn('申込書共通フォルダへの保存失敗: ' + e);
    }
  }

  var pdfUrl = pdfFile.getUrl();

  // 台帳に記録
  _AppForm_recordTaskLedger(caseId, '完了', '申込書PDF作成: ' + pdfUrl);

  // 成果物記録
  try {
    MasterWriteBack_recordArtifact(caseId, '申込書', fileName, pdfUrl);
  } catch (e) {}

  return {
    ok: true,
    fileId: pdfFile.getId(),
    fileName: fileName,
    pdfUrl: pdfUrl,
    docUrl: copy.getUrl(),
    totalIncludingTax: model.totalIncludingTax,
    panelStatus: '✅ 申込書PDF作成完了: ' + fileName
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _AppForm_ensureEstimateFolder: _AppForm_ensureEstimateFolder,
    _AppForm_getOrCreateTemplateDocId: _AppForm_getOrCreateTemplateDocId,
    _AppForm_readEstimateData: _AppForm_readEstimateData,
    _AppForm_populateDoc: _AppForm_populateDoc,
    _AppForm_recordTaskLedger: _AppForm_recordTaskLedger,
    Phase1_ApplicationForm_run: Phase1_ApplicationForm_run,
    APPLICATION_FORM_DEFAULT_SAVE_FOLDER_ID: APPLICATION_FORM_DEFAULT_SAVE_FOLDER_ID,
    APPLICATION_FORM_TEMPLATE_PROP_KEY: APPLICATION_FORM_TEMPLATE_PROP_KEY
  };
}
