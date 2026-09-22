const INVOICE_TEMPLATE_ID = '1bNVo9IEynOaOp7H92PQJbXAOEVq6tSa7h3UvaMEQxDA';

function _Invoice_isWritableFormula(formula) { return !String(formula || '').trim(); }

function _Invoice_findLabel(sheet, prefix) {
  var rows = sheet.getLastRow(), cols = sheet.getLastColumn();
  if (!rows || !cols) return null;
  var values = sheet.getRange(1, 1, rows, cols).getDisplayValues();
  for (var r = 0; r < values.length; r++) for (var c = 0; c < values[r].length; c++) {
    if (String(values[r][c] || '').trim().indexOf(prefix) === 0) return { row: r + 1, col: c + 1 };
  }
  return null;
}

function _Invoice_findRecipientFields(sheet) {
  var rows = sheet.getLastRow(), cols = sheet.getLastColumn();
  if (!rows || !cols) return null;
  var values = sheet.getRange(1, 1, rows, cols).getDisplayValues();
  var invoiceNumber = null;
  for (var r = 0; r < values.length && !invoiceNumber; r++) for (var c = 0; c < values[r].length; c++) {
    if (String(values[r][c] || '').indexOf('請求書番号') >= 0) {
      invoiceNumber = { row: r + 1, col: c + 1 };
      break;
    }
  }
  if (!invoiceNumber) return null;
  return {
    recipient: { row: invoiceNumber.row, col: 1 },
    recipientContact: { row: invoiceNumber.row + 1, col: 1 }
  };
}

function _Invoice_writeIfNoFormula(sheet, row, col, value) {
  var cell = sheet.getRange(row, col);
  var formula = cell.getFormulas()[0][0];
  if (!_Invoice_isWritableFormula(formula)) return false;
  cell.setValue(value); return true;
}

function _Invoice_replaceLabelCell(sheet, prefix, buildValue, position) {
  var found = position || _Invoice_findLabel(sheet, prefix);
  if (!found) return { written: false, reason: 'label-not-found' };
  var range = sheet.getRange(found.row, found.col);
  if (range.isPartOfMerge()) range = range.getMergedRanges()[0].getCell(1, 1);
  var value = typeof buildValue === 'function' ? buildValue(range.getDisplayValue()) : buildValue;
  if (value === undefined || value === null || value === '') return { written: false, reason: 'empty-value' };
  if (!_Invoice_isWritableFormula(range.getFormulas()[0][0])) return { written: false, reason: 'formula' };
  range.setValue(value);
  return { written: true, reason: 'ok' };
}

function _Invoice_formatDate(value) {
  if (value === undefined || value === null || value === '') return '';
  var date = value instanceof Date ? value : null;
  if (!date) {
    var text = String(value).trim();
    var parts = text.match(/^(\d{4})[年\/-](\d{1,2})[月\/-](\d{1,2})日?$/);
    if (parts) {
      var year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
      date = new Date(year, month - 1, day);
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
    } else date = new Date(text);
  }
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy年M月d日');
}

