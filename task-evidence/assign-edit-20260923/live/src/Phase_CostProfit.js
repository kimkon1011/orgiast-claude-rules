/** 仕入見積、自社見積、制作物価格表から案件の原価・請求・粗利台帳を更新する。 */
const COST_PROFIT_SHEET_NAME = 'Claude_原価粗利';
const COST_PROFIT_FILE_SHEET_NAME = 'Claude_原価粗利_ファイル';
const COST_PROFIT_HEADERS = ['更新日時', '区分', '仕入先', '項目', '仕様', '数量', '単位', '単価', '金額', '出典', '信頼度', 'メモ', 'ファイルを開く'];
const COST_PROFIT_FILE_HEADERS = ['ファイル名', '判定', '判定の根拠', '最終取込日時', '差出人', 'メールアドレス', '送信元ドメイン', '件名', '受信日時', 'ファイルを開く', 'メールを開く'];
const COST_PROFIT_FILE_SIDES = ['原価', '請求', '入金', '除外', '自動'];

function _CostProfit_enqueue(caseId) {
  try {
    const blob = Utilities.newBlob(
      JSON.stringify({ command: 'Phase_CostProfit_generate', args: [caseId] }),
      'application/json',
      'cmd_' + Utilities.getUuid().replace(/-/g, '') + '.json'
    );
    DriveApp.getFolderById(CMD_FOLDER_ID).createFile(blob);
    return true;
  } catch (e) {
    return false;
  }
}

function Phase_CostProfit_generate(caseId) {
  try {
    const c = CaseList_getById(caseId);
    if (!c) return { ok: false, error: '案件が見つかりません: ' + caseId };
    if (!c.zissiId) return { ok: false, error: '実施計画書がありません' };

    const zissiSs = SpreadsheetApp.openById(c.zissiId);
    const files = _CostProfit_scanFiles(c);
    const fileMap = _CostProfit_buildFileMap(files);
    const initialSelection = _CostProfit_selectSupplierFiles(files, caseId, 3);
    const ownEstimate = _CostProfit_findLatestOwnEstimate(files, caseId);
    const decisionTargets = initialSelection.attached.concat(initialSelection.tabular, initialSelection.skipped);
    if (ownEstimate && !decisionTargets.some(function (f) { return f.label === ownEstimate.label; })) decisionTargets.push(ownEstimate);
    const fileDecisions = _CostProfit_upsertFileDecisions(zissiSs, decisionTargets, caseId);
    const decisionByName = {};
    fileDecisions.forEach(function (d) { decisionByName[d.name] = d; });
    const includedFiles = _CostProfit_filterExcludedFiles(files, fileDecisions);
    const selection = _CostProfit_selectSupplierFiles(includedFiles, caseId, 3);
    const tabularTexts = [];
    selection.tabular.forEach(function (f) {
      const text = _CostProfit_readTabularQuote(f);
      if (text) tabularTexts.push({ driveFileId: f.driveFileId, label: f.label, text: text });
      else selection.skipped.push(Object.assign({}, f, { skipReason: 'tabular_read_failed' }));
    });
    selection.tabular = selection.tabular.filter(function (f) {
      return tabularTexts.some(function (x) { return x.driveFileId === f.driveFileId; });
    });
    const includedOwnEstimate = ownEstimate && (!decisionByName[ownEstimate.label] || decisionByName[ownEstimate.label].side !== '除外') ? ownEstimate : null;
    const estimateText = includedOwnEstimate ? 'ファイル名: ' + includedOwnEstimate.label + '\n' + _CostProfit_readOwnEstimate(includedOwnEstimate.driveFileId) : '自社見積なし';
    const priceListText = _CostProfit_trimText(_Estimate_loadPriceList(), 12000);
    const manualPages = ManualLoader_findPages(['原価の反映', '見積書に売値をいれる', '粗利']);
    const confirmationsSeed = _CostProfit_buildSkippedConfirmations(selection.skipped);
    if (files.scanTruncated) confirmationsSeed.push({ category: '見積ファイル', content: 'フォルダが大きいため一部未走査' });
    const cachedContext = [
      Case_loadClientContext(c),
      '【関連マニュアル抜粋】',
      manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; }).join('\n\n'),
      '【制作物価格表（売価の根拠）】\n' + priceListText
    ].filter(Boolean);
    const userMessage = _CostProfit_buildPrompt(c, estimateText, selection.skipped, tabularTexts, fileDecisions);
    const res = ClaudeClient_call({
      cachedContext: cachedContext,
      userMessage: userMessage,
      documents: selection.attached,
      maxTokens: 6000
    });
    const parsed = _Phase1_parseJson(res.text);
    const costItems = _CostProfit_normalizeAlternatives(Array.isArray(parsed.costItems) ? parsed.costItems : []);
    const billItems = Array.isArray(parsed.billItems) ? parsed.billItems : [];
    const paymentItems = Array.isArray(parsed.paymentItems) ? parsed.paymentItems : [];
    const confirmations = confirmationsSeed.concat(Array.isArray(parsed.confirmations) ? parsed.confirmations : []);
    const provisional = _CostProfit_isProvisional(costItems, billItems);
    if (provisional) confirmations.push(_CostProfit_provisionalConfirmation());
    const totals = _CostProfit_calculateTotals(costItems, billItems, paymentItems);
    const rows = _CostProfit_makeRows(costItems, billItems, paymentItems, fileMap);
    const processedSources = selection.attached.concat(selection.tabular).map(function (f) { return f.label; });
    if (includedOwnEstimate) processedSources.push(includedOwnEstimate.label);
    const sheet = _CostProfit_ensureSheet(zissiSs);
    sheet.getRange('J1').setValue(provisional ? '※請求側の明細が不足＝粗利は暫定' : '');
    const merged = _CostProfit_mergeRows(sheet, rows, processedSources);
    SpreadsheetApp.flush();
    const finalRow = sheet.getLastRow();
    const zissiUrl = zissiSs.getUrl();

    if (confirmations.length) ConfirmationSheet_appendItems(caseId, confirmations, '[原価粗利]');
    MasterWriteBack_recordArtifact(caseId, '原価粗利', COST_PROFIT_SHEET_NAME, zissiUrl);
    CaseList_touchUpdatedAt(caseId);
    return {
      ok: true, zissiUrl: zissiUrl, sheetName: COST_PROFIT_SHEET_NAME,
      costTotal: totals.costTotal, billTotal: totals.billTotal,
      paymentTotal: totals.paymentTotal, candidateCostTotal: totals.candidateCostTotal,
      grossProfit: totals.grossProfit, grossMarginRate: totals.grossMarginRate,
      costRows: costItems.length, billRows: billItems.length, paymentRows: paymentItems.length,
      appended: merged.appended, superseded: merged.superseded, untouched: merged.untouched,
      attachedFiles: selection.attached.map(function (f) { return f.label; }),
      tabularFiles: selection.tabular.map(function (f) { return f.label; }),
      skippedFiles: selection.skipped.map(function (f) { return f.label; }),
      fileDecisions: fileDecisions,
      provisional: provisional,
      confirmationCount: confirmations.length, writtenRows: merged.appended,
      finalRow: finalRow, usage: res.usage || {}
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function _CostProfit_buildPrompt(c, estimateText, skipped, tabularTexts, fileDecisions) {
  const tabularSection = (tabularTexts || []).map(function (x) {
    return '### ' + x.label + '\n' + x.text;
  }).join('\n\n');
  const decisionSection = (fileDecisions || []).map(function (d) {
    return '- ' + d.side + ': ' + d.name;
  }).join('\n');
  return [
    '添付された仕入先見積と下記資料から、この案件の原価・請求明細を抽出してください。',
    '案件ID: ' + c.caseId, 'クライアント: ' + (c.clientName || ''), '案件名: ' + (c.caseName || ''),
    '', '【最新の自社見積明細（請求側）】', estimateText || '自社見積なし',
    '', '【仕入見積(表形式・テキスト抽出)】', tabularSection || 'なし',
    '', '【添付しなかった候補】', skipped.length ? skipped.map(function (f) { return f.label; }).join('\n') : 'なし',
    '', '【ファイルの側の指定（これに従うこと）】', decisionSection || 'なし',
    'ここで「原価」と指定されたファイルの明細は必ず costItems に、「請求」は billItems に、「入金」は paymentItems に入れること。指定に反する分類をしてはいけない。',
    '「除外」のファイルは無視すること。「自動」のファイルだけ、内容を見て自分で振り分けてよい。',
    '', '【出力形式（厳守・JSON単体、前後の説明文なし）】',
    '{"costItems":[{"supplier":"","itemName":"","spec":"","qty":1,"unit":"式","unitCost":0,"amount":0,"sourceFile":"","confidence":"high|mid|low","alternative":false}],"billItems":[{"itemName":"","unitPrice":0,"qty":1,"unit":"式","amount":0,"priceSource":"自社見積|価格表:<シート名>|未確定","sourceFile":""}],"paymentItems":[{"itemName":"","amount":0,"sourceFile":""}],"confirmations":[{"category":"","content":""}]}',
    '', '【重要ルール】',
    '- 入力に無い金額を作らない。読み取れない原価は amount:0、confidence:"low" とし、理由を confirmations に入れる。',
    '- 原価は仕入見積（添付ファイル）だけから取る。制作物価格表は売価（請求側）の根拠としてだけ使う。',
    '- 税抜で統一し、税は分けない。税込・税抜を判別できない場合は confirmations に「税区分不明」を入れる。',
    '- amount は各明細の税抜金額。合計や粗利の計算は行わない。',
    '- 表形式の見積は見出し行を見て単価・数量・金額の列を判断すること。',
    '- 合計行は明細として二重計上しないこと。',
    '- 同一の見積書の中にどちらか一方を選ぶ選択肢（プラン別・デザイン案別・パターン別など）が並んでいる場合、両方を原価に計上してはいけない。判断できない場合は両方を costItems に入れつつ、それぞれの alternative を true にし、spec に「選択肢: <もう一方の項目名>」と書くこと。',
    '- costItems[].alternative が true のものは台帳で「原価(候補)」として扱われ、原価合計には入らない。確定している費目には alternative を付けないこと。',
    '- 自社（オージャスト）が発行した請求書・前金・中間金の PDF は売上の内訳であって新しい請求明細ではない。これらは paymentItems に入れること（{itemName, amount, sourceFile}）。billItems には自社見積の明細だけを入れること。ファイル名に「ご請求書」「請求」を含み、かつ自社PJコード（\\d{6}[A-Z]{3} 形式、例 261102IRY）を含むものは自社発行と判断してよい。',
    '- マニュアルに原価計上・粗利のルールがあれば従い、根拠を該当 costItems の spec 末尾に「※<マニュアル節>」として残す。',
    '- 自社見積に明細が無い売価は価格表から対応するものだけを採用し、根拠シート名を priceSource に残す。'
  ].join('\n');
}

function _CostProfit_guessSide(fileName, caseId) {
  const name = String(fileName || '').normalize('NFC');
  if (/\d{6}[A-Z]{3}/.test(name) && /請求|ご請求/.test(name)) return { side: '入金', reason: '自社発行の請求書' };
  if (/^メール添付_/.test(name) && /御見積書|御見積|見積書/.test(name)) return { side: '原価', reason: '取引先から届いた見積' };
  if (caseId && name.indexOf(String(caseId) + '_') === 0 && name.indexOf('_見積_') >= 0) return { side: '請求', reason: 'アプリ生成の自社見積' };
  if (/備品リスト|部材リスト|内訳/.test(name)) return { side: '自動', reason: '内容から判断' };
  return { side: '自動', reason: '内容から判断' };
}

function _CostProfit_ensureFileDecisionSheet(ss) {
  let sheet = ss.getSheetByName(COST_PROFIT_FILE_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(COST_PROFIT_FILE_SHEET_NAME);
  sheet.getRange(1, 1, 1, COST_PROFIT_FILE_HEADERS.length).setValues([COST_PROFIT_FILE_HEADERS]).setFontWeight('bold').setBackground('#d9ead3');
  [420, 90, 200, 150, 150, 230, 170, 280, 150, 90, 100].forEach(function (width, i) { sheet.setColumnWidth(i + 1, width); });
  sheet.setFrozenRows(1);
  const validation = SpreadsheetApp.newDataValidation().requireValueInList(COST_PROFIT_FILE_SIDES, true).build();
  sheet.getRange(2, 2, Math.max(1, sheet.getMaxRows() - 1), 1).setDataValidation(validation);
  return sheet;
}

function _CostProfit_upsertFileDecisions(ss, files, caseId) {
  const sheet = _CostProfit_ensureFileDecisionSheet(ss);
  const mailIndex = _CostProfit_loadMailAttachmentIndex(caseId);
  const lastRow = sheet.getLastRow();
  const existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, COST_PROFIT_FILE_HEADERS.length).getValues() : [];
  const rowByName = {};
  existing.forEach(function (row, i) { if (row[0] !== '') rowByName[String(row[0]).normalize('NFC')] = i + 2; });
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  const decisions = [];
  (files || []).forEach(function (file) {
    const name = String(file && (file.label || file.name) || '').normalize('NFC');
    if (!name) return;
    const guessed = _CostProfit_guessSide(name, caseId);
    const provenance = _CostProfit_fileProvenance(file, mailIndex);
    const rowNumber = rowByName[name];
    if (rowNumber) {
      const savedSide = String(sheet.getRange(rowNumber, 2, 1, 1).getValues()[0][0] || '自動');
      sheet.getRange(rowNumber, 3, 1, 9).setValues([[guessed.reason, stamp].concat(provenance)]);
      decisions.push({ name: name, side: savedSide, reason: guessed.reason });
    } else {
      const nextRow = sheet.getLastRow() + 1;
      sheet.getRange(nextRow, 1, 1, COST_PROFIT_FILE_HEADERS.length).setValues([[name, guessed.side, guessed.reason, stamp].concat(provenance)]);
      rowByName[name] = nextRow;
      decisions.push({ name: name, side: guessed.side, reason: guessed.reason });
    }
  });
  return decisions;
}

function _CostProfit_parseSender(sender) {
  const value = String(sender || '').trim();
  const match = value.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/);
  const email = match ? match[2].trim() : (/^[^\s<>@]+@[^\s<>@]+$/.test(value) ? value : '');
  let name = match ? match[1].trim() : (email ? '' : value);
  if (/^"[\s\S]*"$/.test(name)) name = name.slice(1, -1);
  return { name: name, email: email, domain: email ? email.split('@').pop().toLowerCase() : '' };
}