function _Invoice_detailRowCapacity(sheet, header) {
  var startRow = header.row + 1;
  var rowCount = Math.max(0, sheet.getLastRow() - header.row);
  if (!rowCount) return 0;
  var formulas = sheet.getRange(startRow, header.amountCol, rowCount, 1).getFormulas();
  var count = 0;
  for (var i = 0; i < formulas.length; i++) {
    if (!/^\s*=\s*IF\s*\(\s*OR\s*\(/i.test(String(formulas[i][0] || ''))) break;
    count++;
  }
  return count;
}

function _Invoice_writeItems(sheet, header, items) {
  var capacity = _Invoice_detailRowCapacity(sheet, header);
  var writtenItems = items.slice(0, capacity);
  writtenItems.forEach(function (item, index) {
    var row = header.row + 1 + index;
    _Invoice_writeIfNoFormula(sheet, row, header.itemCol, item.name || '');
    _Invoice_writeIfNoFormula(sheet, row, header.qtyCol, Number(item.qty) || 1);
    _Invoice_writeIfNoFormula(sheet, row, header.priceCol, Number(item.unitPrice) || 0);
    _Invoice_writeIfNoFormula(sheet, row, header.taxCol, Number(item.taxRate) === 8 ? 8 : 10);
  });
  return { capacity: capacity, writtenItems: writtenItems, overflowCount: Math.max(0, items.length - capacity) };
}

function _Invoice_calculateFallbackTotal(items) {
  return Math.round(items.reduce(function (sum, item) {
    return sum + (Number(item.qty) || 1) * (Number(item.unitPrice) || 0) * (1 + (Number(item.taxRate) === 8 ? .08 : .1));
  }, 0));
}

function _Invoice_findTotalCell(values) {
  for (var r = 0; r < values.length; r++) {
    var labelCol = -1;
    for (var c = 0; c < values[r].length; c++) {
      var text = String(values[r][c] || '').trim();
      if (text.indexOf('合計') >= 0 && text.indexOf('税込') >= 0) {
        labelCol = c;
        break;
      }
    }
    if (labelCol < 0) continue;
    for (var valueCol = labelCol + 1; valueCol < values[r].length; valueCol++) {
      var display = String(values[r][valueCol] || '').trim();
      if (!display) continue;
      var normalized = display.replace(/[\s,，￥¥円]/g, '');
      if (normalized && isFinite(Number(normalized))) return { row: r + 1, col: valueCol + 1 };
    }
  }
  return null;
}

function _Invoice_readTemplateTotal(sheet, fallback) {
  var rows = sheet.getLastRow(), cols = sheet.getLastColumn();
  if (!rows || !cols) return fallback;
  var values = sheet.getRange(1, 1, rows, cols).getDisplayValues();
  var found = _Invoice_findTotalCell(values);
  if (!found) return fallback;
  var value = sheet.getRange(found.row, found.col).getValue();
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function _Invoice_applyRecipientContact(sheet, recipientContact, confirmations, position) {
  var contact = String(recipientContact || '').trim();
  var value = contact ? (/様$/.test(contact) ? contact : contact + '　様') : 'ご担当者様';
  var result = _Invoice_replaceLabelCell(sheet, '請求書番号', value, position);
  if (!contact) confirmations.push({
    category: '請求書/宛名担当者',
    content: '先方の担当者名が特定できず「ご担当者様」で出力しました。必要なら書き換えてください'
  });
  return { value: value, result: result };
}

function _Invoice_resolveHeaderValues(data, c, now) {
  return {
    recipient: String(data.recipient || c.clientName || '').trim(),
    issueDate: _Invoice_formatDate(data.issueDate || now)
  };
}

function _Invoice_addTemplateWarnings(fieldResults, confirmations) {
  var labels = {
    recipient: '宛名', recipientContact: '担当者', invoiceNumber: '請求書番号',
    issueDate: '発行日', dueDate: 'お支払期限'
  };
  Object.keys(fieldResults).forEach(function (field) {
    if (fieldResults[field].reason !== 'label-not-found') return;
    confirmations.push({
      category: '請求書/テンプレート',
      content: 'テンプレートの「' + labels[field] + '」欄が見つからず記入できませんでした。請求書テンプレートの様式が変わった可能性があります'
    });
  });
}

function _Invoice_buildPanelStatus(fieldResults, overflowWarning) {
  var missing = Object.keys(fieldResults).some(function (field) { return fieldResults[field].reason === 'label-not-found'; });
  if (missing) return '⚠ 請求書を生成しました（テンプレートに記入できない欄があります）';
  return overflowWarning || '請求書を生成しました';
}

function _Invoice_deleteOtherSheets(ss, keepSheet) {
  ss.getSheets().forEach(function (candidate) {
    if (candidate.getSheetId() !== keepSheet.getSheetId()) ss.deleteSheet(candidate);
  });
}

function _Invoice_findDetailHeader(sheet) {
  var rows = sheet.getLastRow(), cols = sheet.getLastColumn();
  var values = sheet.getRange(1, 1, rows, cols).getDisplayValues();
  for (var r = 0; r < values.length; r++) {
    var normalized = values[r].map(function (v) { return String(v || '').trim(); });
    var item = normalized.indexOf('品目'), qty = normalized.indexOf('数量'), price = normalized.indexOf('単価'), tax = normalized.indexOf('税率'), amount = normalized.indexOf('金額');
    if (item >= 0 && qty >= 0 && price >= 0 && tax >= 0 && amount >= 0) return { row: r + 1, itemCol: item + 1, qtyCol: qty + 1, priceCol: price + 1, taxCol: tax + 1, amountCol: amount + 1 };
  }
  return null;
}

function _Invoice_collectBasis(c, pastedText) {
  var parts = [], source = '';
  if (String(pastedText || '').trim()) { parts.push('【貼付欄（最優先）】\n' + String(pastedText).trim()); source = 'pastedText'; }
  if (!source) {
    try {
      var zissi = _Zissi_open(c), sheet = zissi.getSheetByName(COST_PROFIT_SHEET_NAME);
      if (sheet && sheet.getLastRow() > 1) {
        var values = sheet.getDataRange().getDisplayValues();
        var billing = values.filter(function (row, i) { return i === 0 || String(row[1]) === '請求'; });
        if (billing.length > 1) { parts.push('【Claude_原価粗利の請求行】\n' + billing.map(function (r) { return r.join('\t'); }).join('\n')); source = 'costProfit'; }
      }
    } catch (e) {}
  }
  if (!source) {
    try {
      var files = _CostProfit_scanFiles(c), latest = _CostProfit_findLatestOwnEstimate(files, c.caseId);
      if (latest) { parts.push('【最新の自社見積】\n' + _CostProfit_readOwnEstimate(latest.driveFileId)); source = 'estimate'; }
    } catch (e) {}
  }
  var context = '';
  try { context = Case_loadClientContext(c) || ''; } catch (e) {}
  if (context) parts.push('【案件コンテキスト（補助）】\n' + context);
  return { source: source, text: parts.join('\n\n') };
}

function Phase_Invoice_generate(caseId, pastedText) {
  if (pastedText === undefined) { var panel = _PanelInput_currentSheet(); pastedText = panel ? PanelInput_read(panel) : ''; }
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  var basis = _Invoice_collectBasis(c, pastedText);
  if (!basis.source) return { ok: false, message: '請求の根拠が見つかりません。貼付欄に請求内容を書くか、先に見積書を作ってください', panelStatus: '請求の根拠が見つかりません。貼付欄に請求内容を書くか、先に見積書を作ってください' };
  var res = ClaudeClient_call({ cachedContext: [basis.text], userMessage: [
    '請求書に記入する情報をJSONで抽出。入力にない値は空文字にし、絶対に推測しない。recipientContactは先方の担当者名（役職があれば含む）とし、入力に無ければ空文字。人名を推測して作らない。税率は既定10、軽減税率が明記された行のみ8。',
    '形式: {"recipient":"","recipientContact":"","issueDate":"","dueDate":"","invoiceNumber":"","items":[{"name":"","qty":1,"unitPrice":0,"taxRate":10,"note":""}],"confirmations":[{"category":"","content":""}]}',
    '宛名・支払期限・請求書番号が不明なら空のままとし、それぞれ confirmations に確認事項を入れる。'
  ].join('\n'), maxTokens: 3500 });
  var data = _Phase1_parseJson(res.text), items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return { ok: false, message: '請求明細を確定できませんでした', panelStatus: '請求明細を確定できませんでした' };
  var folder = DriveApp.getFolderById(c.projectFolderId || c.folderId);
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  var fileName = c.caseId + '_' + c.caseName + '_請求書_' + stamp;
  var copy = DriveApp.getFileById(INVOICE_TEMPLATE_ID).makeCopy(fileName, folder);
  var ss = SpreadsheetApp.openById(copy.getId()), sheet = null, header = null;
  ss.getSheets().some(function (candidate) {
    var found = _Invoice_findDetailHeader(candidate);
    if (!found) return false;
    sheet = candidate; header = found; return true;
  });
  if (!sheet || !header) throw new Error('請求書テンプレートの明細見出しが見つかりません');
  var gid = sheet.getSheetId();
  _Invoice_deleteOtherSheets(ss, sheet);
  var confirmations = Array.isArray(data.confirmations) ? data.confirmations : [];
  var recipientFields = _Invoice_findRecipientFields(sheet);
  var headerValues = _Invoice_resolveHeaderValues(data, c, new Date());
  var fieldResults = {};
  fieldResults.recipient = _Invoice_replaceLabelCell(sheet, '請求書番号', headerValues.recipient, recipientFields && recipientFields.recipient);
  var contactResult = _Invoice_applyRecipientContact(sheet, data.recipientContact, confirmations, recipientFields && recipientFields.recipientContact);
  fieldResults.recipientContact = contactResult.result;
  fieldResults.invoiceNumber = _Invoice_replaceLabelCell(sheet, '請求書番号：', function () { return '請求書番号：' + (data.invoiceNumber || ''); });
  var issueDate = headerValues.issueDate;
  var dueDate = _Invoice_formatDate(data.dueDate);
  fieldResults.issueDate = _Invoice_replaceLabelCell(sheet, '発行日：', function () { return '発行日：' + issueDate; });
  fieldResults.dueDate = _Invoice_replaceLabelCell(sheet, '【お支払期限】', function () { return dueDate ? '【お支払期限】　' + dueDate : ''; });
  _Invoice_addTemplateWarnings(fieldResults, confirmations);
  var detailResult = _Invoice_writeItems(sheet, header, items);
  SpreadsheetApp.flush();
  if (!headerValues.recipient) confirmations.push({ category: '請求書/宛名', content: '請求先の正式な宛名を確認してください' });
  if (!dueDate) confirmations.push({ category: '請求書/支払期限', content: '支払期限を確認してください' });
  if (!data.invoiceNumber) confirmations.push({ category: '請求書/番号', content: '請求書番号を確認してください' });
  var overflowWarning = '';
  if (detailResult.overflowCount) {
    overflowWarning = '明細が ' + detailResult.capacity + ' 行に収まらず ' + detailResult.overflowCount + ' 件を書けませんでした。品目をまとめるか、請求書を分けてください';
    confirmations.push({ category: '請求書/明細', content: overflowWarning });
  }
  if (confirmations.length) ConfirmationSheet_appendItems(caseId, confirmations, 1);
  var exported = Doc_exportPdf(copy.getId(), fileName + '.pdf', folder, { gid: gid });
  var fallbackTotal = _Invoice_calculateFallbackTotal(detailResult.writtenItems);
  var total;
  try { total = _Invoice_readTemplateTotal(sheet, fallbackTotal); } catch (e) { total = fallbackTotal; }
  try { MasterWriteBack_recordArtifact(caseId, '請求書', fileName, ss.getUrl()); } catch (e) {}
  return { ok: true, invoiceSheetUrl: ss.getUrl(), invoicePdfUrl: exported.pdfUrl, fileName: fileName, total: total, confirmations: confirmations, overflowCount: detailResult.overflowCount, fieldResults: fieldResults, panelStatus: _Invoice_buildPanelStatus(fieldResults, overflowWarning) };
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  _Invoice_isWritableFormula: _Invoice_isWritableFormula,
  _Invoice_findDetailHeader: _Invoice_findDetailHeader,
  _Invoice_findRecipientFields: _Invoice_findRecipientFields,
  _Invoice_replaceLabelCell: _Invoice_replaceLabelCell,
  _Invoice_detailRowCapacity: _Invoice_detailRowCapacity,
  _Invoice_writeItems: _Invoice_writeItems,
  _Invoice_findTotalCell: _Invoice_findTotalCell,
  _Invoice_readTemplateTotal: _Invoice_readTemplateTotal,
  _Invoice_applyRecipientContact: _Invoice_applyRecipientContact,
  _Invoice_resolveHeaderValues: _Invoice_resolveHeaderValues,
  _Invoice_addTemplateWarnings: _Invoice_addTemplateWarnings,
  _Invoice_buildPanelStatus: _Invoice_buildPanelStatus
};