function _CostProfit_loadMailAttachmentIndex() {
  const index = { saved: {}, original: {} };
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName('Claude_メール添付取込');
    if (!sheet || sheet.getLastRow() < 2) return index;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 13).getValues();
    const caseId = arguments[0];
    let apiByMessageId = null;
    const targetRows = [];
    rows.forEach(function (row, i) {
      if (caseId && String(row[1] || '') !== String(caseId)) return;
      targetRows.push({ row: row, rowNumber: i + 2 });
    });
    if (caseId && targetRows.some(function (item) { return !item.row[4] && item.row[10]; })) {
      apiByMessageId = _CostProfit_loadMailApiMap(caseId);
    }
    targetRows.forEach(function (item) {
      const row = item.row;
      const apiRecord = !row[4] && apiByMessageId && apiByMessageId[String(row[10] || '')];
      if (apiRecord && apiRecord.sender) {
        sheet.getRange(item.rowNumber, 5, 1, 1).setValues([[apiRecord.sender]]);
        row[4] = apiRecord.sender;
      }
      const resolved = _CostProfit_resolveMailRecord({ receivedAt: row[3], sender: row[4], subject: row[5] }, apiRecord);
      const record = {
        receivedAt: resolved.receivedAt, sender: resolved.sender, subject: resolved.subject,
        originalName: row[6], savedName: row[7], messageId: row[10]
      };
      if (record.savedName) index.saved[String(record.savedName).normalize('NFC')] = record;
      if (record.originalName) index.original[String(record.originalName).normalize('NFC')] = record;
    });
  } catch (e) {}
  return index;
}

function _CostProfit_loadMailApiMap(caseId) {
  const map = {};
  try {
    const c = CaseList_getById(caseId);
    if (!c) return map;
    const listed = _MailAttach_fetchJson({
      caseId: c.caseId,
      clientName: c.clientName || '',
      days: typeof MAIL_ATTACH_LOOKBACK_DAYS === 'undefined' ? 90 : MAIL_ATTACH_LOOKBACK_DAYS
    }, 'cost-profit-list:' + c.caseId);
    if (!listed || !listed.ok) return map;
    (listed.body && listed.body.attachments || []).forEach(function (attachment) {
      const messageId = String(attachment && attachment.messageId || '');
      if (!messageId || map[messageId]) return;
      map[messageId] = {
        sender: attachment.sender || '', receivedAt: attachment.receivedAt || '', subject: attachment.subject || ''
      };
    });
  } catch (e) {}
  return map;
}

function _CostProfit_resolveMailRecord(logRecord, apiRecord) {
  const logged = logRecord || {};
  const api = apiRecord || {};
  return {
    sender: logged.sender || api.sender || '',
    receivedAt: logged.receivedAt || api.receivedAt || '',
    subject: logged.subject || api.subject || ''
  };
}

function _CostProfit_formatReceivedAt(value) {
  const text = String(value == null ? '' : value);
  if (!text || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) return text;
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return text;
  const jst = new Date(parsed.getTime() + 9 * 60 * 60 * 1000);
  function pad(number) { return String(number).padStart(2, '0'); }
  return jst.getUTCFullYear() + '-' + pad(jst.getUTCMonth() + 1) + '-' + pad(jst.getUTCDate()) +
    ' ' + pad(jst.getUTCHours()) + ':' + pad(jst.getUTCMinutes());
}

function _CostProfit_hyperlink(url, label) {
  return url ? '=HYPERLINK("' + String(url).replace(/"/g, '""') + '","' + label + '")' : '';
}

function _CostProfit_fileProvenance(file, mailIndex) {
  const name = String(file && (file.label || file.name) || '').normalize('NFC');
  const record = (mailIndex.saved && mailIndex.saved[name]) || (mailIndex.original && mailIndex.original[name]);
  const sender = _CostProfit_parseSender(record && record.sender);
  let fileUrl = file && file.url || '';
  if (!fileUrl && file && file.driveFileId) {
    try { fileUrl = DriveApp.getFileById(file.driveFileId).getUrl(); } catch (e) {}
  }
  const gmailUrl = record && record.messageId ? _MailAttach_gmailUrl(record.messageId) : '';
  return [sender.name, sender.email, sender.domain, record ? String(record.subject || '') : '', record ? _CostProfit_formatReceivedAt(record.receivedAt) : '', _CostProfit_hyperlink(fileUrl, '開く'), _CostProfit_hyperlink(gmailUrl, 'メール')];
}

function _CostProfit_buildFileMap(files) {
  const map = {};
  (files || []).forEach(function (file) {
    let url = file.url || '';
    if (!url && file.driveFileId) {
      try { url = DriveApp.getFileById(file.driveFileId).getUrl(); } catch (e) {}
    }
    map[String(file.label || '').normalize('NFC')] = { url: url, fileId: file.driveFileId || '' };
  });
  return map;
}

function _CostProfit_filterExcludedFiles(files, fileDecisions) {
  const excluded = {};
  (fileDecisions || []).forEach(function (d) { if (d.side === '除外') excluded[d.name] = true; });
  return (files || []).filter(function (f) { return !excluded[String(f && (f.label || f.name) || '').normalize('NFC')]; });
}

function _CostProfit_normalizeItemName(value) {
  return String(value || '').normalize('NFKC').replace(/（[^）]*）|\([^)]*\)/g, '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function _CostProfit_itemsAreNear(a, b) {
  const left = _CostProfit_normalizeItemName(a);
  const right = _CostProfit_normalizeItemName(b);
  return !!left && !!right && (left.indexOf(right) === 0 || right.indexOf(left) === 0);
}

function _CostProfit_normalizeAlternatives(costItems) {
  const items = (costItems || []).map(function (item) { return Object.assign({}, item, { alternative: false }); });
  items.forEach(function (item, index) {
    const priorMatch = items.slice(0, index).some(function (other) {
      return String(other.sourceFile || '') === String(item.sourceFile || '') &&
        Number(other.amount) === Number(item.amount) && _CostProfit_itemsAreNear(other.itemName, item.itemName);
    });
    if (priorMatch) item.alternative = true;
  });
  return items;
}

function _CostProfit_scanFiles(c) {
  const rootId = Case_resolveProjectRoot(c);
  const out = [], seen = {};
  if (!rootId) return out;
  function walk(folder, depth) {
    if (depth < 0 || out.scanTruncated) return;
    const files = folder.getFiles();
    while (files.hasNext()) {
      if (out.length >= 400) { out.scanTruncated = true; return; }
      const f = files.next(), id = f.getId();
      if (seen[id]) continue;
      seen[id] = true;
      let updated = 0;
      try { updated = f.getLastUpdated().getTime(); } catch (e) {}
      out.push({ driveFileId: id, label: String(f.getName()).normalize('NFC'), mimeType: f.getMimeType(), lastUpdated: updated });
    }
    if (depth === 0) return;
    const folders = folder.getFolders();
    while (folders.hasNext() && !out.scanTruncated) walk(folders.next(), depth - 1);
  }
  walk(DriveApp.getFolderById(rootId), 4);
  return out;
}

function _CostProfit_isSupplierCandidate(file) {
  const name = String(file && (file.label || file.name) || '').normalize('NFC');
  if (name.indexOf('_見積_') >= 0 || name.indexOf('Claude_') >= 0) return false;
  return /見積|御見積|お見積|請求|注文|発注|単価|Quotation/i.test(name) || /^(見積_|メール添付_)/.test(name);
}

function _CostProfit_selectSupplierFiles(files, caseId, maxFiles) {
  const eligible = (files || []).filter(_CostProfit_isSupplierCandidate).sort(function (a, b) {
    return (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });
  const limit = maxFiles == null ? 3 : maxFiles;
  const attached = [], tabular = [], skipped = [];
  eligible.forEach(function (f) {
    const kind = CaseMaterials_kindForMimeType(f.mimeType);
    if (_CostProfit_isTabularMime(f.mimeType)) {
      if (tabular.length < 2) tabular.push(Object.assign({}, f));
      else skipped.push(Object.assign({}, f, { skipReason: 'tabular_limit' }));
    } else if (!kind) {
      skipped.push(Object.assign({}, f, { skipReason: 'unsupported_mime' }));
    } else if (attached.length < limit) {
      attached.push({ driveFileId: f.driveFileId, label: f.label, mimeType: f.mimeType, kind: kind });
    } else {
      skipped.push(Object.assign({}, f, { skipReason: 'attachment_limit' }));
    }
  });
  return { attached: attached, tabular: tabular, skipped: skipped };
}

function _CostProfit_isTabularMime(mimeType) {
  return mimeType === 'application/vnd.google-apps.spreadsheet' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel';
}

function _CostProfit_trimText(text, limit) {
  const value = String(text == null ? '' : text);
  return value.length <= limit ? value : value.slice(0, limit) + '…(以下省略)';
}

function _CostProfit_readTabularQuote(file) {
  let temporaryId = '';
  try {
    let spreadsheetId = file.driveFileId;
    if (file.mimeType !== 'application/vnd.google-apps.spreadsheet') {
      const response = UrlFetchApp.fetch(
        'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.driveFileId) + '/copy?supportsAllDrives=true&fields=id',
        {
          method: 'post',
          headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
          contentType: 'application/json',
          payload: JSON.stringify({
            name: 'tmp_cost_profit_' + file.driveFileId,
            mimeType: 'application/vnd.google-apps.spreadsheet'
          }),
          muteHttpExceptions: true
        }
      );
      if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Drive変換失敗: ' + response.getResponseCode());
      temporaryId = JSON.parse(response.getContentText()).id;
      spreadsheetId = temporaryId;
    }
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sections = ss.getSheets().slice(0, 3).map(function (sheet) {
      const rows = Math.min(sheet.getLastRow(), 80);
      const cols = Math.min(sheet.getLastColumn(), 12);
      if (!rows || !cols) return '';
      const lines = sheet.getRange(1, 1, rows, cols).getDisplayValues().map(function (row) {
        return row.map(function (v) { return String(v || '').trim(); }).join('\t');
      }).filter(function (line) { return line.replace(/[\t\s]/g, ''); });
      return lines.length ? 'シート: ' + sheet.getName() + '\n' + lines.join('\n') : '';
    }).filter(Boolean);
    return sections.length ? _CostProfit_trimText(sections.join('\n\n'), 8000) : null;
  } catch (e) {
    return null;
  } finally {
    if (temporaryId) {
      try { DriveApp.getFileById(temporaryId).setTrashed(true); } catch (e) {}
    }
  }
}

function _CostProfit_buildSkippedConfirmations(skipped) {
  const unsupported = (skipped || []).filter(function (f) { return f.skipReason === 'unsupported_mime' || f.skipReason === 'tabular_read_failed'; });
  const limited = (skipped || []).filter(function (f) { return f.skipReason !== 'unsupported_mime' && f.skipReason !== 'tabular_read_failed'; });
  const out = unsupported.map(function (f) {
    return {
      category: '見積ファイル',
      content: '添付できない形式の見積がある: ' + f.label + '（PDFにして預かり素材へ入れてください）'
    };
  });
  if (limited.length) out.push({
    category: '見積ファイル',
    content: '件数制限で未読込の見積ファイルがある: ' + limited.map(function (f) { return f.label; }).join('、')
  });
  return out;
}

function _CostProfit_isProvisional(costItems, billItems) {
  return (billItems || []).length === 0 || ((billItems || []).length < 2 && (costItems || []).length >= 3);
}

function _CostProfit_provisionalConfirmation() {
  return { category: '粗利', content: '請求側の明細が不足しているため粗利は暫定値です（自社見積が未作成/未読込の可能性）' };
}

function _CostProfit_findLatestOwnEstimate(files, caseId) {
  return (files || []).filter(function (f) {
    return String(f.label || '').indexOf('_見積_') >= 0 &&
      String(f.label || '').indexOf('Claude_') < 0 &&
      f.mimeType === 'application/vnd.google-apps.spreadsheet';
  }).sort(function (a, b) { return (b.lastUpdated || 0) - (a.lastUpdated || 0); })[0] || null;
}

function _CostProfit_readOwnEstimate(fileId) {
  try {
    const ss = SpreadsheetApp.openById(fileId);
    const target = _Estimate_findDetailHeaderRow(ss);
    if (!target) return '自社見積なし';
    const lastRow = Math.min(target.sheet.getLastRow(), target.row + 200);
    if (lastRow <= target.row) return '自社見積なし';
    const values = target.sheet.getRange(target.row, 1, lastRow - target.row + 1, 12).getDisplayValues();
    const lines = values.map(function (row) {
      return row.slice(0, 7).concat([row[11]]).map(function (v) { return String(v || '').trim(); }).join('\t');
    }).filter(function (line) { return line.replace(/[\t\s]/g, ''); });
    return 'シート: ' + target.sheet.getName() + '\n' + lines.join('\n');
  } catch (e) { return '自社見積なし（読込失敗: ' + e.message + '）'; }
}

function _CostProfit_calculateTotals(costItems, billItems, paymentItems) {
  const costTotal = (costItems || []).reduce(function (sum, x) { return sum + (x.alternative === true ? 0 : (Number(x.amount) || 0)); }, 0);
  const candidateCostTotal = (costItems || []).reduce(function (sum, x) { return sum + (x.alternative === true ? (Number(x.amount) || 0) : 0); }, 0);
  const billTotal = (billItems || []).reduce(function (sum, x) { return sum + (Number(x.amount) || 0); }, 0);
  const paymentTotal = (paymentItems || []).reduce(function (sum, x) { return sum + (Number(x.amount) || 0); }, 0);
  const grossProfit = billTotal - costTotal;
  return { costTotal: costTotal, billTotal: billTotal, paymentTotal: paymentTotal, candidateCostTotal: candidateCostTotal, grossProfit: grossProfit, grossMarginRate: billTotal ? grossProfit / billTotal : 0 };
}

function _CostProfit_makeRows(costItems, billItems, paymentItems, fileMap) {
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  function link(source) { const found = fileMap && fileMap[String(source || '').normalize('NFC')]; return _CostProfit_hyperlink(found && found.url, '開く'); }
  const costs = (costItems || []).map(function (x) { return [stamp, x.alternative === true ? '原価(候補)' : '原価', x.supplier || '', x.itemName || '', x.spec || '', Number(x.qty) || 0, x.unit || '', Number(x.unitCost) || 0, Number(x.amount) || 0, x.sourceFile || '', x.confidence || 'low', '', link(x.sourceFile)]; });
  const bills = (billItems || []).map(function (x) { const source = x.sourceFile || x.priceSource || '未確定'; return [stamp, '請求', '', x.itemName || '', '', Number(x.qty) || 0, x.unit || '', Number(x.unitPrice) || 0, Number(x.amount) || 0, source, '', '', link(source)]; });
  const payments = (paymentItems || []).map(function (x) { return [stamp, '入金', '', x.itemName || '', '', 1, '式', Number(x.amount) || 0, Number(x.amount) || 0, x.sourceFile || '', '', '', link(x.sourceFile)]; });
  return costs.concat(bills, payments);
}

function _CostProfit_ensureSheet(ss) {
  let sheet = ss.getSheetByName(COST_PROFIT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(COST_PROFIT_SHEET_NAME);
  sheet.getRange(1, 1, 1, 8).setValues([['原価合計', '=SUMIF($B$4:$B,"原価",$I$4:$I)', '請求合計', '=SUMIF($B$4:$B,"請求",$I$4:$I)', '粗利', '=D1-B1', '粗利率', '=IFERROR(F1/D1,0)']]);
  sheet.getRange(2, 1, 1, 6).setValues([['入金合計', '=SUMIF($B$4:$B,"入金",$I$4:$I)', '原価(候補)合計', '=SUMIF($B$4:$B,"原価(候補)",$I$4:$I)', '最終更新', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')]]);
  sheet.getRange(3, 1, 1, COST_PROFIT_HEADERS.length).setValues([COST_PROFIT_HEADERS]).setFontWeight('bold').setBackground('#d9ead3');
  [140, 110, 170, 280, 240, 60, 60, 110, 110, 260, 80, 220, 90].forEach(function (width, i) { sheet.setColumnWidth(i + 1, width); });
  sheet.setFrozenRows(3);
  sheet.getRange('B1').setNumberFormat('#,##0'); sheet.getRange('D1').setNumberFormat('#,##0');
  sheet.getRange('B2').setNumberFormat('#,##0'); sheet.getRange('D2').setNumberFormat('#,##0');
  sheet.getRange('F1').setNumberFormat('#,##0'); sheet.getRange('H1').setNumberFormat('0.0%');
  return sheet;
}

function _CostProfit_rowKey(row) { return [row[1], row[2], row[3], row[9]].map(function (v) { return String(v || '').trim(); }).join('|'); }

function _CostProfit_mergeRows(sheet, incomingRows, processedSources) {
  const lastRow = sheet.getLastRow();
  const existing = lastRow >= 4 ? sheet.getRange(4, 1, lastRow - 3, 12).getValues() : [];
  const sources = (processedSources || []).map(function (source) { return String(source || '').trim(); }).filter(Boolean);
  let appended = 0, superseded = 0, untouched = 0, nextRow = Math.max(4, lastRow + 1);
  existing.forEach(function (row, i) {
    const kind = String(row[1] || '');
    const source = String(row[9] || '');
    const shouldSupersede = source && !/\(旧\)$/.test(kind) && sources.some(function (processed) { return source.indexOf(processed) >= 0; });
    if (shouldSupersede) {
      sheet.getRange(i + 4, 2, 1, 1).setValues([[kind + '(旧)']]);
      superseded++;
    } else {
      untouched++;
    }
  });
  (incomingRows || []).forEach(function (row) {
    sheet.getRange(nextRow, 1, 1, 13).setValues([row.slice(0, 13)]);
    nextRow++; appended++;
  });
  return { appended: appended, superseded: superseded, untouched: untouched, finalRow: Math.max(lastRow, nextRow - 1) };
}

/** 案件の原価粗利シートを読み取り専用で診断する。 */
function _debug_costProfitSheet(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) return { ok: false, error: '案件が見つかりません: ' + caseId };
  if (!c.zissiId) return { ok: false, error: '実施計画書がありません' };

  var zissiSs = SpreadsheetApp.openById(c.zissiId);
  var sheet = zissiSs.getSheetByName(COST_PROFIT_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'シートがありません: ' + COST_PROFIT_SHEET_NAME };

  var lastRow = sheet.getLastRow();
  var summary = sheet.getRange(1, 1, 1, 10).getDisplayValues()[0].map(function (value) {
    return String(value);
  });
  var rowCount = Math.min(40, Math.max(0, lastRow - 3));
  var values = rowCount ? sheet.getRange(4, 1, rowCount, 12).getDisplayValues() : [];
  var rows = values.map(function (value, index) {
    return {
      row: String(index + 4),
      kind: String(value[1]),
      supplier: String(value[2]),
      item: String(value[3]),
      qty: String(value[5]),
      unitPrice: String(value[7]),
      amount: String(value[8]),
      source: String(value[9]),
      confidence: String(value[10]),
      memo: String(value[11])
    };
  });
  var fileDecisionSheet = zissiSs.getSheetByName(COST_PROFIT_FILE_SHEET_NAME);
  var fileSheet = { exists: false };
  if (fileDecisionSheet) {
    var fileLastRow = fileDecisionSheet.getLastRow();
    var fileHeader = fileDecisionSheet.getRange(1, 1, 1, COST_PROFIT_FILE_HEADERS.length).getDisplayValues()[0].map(function (value) {
      return String(value);
    });
    var fileRowCount = Math.min(20, Math.max(0, fileLastRow - 1));
    var fileValues = fileRowCount ? fileDecisionSheet.getRange(2, 1, fileRowCount, COST_PROFIT_FILE_HEADERS.length).getDisplayValues() : [];
    var fileLinkFormulas = fileRowCount ? fileDecisionSheet.getRange(2, 10, fileRowCount, 1).getFormulas() : [];
    var mailLinkFormulas = fileRowCount ? fileDecisionSheet.getRange(2, 11, fileRowCount, 1).getFormulas() : [];
    fileSheet = {
      exists: true,
      header: fileHeader,
      rows: fileValues.map(function (value, index) {
        return {
          row: String(index + 2),
          name: String(value[0]),
          side: String(value[1]),
          reason: String(value[2]),
          updatedAt: String(value[3]),
          senderName: String(value[4]),
          senderMail: String(value[5]),
          domain: String(value[6]),
          subject: String(value[7]),
          receivedAt: String(value[8]),
          fileLink: String(value[9]),
          mailLink: String(value[10]),
          fileLinkFormula: String(fileLinkFormulas[index][0]),
          mailLinkFormula: String(mailLinkFormulas[index][0])
        };
      })
    };
  }
  return { ok: true, lastRow: lastRow, summary: summary, rows: rows, fileSheet: fileSheet };
}

if (typeof module !== 'undefined') module.exports = {
  _CostProfit_calculateTotals: _CostProfit_calculateTotals,
  _CostProfit_isSupplierCandidate: _CostProfit_isSupplierCandidate,
  _CostProfit_selectSupplierFiles: _CostProfit_selectSupplierFiles,
  _CostProfit_buildSkippedConfirmations: _CostProfit_buildSkippedConfirmations,
  _CostProfit_trimText: _CostProfit_trimText,
  _CostProfit_isProvisional: _CostProfit_isProvisional,
  _CostProfit_provisionalConfirmation: _CostProfit_provisionalConfirmation,
  _CostProfit_makeRows: _CostProfit_makeRows,
  _CostProfit_mergeRows: _CostProfit_mergeRows,
  _CostProfit_rowKey: _CostProfit_rowKey
  ,_CostProfit_guessSide: _CostProfit_guessSide
  ,_CostProfit_upsertFileDecisions: _CostProfit_upsertFileDecisions
  ,_CostProfit_filterExcludedFiles: _CostProfit_filterExcludedFiles
  ,_CostProfit_normalizeAlternatives: _CostProfit_normalizeAlternatives
  ,_CostProfit_parseSender: _CostProfit_parseSender
  ,_CostProfit_fileProvenance: _CostProfit_fileProvenance
  ,_CostProfit_buildFileMap: _CostProfit_buildFileMap
  ,_CostProfit_formatReceivedAt: _CostProfit_formatReceivedAt
  ,_CostProfit_resolveMailRecord: _CostProfit_resolveMailRecord
  ,_CostProfit_loadMailAttachmentIndex: _CostProfit_loadMailAttachmentIndex
};
