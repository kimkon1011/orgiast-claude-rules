/**
 * 手配物の購買依頼。Phase_AssignRequest（人のアサイン依頼）とは別機能。
 */

const PROCUREMENT_HEADERS = [
  'タイムスタンプ', '依頼者', '必着日', '品名', 'ステータス', '荷物問合せ番号', '運送会社', '手配担当者',
  '手配カテゴリ', '手配数量', '仕様/型番', '予算', '参考URL', '依頼種類', '根拠(議事録日付)', '根拠(該当発言)', '手配備考',
  '承認(kim)', '送り先', '購買依頼行', '手配依頼日時'
];
const _PROCURE_PURCHASE_SS_ID = '1Uu0bdtI9AnHVJ9325SsbGIEWxl1uk3z8e9jzp0aF2RU';
const _PROCURE_PURCHASE_SHEET = '購買依頼フォーム';
const _PROCURE_MASTER_SS_ID = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
const PROCUREMENT_APPROVAL_SHEET_NAME = 'Claude_手配物承認';
const TLDV_API_BASE = 'https://pasta.tldv.io/v1alpha1';
// Drive 経由の token 搬送を避けるためソース定数で持つ (ClientContext.js の SALES_CTX_TOKEN_DEFAULT と同じ流儀)。
// Script Property 'TLDV_API_KEY' があればそちらが優先される。
const TLDV_API_KEY_DEFAULT = '589d4c7a-5428-4225-9510-b3e435039a02';
// 逐語録の投入量。実測: 20,031字で生成に約4分半(GAS の上限は6分)。増やす時は必ず実走で時間を測ること。
const TLDV_TRANSCRIPT_TOTAL_CHARS = 20000;
const TLDV_TRANSCRIPT_PER_MEETING_CHARS = 10000;

function _Procure_tldvApiKey() {
  const configured = String(PropertiesService.getScriptProperties().getProperty('TLDV_API_KEY') || '').trim();
  const candidate = configured && configured.indexOf('__') !== 0 ? configured : TLDV_API_KEY_DEFAULT;
  return candidate && candidate.indexOf('__') !== 0 ? candidate : '';
}

function _Procure_tldvKeyword(clientName) {
  return String(clientName || '')
    .replace(/株式会社|\(株\)|（株）|㈱|様|[\s\u3000]/g, '')
    .slice(0, 8);
}

function _Procure_readTldvTranscripts(c) {
  const apiKey = _Procure_tldvApiKey();
  const keyword = _Procure_tldvKeyword(c && c.clientName);
  if (!apiKey || !keyword) return '';
  const options = { method: 'get', headers: { 'x-api-key': apiKey }, muteHttpExceptions: true };
  let listResponse;
  try {
    listResponse = UrlFetchApp.fetch(TLDV_API_BASE + '/meetings?query=' + encodeURIComponent(keyword) + '&limit=50', options);
  } catch (e) {
    return '';
  }
  if (listResponse.getResponseCode() !== 200) return '';

  let meetings;
  try {
    const parsed = JSON.parse(listResponse.getContentText());
    meetings = Array.isArray(parsed.results) ? parsed.results : [];
  } catch (e) {
    return '';
  }
  function normalize(value) {
    const text = String(value || '');
    return (text.normalize ? text.normalize('NFC') : text).toLowerCase().replace(/[\s\u3000]/g, '');
  }
  const normalizedKeyword = normalize(keyword);
  meetings = meetings.filter(function (meeting) {
    return meeting && meeting.id && normalize(meeting.name).indexOf(normalizedKeyword) >= 0;
  }).sort(function (a, b) {
    const aTime = new Date(a.happenedAt).getTime();
    const bTime = new Date(b.happenedAt).getTime();
    return (isNaN(bTime) ? 0 : bTime) - (isNaN(aTime) ? 0 : aTime);
  }).slice(0, 3);

  const cache = CacheService.getScriptCache();
  const sections = [];
  let totalChars = 0;
  meetings.forEach(function (meeting) {
    if (totalChars >= TLDV_TRANSCRIPT_TOTAL_CHARS) return;
    const cacheKey = 'tldv_transcript_' + String(meeting.id);
    let transcriptText = cache.get(cacheKey);
    if (!transcriptText) {
      let transcriptResponse;
      try {
        transcriptResponse = UrlFetchApp.fetch(TLDV_API_BASE + '/meetings/' + encodeURIComponent(meeting.id) + '/transcript', options);
      } catch (e) {
        return;
      }
      if (transcriptResponse.getResponseCode() !== 200) return;
      transcriptText = transcriptResponse.getContentText();
      try { cache.put(cacheKey, transcriptText, 21600); } catch (e) {}
    }
    let transcript;
    try {
      transcript = JSON.parse(transcriptText);
    } catch (e) {
      return;
    }
    if (!Array.isArray(transcript.data) || !transcript.data.length) return;
    const date = new Date(meeting.happenedAt);
    const dateText = isNaN(date.getTime()) ? '' : Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
    const lines = [];
    transcript.data.forEach(function (part) {
      const speaker = String(part && part.speaker || '').trim() || '話者不明';
      const text = String(part && part.text || '').trim();
      if (!text) return;
      const prefix = speaker + ': ';
      if (lines.length && lines[lines.length - 1].speaker === speaker) {
        lines[lines.length - 1].text += ' ' + text;
      } else {
        lines.push({ speaker: speaker, text: prefix + text });
      }
    });
    if (!lines.length) return;
    const section = '【tl;dv議事録 ' + String(meeting.name || '') + ' ' + dateText + '】\n' +
      lines.map(function (line) { return line.text; }).join('\n');
    // 会議単位で丸ごと落とすと、短い直近会議が先に枠を埋めて
    // 肝心の長い会議(実測: MTG3 が 24,515字)が全部消える。必ず会議ごとに切る。
    const separatorChars = sections.length ? 2 : 0;
    const remaining = TLDV_TRANSCRIPT_TOTAL_CHARS - totalChars - separatorChars;
    if (remaining <= 0) return;
    const allowed = Math.min(TLDV_TRANSCRIPT_PER_MEETING_CHARS, remaining);
    const clipped = section.length > allowed ? section.slice(0, allowed) : section;
    sections.push(clipped);
    totalChars += separatorChars + clipped.length;
  });
  return sections.join('\n\n');
}

function _Procure_readMeetingTranscripts(zissiSs) {
  const meetingSheet = zissiSs.getSheetByName('議事録');
  if (!meetingSheet) return '';
  const lastRow = Math.min(meetingSheet.getLastRow(), 1500);
  const lastColumn = Math.min(meetingSheet.getLastColumn(), 20);
  if (!lastRow || !lastColumn) return '';
  const body = meetingSheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues().map(function (row) {
    return row.join(' ').replace(/[ \t\u3000]+/g, ' ').trim();
  }).join('\n').trim();
  if (!body) return '';
  return '【実施計画書「議事録」シートの逐語録(末尾20,000字)】\n' + body.slice(-20000);
}

function Phase_ProcurementRequest_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const zissiSs = _Procure_openZissi(c);
  const sheet = _Procure_itemSheet(zissiSs);
  const clientContext = Case_loadClientContext(c) || '';
  if (!clientContext) {
    throw new Error('議事録・メールが取得できないため根拠付きの手配物リストを作れません。先に「📥 最新の打合せ・メールを取り込む」を実行してください');
  }

  const master = _Procure_readMaster(c);
  const existingItems = Zissi_readExistingItemList(zissiSs).items;
  const proposalItems = _Procure_readProposal(zissiSs);
  const cachedContext = [clientContext, OwnedEquipment_describe()];
  const tldvTranscripts = _Procure_readTldvTranscripts(c);
  const meetingTranscripts = tldvTranscripts || _Procure_readMeetingTranscripts(zissiSs);
  const transcriptSource = tldvTranscripts ? 'tldv' : (meetingTranscripts ? 'zissi-sheet' : 'none');
  if (meetingTranscripts) cachedContext.push(meetingTranscripts);
  if (existingItems.length) {
    cachedContext.push('【既存アイテムリスト】\n' + existingItems.map(function (x) { return x.name; }).join('\n'));
  }
  if (proposalItems.length) {
    cachedContext.push('【Claude_アイテムリスト提案 A〜D】\n' + proposalItems.map(function (x) {
      return [x.category, x.name, x.quantity, x.spec].join(' / ');
    }).join('\n'));
  }
  const userMessage = [
    '以下の展示会案件で、新規に購入・手配する必要がある物だけを抽出し、JSONのみを返してください。',
    '', '## 案件情報',
    '- クライアント: ' + (c.clientName || '未確定'),
    '- 案件名: ' + (c.caseName || '未確定'),
    '- 会場: ' + (master.venue || '未確定'),
    '- 設営日: ' + (master.setupDate || '未確定'),
    '- 開催日程: ' + (master.eventDates || '未確定'),
    '- 依頼者: ' + (master.requester || '未確定'),
    '', '## 出力形式',
    '{"items":[{"category":"備品","name":"…","spec":"…","quantity":2,"budget":"","reference_url":"","required_by":"2026-09-05","note":"","evidence_date":"2026-08-17","evidence_quote":"議事録/メールの原文からそのままコピーした1文"}],"confirmations":[{"category":"…","content":"…"}]}',
    '', '## 必須ルール',
    '- 保有機材と既存アイテムリストで賄える物は出さない。新規に買う必要がある物だけにする。',
    '- **evidence_date と evidence_quote は必須**。どちらか一方でも書けない品目は items に入れてはいけない(その品目は捨てる)。',
    '- evidence_date は cachedContext 内の日付表記から取る。例: 「【メール 2026-08-17 …】」の 2026-08-17、議事録の日付見出し、「9月8日(2日目)13時に…」のような本文中の日付。YYYY-MM-DD 形式にする。年が判らない場合は案件の出展年を補って構わない。',
    '- evidence_quote は cachedContext の**原文から抜き出した1文をそのままコピー**する。要約・言い換え・自分の言葉での説明は禁止。',
    '- cachedContext には打合せの**逐語録**が含まれる。発言の中に出てくる「買う必要がある物」(印刷物・シール・シート・部材・什器・消耗品など)も必ず拾うこと。',
    '- 逐語録には会議名と日付の見出し(【tl;dv議事録 …】)が付いている。evidence_date はその見出しの日付を使うこと。',
    '- 逐語録から拾った場合、evidence_quote には**その発言をそのまま**コピーし、evidence_date は逐語録中の日付(例「7/6」「8/4」)を YYYY-MM-DD に補って書くこと。年が無ければ案件の出展年を補ってよい。',
    '- 根拠になる記述が cachedContext に無い品目は、必要そうに見えても出さない。推測や一般論で品目を足さない。',
    '- required_by は本番・設営日から逆算し、YYYY-MM-DD で必ず埋める。',
    '- 単価・予算は未確定でもよく、budget は空でよい。確認シートで生成を止めない。',
    '- spec は型番・サイズ・色まで判る場合だけ書き、判らなければ空にする。'
  ].join('\n');
  const res = ClaudeClient_call({ cachedContext: cachedContext, userMessage: userMessage, maxTokens: 8000 });
  const parsed = _Phase1_parseJson(res.text);
  if (!Array.isArray(parsed.items)) throw new Error('手配物生成の応答をJSONとして読めませんでした。再実行してください');

  const cols = _Procure_resolveColumns(sheet);
  const existingNames = existingItems.map(function (x) { return _Procure_normalizeItemName(x.name); }).filter(Boolean);
  const blockKeys = _Procure_existingBlockKeys(sheet, cols);
  let droppedNoEvidence = 0;
  let droppedExisting = 0;
  let droppedDuplicate = 0;
  const accepted = [];
  const droppedSamples = [];
  parsed.items.forEach(function (item) {
    const source = item && item.evidence ? item.evidence : (item || {});
    const evidence = {
      date: String((item && item.evidence_date) || source.date || '').trim(),
      quote: String((item && item.evidence_quote) || source.quote || '').trim()
    };
    if (item) item.evidence = evidence;
    const name = String(item && item.name || '').trim();
    if (!name || !evidence.date || !evidence.quote) {
      droppedNoEvidence++;
      if (droppedSamples.length < 10) droppedSamples.push({ name: name, reason: '根拠不足', date: evidence.date, quote: evidence.quote.slice(0, 40) });
      return;
    }
    const normalized = _Procure_normalizeItemName(name);
    const isExisting = existingNames.some(function (existing) {
      if (normalized === existing) return true;
      return Math.min(normalized.length, existing.length) >= 4 && (normalized.indexOf(existing) >= 0 || existing.indexOf(normalized) >= 0);
    });
    if (isExisting) {
      droppedExisting++;
      if (droppedSamples.length < 10) droppedSamples.push({ name: name, reason: '既存アイテムリストにあり' });
      return;
    }
    const key = normalized + '\n' + _Procure_normalizeItemName(item.spec);
    if (blockKeys[key]) {
      droppedDuplicate++;
      if (droppedSamples.length < 10) droppedSamples.push({ name: name, reason: '手配物ブロックに同一品あり' });
      return;
    }
    blockKeys[key] = true;
    accepted.push(item);
  });

  const written = [];
  const usedRows = new Set();
  let retriedRows = 0;
  accepted.forEach(function (item) {
    const evidence = item.evidence || {};
    const name = String(item.name || '').trim();
    const requiredBy = String(item.required_by || '').trim();
    const quote = String(evidence.quote || '').trim();
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = _Procure_pickWritableRow(sheet, cols, usedRows);
      sheet.getRange(row, 6).setValue(name);
      sheet.getRange(row, 9).setValue(item.quantity == null ? '' : item.quantity);
      sheet.getRange(row, 16).setValue('手配物(購買部依頼) / 根拠: ' + String(evidence.date) + ' ' + quote.slice(0, 60));
      _Procure_set(sheet, row, cols, '品名', name);
      _Procure_set(sheet, row, cols, '手配カテゴリ', item.category || '');
      _Procure_set(sheet, row, cols, '手配数量', item.quantity == null ? '' : item.quantity);
      _Procure_set(sheet, row, cols, '仕様/型番', item.spec || '');
      _Procure_set(sheet, row, cols, '予算', item.budget == null ? '' : item.budget);
      _Procure_set(sheet, row, cols, '参考URL', item.reference_url || '');
      _Procure_set(sheet, row, cols, '依頼種類', _Procure_requestType(item.reference_url, item.spec));
      _Procure_set(sheet, row, cols, '根拠(議事録日付)', evidence.date);
      _Procure_set(sheet, row, cols, '根拠(該当発言)', quote);
      _Procure_set(sheet, row, cols, '手配備考', item.note || '');
      _Procure_set(sheet, row, cols, '送り先', _Procure_defaultDestination(c, master.venue));
      _Procure_set(sheet, row, cols, '必着日', requiredBy);
      _Procure_set(sheet, row, cols, '依頼者', master.requester || 'ブース制作アプリ(自動)');
      _Procure_set(sheet, row, cols, 'ステータス', '未承認');
      sheet.getRange(row, cols['承認(kim)']).insertCheckboxes().setValue(false);
      SpreadsheetApp.flush();
      const readItemName = String(sheet.getRange(row, 6).getValue() || '');
      const readProcurementName = String(sheet.getRange(row, cols['品名']).getValue() || '');
      if (readItemName === name && readProcurementName === name) {
        written.push({ row: row, name: name, requiredBy: requiredBy, item: item });
        return;
      }
      usedRows.add(row);
      const clearColumns = [6, 9, 16, cols['品名'], cols['手配カテゴリ'], cols['手配数量'], cols['仕様/型番'], cols['予算'], cols['参考URL'], cols['依頼種類'], cols['根拠(議事録日付)'], cols['根拠(該当発言)'], cols['手配備考'], cols['送り先'], cols['必着日'], cols['依頼者'], cols['ステータス'], cols['承認(kim)']];
      const cleared = {};
      clearColumns.forEach(function (col) {
        if (!cleared[col]) sheet.getRange(row, col).setValue('');
        cleared[col] = true;
      });
      if (attempt < 4) retriedRows++;
    }
    droppedSamples.push({ name: name, reason: '書き込み不可(結合セル等)' });
  });

  const protectionWarning = _Procure_protectApproval(sheet, cols['承認(kim)']);
  SpreadsheetApp.flush();
  const verifiedWritten = [];
  written.forEach(function (x) {
    const readName = String(sheet.getRange(x.row, cols['品名']).getValue() || '');
    const readDate = sheet.getRange(x.row, cols['必着日']).getValue();
    if (readName !== x.name || !_Procure_sameDate(readDate, x.requiredBy)) {
      droppedSamples.push({ name: x.name, row: x.row, reason: '書き込み確認失敗' });
      return;
    }
    verifiedWritten.push(x);
  });
  written.length = 0;
  Array.prototype.push.apply(written, verifiedWritten);

  const itemListUrl = 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + zissiSs.getId() + '/edit#gid=' + sheet.getSheetId();
  const approvalSheet = _Procure_rebuildApprovalSheet(zissiSs, sheet, cols);
  const approvalMessage = _Procure_approvalMessage(c, written, approvalSheet.url);
  const approvers = PropertiesService.getScriptProperties().getProperty('PROCUREMENT_APPROVERS') || 'kim@orgiast.jp';
  const notify = written.length
    ? _Procure_notifyApproval(c, approvalMessage)
    : { mailSent: false, discordSent: false, to: approvers.split(',').map(function (x) { return x.trim(); }).filter(Boolean).join(',') };
  const discordSent = notify.discordSent;
  const confirmations = Array.isArray(parsed.confirmations) ? parsed.confirmations : [];
  let confirmationCount = 0;
  if (confirmations.length) {
    const tagged = confirmations.map(function (x) {
      if (typeof x === 'string') return { category: '[手配物]', content: x };
      return { category: '[手配物] ' + (x.category || ''), content: x.content || '' };
    });
    confirmationCount = ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, '手配物リスト', '手配物リスト ' + written.length + '件', itemListUrl);
  return {
    itemListUrl: itemListUrl, approvalSheetUrl: approvalSheet.url, sheetName: 'アイテムリスト', writtenCount: written.length,
    droppedNoEvidence: droppedNoEvidence, droppedExisting: droppedExisting, droppedDuplicate: droppedDuplicate,
    droppedSamples: droppedSamples, generatedCount: parsed.items.length, retriedRows: retriedRows,
    approvalMessage: approvalMessage, notify: notify, discordSent: discordSent, protectionWarning: protectionWarning,
    confirmationCount: confirmationCount, transcriptChars: meetingTranscripts.length, transcriptSource: transcriptSource, usage: res.usage,
    panelStatus: '✅ 手配物 ' + written.length + '件をアイテムリストに追記しました。kim の承認待ちです'
  };
}

function Phase_ProcurementRequest_requestApproval(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const zissiSs = _Procure_openZissi(c);
  const sheet = _Procure_itemSheet(zissiSs);
  const cols = _Procure_findColumns(sheet);
  if (!cols || PROCUREMENT_HEADERS.some(function (h) { return !cols[h]; })) {
    throw new Error('先に「🧾 手配物リストを作る」を実行してください');
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const displayValues = lastRow >= 3 ? sheet.getRange(3, 1, lastRow - 2, lastColumn).getDisplayValues() : [];
  const values = lastRow >= 3 ? sheet.getRange(3, 1, lastRow - 2, lastColumn).getValues() : [];
  const pending = [];
  displayValues.forEach(function (displayRow, i) {
    const status = String(displayRow[cols['ステータス'] - 1] || '').trim();
    const name = String(displayRow[cols['品名'] - 1] || '').trim();
    if (!name || (status !== '未承認' && status !== '承認済')) return;
    const rawRow = values[i];
    pending.push({
      name: name,
      requiredBy: String(displayRow[cols['必着日'] - 1] || '').trim(),
      item: {
        quantity: displayRow[cols['手配数量'] - 1],
        budget: displayRow[cols['予算'] - 1],
        evidence: {
          date: String(displayRow[cols['根拠(議事録日付)'] - 1] || '').trim(),
          quote: String(displayRow[cols['根拠(該当発言)'] - 1] || '').trim()
        },
        approved: rawRow[cols['承認(kim)'] - 1] === true
      }
    });
  });
  const itemListUrl = 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + zissiSs.getId() + '/edit#gid=' + sheet.getSheetId();
  const approvalSheet = _Procure_rebuildApprovalSheet(zissiSs, sheet, cols);
  if (!pending.length) return { pendingCount: 0, sent: false, approvalSheetUrl: approvalSheet.url };

  const approvalMessage = _Procure_approvalMessage(c, pending, approvalSheet.url);
  const notify = _Procure_notifyApproval(c, approvalMessage);
  return { pendingCount: pending.length, notify: notify, approvalMessage: approvalMessage, itemListUrl: itemListUrl, approvalSheetUrl: approvalSheet.url };
}

function Phase_ProcurementRequest_openApproval(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const zissiSs = _Procure_openZissi(c);
  const itemSheet = _Procure_itemSheet(zissiSs);
  const cols = _Procure_findColumns(itemSheet);
  if (!cols || PROCUREMENT_HEADERS.some(function (h) { return !cols[h]; })) {
    throw new Error('先に「🧾 手配物リストを作る」を実行してください');
  }
  const approvalSheet = _Procure_rebuildApprovalSheet(zissiSs, itemSheet, cols);
  return { approvalSheetUrl: approvalSheet.url, pendingCount: approvalSheet.rowCount };
}

function Phase_ProcurementRequest_submit(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const zissiSs = _Procure_openZissi(c);
  const itemSheet = _Procure_itemSheet(zissiSs);
  const cols = _Procure_findColumns(itemSheet);
  if (!cols || PROCUREMENT_HEADERS.some(function (h) { return !cols[h]; })) {
    throw new Error('先に「🧾 手配物リストを作る」を実行してください');
  }
  const approvalSync = _Procure_syncApprovalFromSheet(zissiSs, itemSheet, cols);
  const master = _Procure_readMaster(c);
  const purchaseSheet = SpreadsheetApp.openById(_PROCURE_PURCHASE_SS_ID).getSheetByName(_PROCURE_PURCHASE_SHEET);
  if (!purchaseSheet) throw new Error('購買依頼フォームが見つかりません。購買部にシート名を確認してください');

  const duplicateKeys = {};
  if (purchaseSheet.getLastRow() >= 3) {
    purchaseSheet.getRange(3, 4, purchaseSheet.getLastRow() - 2, 12).getDisplayValues().forEach(function (row) {
      duplicateKeys[_Procure_purchaseKey(row[0], row[3], row[11])] = true;
    });
  }
  const implementationPlanName = master.implementationPlanName || zissiSs.getName();
  const codeMatch = implementationPlanName.match(/(\d{6}[A-Z]{3})/);
  const projectCode = codeMatch ? codeMatch[1] : _AssignSheet_projectCode(master.eventDates || c.startDate, c.startDate, c.clientName).code;
  const zissiUrl = 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + zissiSs.getId() + '/edit';
  let sentCount = 0;
  let skippedAlreadySent = 0;
  let skippedDuplicateInSheet = 0;
  let skippedNotApproved = 0;
  const sentRows = [];
  const errors = [];
  const lastRow = itemSheet.getLastRow();
  const lastColumn = itemSheet.getLastColumn();
  const itemDisplayValues = lastRow >= 3 ? itemSheet.getRange(3, 1, lastRow - 2, lastColumn).getDisplayValues() : [];
  const itemValues = lastRow >= 3 ? itemSheet.getRange(3, 1, lastRow - 2, lastColumn).getValues() : [];

  function displayValue(row, header) { return itemDisplayValues[row - 3][cols[header] - 1]; }
  function rawValue(row, header) { return itemValues[row - 3][cols[header] - 1]; }
  function updateLocal(row, header, value) {
    itemDisplayValues[row - 3][cols[header] - 1] = value;
    itemValues[row - 3][cols[header] - 1] = value;
  }

  for (let row = 3; row <= lastRow; row++) {
    const itemName = String(displayValue(row, '品名') || '').trim();
    if (!itemName) continue;
    const status = String(displayValue(row, 'ステータス') || '');
    const approved = rawValue(row, '承認(kim)') === true;
    if (status === '手配依頼済') { skippedAlreadySent++; continue; }
    if (!approved) { skippedNotApproved++; continue; }
    if (status === '未承認') {
      itemSheet.getRange(row, cols['ステータス']).setValue('承認済');
      updateLocal(row, 'ステータス', '承認済');
    }

    const spec = String(displayValue(row, '仕様/型番') || '').trim();
    const purchaseItem = itemName + (spec ? ' / ' + spec : '');
    let requester = String(displayValue(row, '依頼者') || '').trim();
    requester = requester || master.requester || 'ブース制作アプリ(自動)';
    let deadline = _Procure_formatDate(rawValue(row, '必着日'));
    if (!deadline) deadline = _Procure_offsetDate(master.setupDate, -3);
    if (!deadline) deadline = _Procure_offsetDate(c.startDate, -7);
    if (!deadline) {
      errors.push({ itemRow: row, itemName: itemName, error: '必着日を確定できないため送信しませんでした' });
      continue;
    }
    const duplicateKey = _Procure_purchaseKey(requester, purchaseItem, deadline);
    if (duplicateKeys[duplicateKey]) {
      skippedDuplicateInSheet++;
      itemSheet.getRange(row, cols['ステータス']).setValue('手配依頼済');
      updateLocal(row, 'ステータス', '手配依頼済');
      continue;
    }

    const referenceUrl = String(displayValue(row, '参考URL') || '').trim();
    let requestType = String(displayValue(row, '依頼種類') || '').trim();
    if (['発注依頼(指定品)', '購入(安値調査込)'].indexOf(requestType) < 0) requestType = _Procure_requestType(referenceUrl, spec);
    const destinationCell = String(displayValue(row, '送り先') || '').trim();
    const destination = destinationCell || _Procure_defaultDestination(c, master.venue);
    const note = String(displayValue(row, '手配備考') || '').trim();
    const evidenceDate = String(displayValue(row, '根拠(議事録日付)') || '').trim();
    const evidenceQuote = String(displayValue(row, '根拠(該当発言)') || '').trim();
    const timestamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    const special = [note, '【根拠】' + evidenceDate + ' ' + evidenceQuote, '【案件】' + (c.clientName || '') + ' / ' + (c.caseName || '')].filter(function (x) { return x; }).join('\n');
    const row15 = [
      '', '', timestamp, requester, referenceUrl, requestType, purchaseItem,
      displayValue(row, '予算'), special, zissiUrl,
      '', '', destination, projectCode, deadline
    ];
    purchaseSheet.appendRow(row15);
    const purchaseRow = purchaseSheet.getLastRow();
    SpreadsheetApp.flush();
    const read = purchaseSheet.getRange(purchaseRow, 1, 1, 15).getDisplayValues()[0];
    if (!read[2] || !read[3] || !read[6] || !read[14] ||
        !_Procure_sameDate(read[2], timestamp) || read[3] !== requester ||
        read[6] !== purchaseItem || !_Procure_sameDate(read[14], deadline)) {
      errors.push({ itemRow: row, purchaseRow: purchaseRow, itemName: itemName, error: '購買依頼行のread-back確認に失敗しました' });
      continue;
    }
    itemSheet.getRange(row, cols['タイムスタンプ']).setValue(timestamp);
    itemSheet.getRange(row, cols['ステータス']).setValue('手配依頼済');
    itemSheet.getRange(row, cols['購買依頼行']).setValue(purchaseRow);
    itemSheet.getRange(row, cols['手配依頼日時']).setValue(timestamp);
    updateLocal(row, 'タイムスタンプ', timestamp);
    updateLocal(row, 'ステータス', '手配依頼済');
    updateLocal(row, '購買依頼行', purchaseRow);
    updateLocal(row, '手配依頼日時', timestamp);
    if (!rawValue(row, '依頼者')) {
      itemSheet.getRange(row, cols['依頼者']).setValue(requester);
      updateLocal(row, '依頼者', requester);
    }
    if (!rawValue(row, '必着日')) {
      itemSheet.getRange(row, cols['必着日']).setValue(deadline);
      updateLocal(row, '必着日', deadline);
    }
    SpreadsheetApp.flush();
    // ローカル配列ではなくシートの実値を読み直す (setValue の silent ignore 検出)
    if (String(itemSheet.getRange(row, cols['ステータス']).getValue()) !== '手配依頼済') {
      throw new Error('アイテムリストの送信済み状態を確認できませんでした。行' + row + 'を確認してください');
    }
    duplicateKeys[duplicateKey] = true;
    sentCount++;
    sentRows.push({ itemRow: row, purchaseRow: purchaseRow, itemName: itemName, deadline: deadline });
  }

  CaseList_touchUpdatedAt(caseId);
  const purchaseSheetUrl = 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + _PROCURE_PURCHASE_SS_ID + '/edit#gid=649427183';
  MasterWriteBack_recordArtifact(caseId, '購買部手配依頼', '手配依頼 ' + sentCount + '件', purchaseSheetUrl);
  const skipCount = skippedAlreadySent + skippedDuplicateInSheet + skippedNotApproved;
  const approvalSheet = _Procure_rebuildApprovalSheet(zissiSs, itemSheet, cols);
  return {
    sentCount: sentCount, sentRows: sentRows, skippedAlreadySent: skippedAlreadySent,
    skippedDuplicateInSheet: skippedDuplicateInSheet, skippedNotApproved: skippedNotApproved,
    errors: errors, purchaseSheetUrl: purchaseSheetUrl, approvalSync: approvalSync, approvalSheetUrl: approvalSheet.url,
    panelStatus: '✅ 購買部へ ' + sentCount + '件 手配依頼しました（skip ' + skipCount + '件）'
  };
}

function _Procure_quickTitle(url) {
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return '';
    var match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(response.getContentText());
    if (!match) return '';
    return String(match[1] || '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ').trim().replace(/\s*(?:-|–|—|｜|\|)\s*(?:Amazon(?:\.co\.jp)?|モノタロウ).*$/i, '').slice(0, 60);
  } catch (e) { return ''; }
}

function Phase_ProcurementRequest_quickSubmit(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  // _JobQueue_currentPanel() はジョブ実行中しか正しい名前を返さない (既定は旧共有パネル名)。
  // コマンドキューやテストから呼ぶと別案件のシートを掴むので、G4 の caseId で必ず照合する。
  var panel = _PanelPending_panelForCase(SpreadsheetApp.openById(_PANEL_MASTER_SS), caseId);
  if (!panel) throw new Error('この案件の実行パネルが見つかりません: ' + caseId);
  var pasted = PanelPurchase_read(panel);
  if (!pasted) throw new Error('パネル下部の「🛒 買う物の URL と個数をここに貼る」欄に、1行1品で URL と個数を貼ってから ▶ を押してください');
  var parsed = PanelPurchase_parseLines(pasted);
  if (!parsed.items.length) throw new Error('手配物を読み取れませんでした: ' + parsed.errors.map(function (x) { return x.line + '（' + x.reason + '）'; }).join(' / '));

  var fetched = 0;
  parsed.items.forEach(function (item) {
    if (item.name) return;
    var title = '';
    if (item.url && fetched < 10) { fetched++; title = _Procure_quickTitle(item.url); }
    item.name = title || 'URL指定品（品名未取得）';
  });
  var zissiSs = _Procure_openZissi(c), itemSheet = _Procure_itemSheet(zissiSs), cols = _Procure_resolveColumns(itemSheet);
  var usedRows = new Set(), written = [], writeErrors = [];
  var requester = 'ブース制作アプリ(パネル入力)';
  try { requester = Session.getActiveUser().getEmail() || requester; } catch (e) {}
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  parsed.items.forEach(function (item) {
    var row = _Procure_pickWritableRow(itemSheet, cols, usedRows);
    try {
      _Procure_set(itemSheet, row, cols, '品名', item.name);
      _Procure_set(itemSheet, row, cols, '仕様/型番', '');
      _Procure_set(itemSheet, row, cols, '手配数量', item.quantity);
      _Procure_set(itemSheet, row, cols, '参考URL', item.url);
      _Procure_set(itemSheet, row, cols, '予算', item.budget);
      if (item.requiredBy) _Procure_set(itemSheet, row, cols, '必着日', item.requiredBy);
      _Procure_set(itemSheet, row, cols, '依頼者', requester);
      _Procure_set(itemSheet, row, cols, '根拠(議事録日付)', today);
      _Procure_set(itemSheet, row, cols, '根拠(該当発言)', '実行パネルで指定: ' + item.raw.slice(0, 100));
      _Procure_set(itemSheet, row, cols, '手配備考', '実行パネルの🛒欄から登録');
      _Procure_set(itemSheet, row, cols, '依頼種類', _Procure_requestType(item.url, ''));
      _Procure_set(itemSheet, row, cols, 'ステータス', '承認済');
      itemSheet.getRange(row, cols['承認(kim)']).insertCheckboxes().setValue(true);
      written.push({ row: row, item: item });
    } catch (e) {
      writeErrors.push({ line: item.raw, itemRow: row, error: String(e) });
      try { itemSheet.getRange(row, cols['承認(kim)']).setValue(false); } catch (ignored) {}
    }
  });
  SpreadsheetApp.flush();
  written = written.filter(function (entry) {
    var read = itemSheet.getRange(entry.row, 1, 1, itemSheet.getLastColumn()).getDisplayValues()[0];
    if (String(read[cols['品名'] - 1] || '').trim() === entry.item.name && String(read[cols['ステータス'] - 1] || '').trim() === '承認済') return true;
    writeErrors.push({ line: entry.item.raw, itemRow: entry.row, error: 'アイテムリストのread-back確認に失敗しました' });
    itemSheet.getRange(entry.row, cols['承認(kim)']).setValue(false);
    return false;
  });
  SpreadsheetApp.flush();

  var submit = Phase_ProcurementRequest_submit(caseId);
  var retryLines = parsed.errors.map(function (x) { return x.line; }).concat(writeErrors.map(function (x) { return x.line; })).filter(function (x) { return x; });
  if (retryLines.length) {
    var purchaseRow = PanelPurchase_findSection(panel);
    if (purchaseRow >= 0) panel.getRange(purchaseRow + 1, 3).setValue(retryLines.join('\n'));
  } else PanelPurchase_clear(panel);
  SpreadsheetApp.flush();
  var problemCount = parsed.errors.length + writeErrors.length + (submit.errors || []).length;
  return {
    registered: written.length, sentCount: submit.sentCount,
    skippedAlreadySent: submit.skippedAlreadySent, skippedDuplicateInSheet: submit.skippedDuplicateInSheet,
    skippedNotApproved: submit.skippedNotApproved, parseErrors: parsed.errors, writeErrors: writeErrors,
    submitErrors: submit.errors, purchaseSheetUrl: submit.purchaseSheetUrl,
    itemListUrl: PanelLinks_sheetUrl(zissiSs, itemSheet),
    panelStatus: '✅ 購買部へ ' + submit.sentCount + '件 手配依頼しました' + (problemCount ? '（要確認 ' + problemCount + '件）' : '')
  };
}

function Phase_ProcurementRequest_debugRows(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const sheet = _Procure_itemSheet(_Procure_openZissi(c));
  const cols = _Procure_findColumns(sheet);
  if (!cols || PROCUREMENT_HEADERS.some(function (h) { return !cols[h]; })) return [];
  const out = [];
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const displayValues = lastRow >= 3 ? sheet.getRange(3, 1, lastRow - 2, lastColumn).getDisplayValues() : [];
  const values = lastRow >= 3 ? sheet.getRange(3, 1, lastRow - 2, lastColumn).getValues() : [];
  for (let row = 3; row <= lastRow; row++) {
    const displayRow = displayValues[row - 3];
    const valueRow = values[row - 3];
    const name = displayRow[cols['品名'] - 1];
    if (!name) continue;
    out.push({
      row: row, '品名': name, 'ステータス': displayRow[cols['ステータス'] - 1],
      '承認': valueRow[cols['承認(kim)'] - 1], '必着日': displayRow[cols['必着日'] - 1],
      'タイムスタンプ': displayRow[cols['タイムスタンプ'] - 1], '購買依頼行': displayRow[cols['購買依頼行'] - 1]
    });
  }
  return out;
}

function _test_procurementSubmitRoundTrip(caseId) {
  const testItemName = '【接続テスト・無視してください】ブース制作アプリ疎通確認';
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const itemSheet = _Procure_itemSheet(_Procure_openZissi(c));
  const cols = _Procure_resolveColumns(itemSheet);
  const testRow = _Procure_pickWritableRow(itemSheet, cols, new Set());
  const purchaseSheet = SpreadsheetApp.openById(_PROCURE_PURCHASE_SS_ID).getSheetByName(_PROCURE_PURCHASE_SHEET);
  if (!purchaseSheet) throw new Error('購買依頼フォームが見つかりません。購買部にシート名を確認してください');
  const purchaseLastRowBefore = purchaseSheet.getLastRow();
  const today = new Date();
  const deadlineDate = new Date(today.getTime());
  deadlineDate.setDate(deadlineDate.getDate() + 30);
  const todayText = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy/MM/dd');
  const deadlineText = Utilities.formatDate(deadlineDate, 'Asia/Tokyo', 'yyyy/MM/dd');
  let first = null;
  let second = null;
  let purchaseRow = null;
  let readBack = null;
  let cleaned = false;

  try {
    itemSheet.getRange(testRow, 6).setValue(testItemName);
    _Procure_set(itemSheet, testRow, cols, '品名', testItemName);
    _Procure_set(itemSheet, testRow, cols, '仕様/型番', 'TEST');
    _Procure_set(itemSheet, testRow, cols, '手配数量', 1);
    _Procure_set(itemSheet, testRow, cols, '必着日', deadlineText);
    _Procure_set(itemSheet, testRow, cols, '依頼者', 'ブース制作アプリ(接続テスト)');
    _Procure_set(itemSheet, testRow, cols, '根拠(議事録日付)', todayText);
    _Procure_set(itemSheet, testRow, cols, '根拠(該当発言)', '接続テスト');
    _Procure_set(itemSheet, testRow, cols, '手配備考', '自動テスト行。購買部への行は即削除されます');
    _Procure_set(itemSheet, testRow, cols, 'ステータス', '承認済');
    itemSheet.getRange(testRow, cols['承認(kim)']).insertCheckboxes().setValue(true);
    SpreadsheetApp.flush();

    first = Phase_ProcurementRequest_submit(caseId);
    second = Phase_ProcurementRequest_submit(caseId);
    const sent = first.sentRows.filter(function (row) { return row.itemName === testItemName; })[0];
    if (sent) {
      purchaseRow = sent.purchaseRow;
      readBack = purchaseSheet.getRange(purchaseRow, 1, 1, 15).getDisplayValues()[0];
    }
  } finally {
    try {
      if (!purchaseRow && purchaseSheet.getLastRow() > purchaseLastRowBefore) {
        const added = purchaseSheet.getRange(purchaseLastRowBefore + 1, 1, purchaseSheet.getLastRow() - purchaseLastRowBefore, 15).getDisplayValues();
        for (let i = added.length - 1; i >= 0; i--) {
          if (String(added[i][6] || '').indexOf(testItemName) === 0) {
            purchaseRow = purchaseLastRowBefore + 1 + i;
            readBack = added[i];
            break;
          }
        }
      }
      if (purchaseRow) purchaseSheet.deleteRow(purchaseRow);
    } finally {
      itemSheet.getRange(testRow, 6).setValue('');
      PROCUREMENT_HEADERS.forEach(function (header) {
        itemSheet.getRange(testRow, cols[header]).setValue(header === '承認(kim)' ? false : '');
      });
      SpreadsheetApp.flush();
      cleaned = true;
    }
  }

  const readBackCDGO = {
    timestamp: readBack ? readBack[2] : '', requester: readBack ? readBack[3] : '',
    item: readBack ? readBack[6] : '', deadline: readBack ? readBack[14] : ''
  };
  return {
    testRow: testRow, purchaseRow: purchaseRow, readBackCDGO: readBackCDGO,
    allFourFilled: Object.keys(readBackCDGO).every(function (key) { return Boolean(readBackCDGO[key]); }),
    firstSent: first.sentCount, firstErrors: first.errors, secondSent: second.sentCount,
    secondSkippedAlreadySent: second.skippedAlreadySent, cleaned: cleaned
  };
}

const QUICK_TEST_MARK = '【接続テスト・無視してください】ブース制作アプリ🛒疎通確認';
function _test_procurementQuickRoundTrip(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const panel = _PanelPending_panelForCase(SpreadsheetApp.openById(_PANEL_MASTER_SS), caseId);
  if (!panel) throw new Error('この案件の実行パネルが見つかりません: ' + caseId);
  const purchaseSectionRow = PanelPurchase_findSection(panel);
  if (purchaseSectionRow < 0) {
    throw new Error('🛒 入力欄がありません。先に Panel_rebuildCasePanel を実行してください');
  }
  const inputRange = panel.getRange(purchaseSectionRow + 1, 3);
  const originalPasted = inputRange.getValue();
  const purchaseSheet = SpreadsheetApp.openById(_PROCURE_PURCHASE_SS_ID).getSheetByName(_PROCURE_PURCHASE_SHEET);
  if (!purchaseSheet) throw new Error('購買依頼フォームが見つかりません。購買部にシート名を確認してください');
  const purchaseLastRowBefore = purchaseSheet.getLastRow();
  let first = null;
  let purchaseRow = null;
  let readBack = null;
  let inputCleared = false;
  const itemRowsCleaned = [];
  let purchaseRowsDeleted = 0;
  let cleaned = false;

  try {
    inputRange.setValue('https://example.com/booth-app-selftest 2個 必着 12/31 ' + QUICK_TEST_MARK);
    SpreadsheetApp.flush();
    first = Phase_ProcurementRequest_quickSubmit(caseId);
    inputCleared = String(inputRange.getValue() || '') === '';

    const purchaseLastRowAfter = purchaseSheet.getLastRow();
    if (purchaseLastRowAfter > purchaseLastRowBefore) {
      const names = purchaseSheet.getRange(purchaseLastRowBefore + 1, 7, purchaseLastRowAfter - purchaseLastRowBefore, 1).getDisplayValues();
      for (let i = 0; i < names.length; i++) {
        if (String(names[i][0] || '').indexOf(QUICK_TEST_MARK) >= 0) {
          purchaseRow = purchaseLastRowBefore + 1 + i;
          readBack = purchaseSheet.getRange(purchaseRow, 1, 1, 15).getDisplayValues()[0];
          break;
        }
      }
    }
  } finally {
    try {
      const purchaseLastRow = purchaseSheet.getLastRow();
      if (purchaseLastRow > purchaseLastRowBefore) {
        const names = purchaseSheet.getRange(purchaseLastRowBefore + 1, 7, purchaseLastRow - purchaseLastRowBefore, 1).getDisplayValues();
        for (let i = names.length - 1; i >= 0; i--) {
          if (String(names[i][0] || '').indexOf(QUICK_TEST_MARK) < 0) continue;
          const row = purchaseLastRowBefore + 1 + i;
          if (!purchaseRow) {
            purchaseRow = row;
            try { readBack = purchaseSheet.getRange(row, 1, 1, 15).getDisplayValues()[0]; } catch (ignored) {}
          }
          try {
            purchaseSheet.deleteRow(row);
            purchaseRowsDeleted++;
          } catch (ignored) {}
        }
      }
    } catch (ignored) {}

    try {
      const itemSheet = _Procure_itemSheet(_Procure_openZissi(c));
      const cols = _Procure_resolveColumns(itemSheet);
      const lastRow = itemSheet.getLastRow();
      if (lastRow >= 3) {
        const names = itemSheet.getRange(3, cols['品名'], lastRow - 2, 1).getDisplayValues();
        for (let i = 0; i < names.length; i++) {
          if (String(names[i][0] || '').indexOf(QUICK_TEST_MARK) < 0) continue;
          const row = i + 3;
          try {
            itemSheet.getRange(row, 6).clearContent();
            PROCUREMENT_HEADERS.forEach(function (header) {
              const range = itemSheet.getRange(row, cols[header]);
              if (header === '承認(kim)') range.setValue(false);
              else range.clearContent();
            });
            itemRowsCleaned.push(row);
          } catch (ignored) {}
        }
      }
    } catch (ignored) {}

    try {
      if (originalPasted === '') inputRange.clearContent();
      else inputRange.setValue(originalPasted);
    } catch (ignored) {}

    try {
      SpreadsheetApp.flush();
      cleaned = true;
    } catch (ignored) {}
  }

  const readBackCDGO = {
    timestamp: readBack ? readBack[2] : '', requester: readBack ? readBack[3] : '',
    item: readBack ? readBack[6] : '', deadline: readBack ? readBack[14] : ''
  };
  return {
    purchaseRow: purchaseRow,
    readBackCDGO: readBackCDGO,
    allFourFilled: Object.keys(readBackCDGO).every(function (key) { return Boolean(readBackCDGO[key]); }),
    registered: first ? first.registered : 0,
    sentCount: first ? first.sentCount : 0,
    parseErrors: first ? first.parseErrors : [], writeErrors: first ? first.writeErrors : [],
    submitErrors: first ? first.submitErrors : [],
    inputCleared: inputCleared,
    itemRowsCleaned: itemRowsCleaned,
    purchaseRowsDeleted: purchaseRowsDeleted,
    cleaned: cleaned
  };
}

function _Procure_openZissi(c) {
  let ss = null;
  if (c.zissiId) {
    try { ss = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!ss) {
    try {
      const folder = DriveApp.getFolderById(c.projectFolderId || c.folderId);
      const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
      while (files.hasNext()) {
        const file = files.next();
        if (file.getName().indexOf('実施計画書') >= 0 && file.getName().indexOf('提出') < 0) {
          ss = SpreadsheetApp.openById(file.getId());
          break;
        }
      }
    } catch (e) {}
  }
  if (!ss) throw new Error('実施計画書が見つかりません。先に見積初版を生成するか、既存の実施計画を取り込んでください');
  return ss;
}

function _Procure_itemSheet(ss) {
  const sheet = ss.getSheetByName('アイテムリスト');
  if (!sheet) throw new Error('実施計画書に「アイテムリスト」シートがありません。実施計画書のテンプレートを確認してください');
  return sheet;
}

function _Procure_normalizeHeader(value) { return String(value || '').replace(/\s+/g, ''); }

function _Procure_findColumns(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) return null;
  const values = sheet.getRange(2, 1, 1, lastColumn).getValues()[0];
  const cols = {};
  PROCUREMENT_HEADERS.forEach(function (header) {
    const target = _Procure_normalizeHeader(header);
    for (let i = 0; i < values.length; i++) {
      if (_Procure_normalizeHeader(values[i]) === target) { cols[header] = i + 1; break; }
    }
  });
  return cols;
}

function _Procure_resolveColumns(sheet) {
  const cols = _Procure_findColumns(sheet) || {};
  let next = sheet.getLastColumn() + 1;
  PROCUREMENT_HEADERS.forEach(function (header) {
    if (!cols[header]) {
      sheet.getRange(2, next).setValue(header);
      cols[header] = next++;
    }
  });
  return cols;
}

function _Procure_readMaster(c) {
  const out = { venue: '', setupDate: '', eventDates: '', requester: '', implementationPlanName: '' };
  if (!c.masterCol) return out;
  try {
    const task = SpreadsheetApp.openById(_PROCURE_MASTER_SS_ID).getSheetByName('task');
    if (!task) return out;
    const col = Number(c.masterCol);
    const values = task.getRange(3, col, 3, 1).getDisplayValues();
    out.venue = String(values[0][0] || '');
    out.setupDate = String(values[1][0] || '');
    out.eventDates = String(values[2][0] || '');
    out.implementationPlanName = String(task.getRange(6, col).getDisplayValue() || '');
    out.requester = String(task.getRange(8, col).getDisplayValue() || '');
  } catch (e) { /* master 情報は取得できなくても続行 */ }
  return out;
}

function _Procure_readProposal(ss) {
  const sheet = ss.getSheetByName('Claude_アイテムリスト提案');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getDisplayValues().filter(function (row) {
    return row.some(function (v) { return String(v || '').trim(); });
  }).map(function (row) { return { category: row[0], name: row[1], quantity: row[2], spec: row[3] }; });
}

function _Procure_normalizeItemName(value) {
  const text = String(value || '');
  return (text.normalize ? text.normalize('NFC') : text).toLowerCase().replace(/[\s　]/g, '').replace(/＆/g, '&');
}

function _Procure_existingBlockKeys(sheet, cols) {
  const keys = {};
  if (sheet.getLastRow() < 3) return keys;
  const names = sheet.getRange(3, cols['品名'], sheet.getLastRow() - 2, 1).getDisplayValues();
  const specs = sheet.getRange(3, cols['仕様/型番'], sheet.getLastRow() - 2, 1).getDisplayValues();
  names.forEach(function (row, i) {
    if (row[0]) keys[_Procure_normalizeItemName(row[0]) + '\n' + _Procure_normalizeItemName(specs[i][0])] = true;
  });
  return keys;
}

function _Procure_pickWritableRow(sheet, cols, usedRows) {
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const isUsed = function (row) { return usedRows instanceof Set ? usedRows.has(row) : !!usedRows[row]; };
  const markUsed = function (row) { if (usedRows instanceof Set) usedRows.add(row); else usedRows[row] = true; };
  if (!usedRows._procureMergedRows) {
    const mergedRows = {};
    if (lastRow >= 3) {
      [sheet.getRange(3, 6, lastRow - 2, 1), sheet.getRange(3, cols['品名'], lastRow - 2, 1)].forEach(function (range) {
        range.getMergedRanges().forEach(function (merged) {
          const firstRow = Math.max(3, merged.getRow());
          const endRow = Math.min(lastRow, merged.getLastRow());
          for (let row = firstRow; row <= endRow; row++) mergedRows[row] = true;
        });
      });
    }
    usedRows._procureMergedRows = mergedRows;
  }
  if (lastRow >= 3) {
    const fixed = sheet.getRange(3, 2, lastRow - 2, 5).getDisplayValues();
    const names = sheet.getRange(3, cols['品名'], lastRow - 2, 1).getDisplayValues();
    for (let i = 0; i < fixed.length; i++) {
      const row = i + 3;
      if (isUsed(row) || usedRows._procureMergedRows[row]) continue;
      const itemName = String(fixed[i][4] || '').trim();
      const procurementName = String(names[i][0] || '').trim();
      const metadataEmpty = fixed[i].slice(0, 4).every(function (v) { return String(v || '').trim() === ''; });
      if (!itemName && !procurementName && metadataEmpty) {
        markUsed(row);
        return row;
      }
    }
  }
  let appendedRow = lastRow + 1;
  while (isUsed(appendedRow)) appendedRow++;
  markUsed(appendedRow);
  return appendedRow;
}

function _Procure_set(sheet, row, cols, header, value) { sheet.getRange(row, cols[header]).setValue(value == null ? '' : value); }

/**
 * 承認シート → アイテムリスト の同期を実走で確かめる自己完結テスト。
 * 承認シートの1行目データに一時的にチェックを入れて同期し、アイテムリスト側に
 * 反映されたことを読み戻してから、必ず元の状態へ戻す。
 */
function _test_procurementApprovalSync(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const zissiSs = _Procure_openZissi(c);
  const itemSheet = _Procure_itemSheet(zissiSs);
  const cols = _Procure_findColumns(itemSheet);
  if (!cols || PROCUREMENT_HEADERS.some(function (h) { return !cols[h]; })) {
    throw new Error('先に「🧾 手配物リストを作る」を実行してください');
  }
  const approvalSheet = zissiSs.getSheetByName(PROCUREMENT_APPROVAL_SHEET_NAME);
  if (!approvalSheet || approvalSheet.getLastRow() < 3) {
    return { skipped: true, reason: '承認待ちの手配物が無いためテストできません' };
  }
  const testRow = 3;
  const itemRow = Number(approvalSheet.getRange(testRow, 9).getValue());
  const itemName = String(approvalSheet.getRange(testRow, 2).getDisplayValue() || '');
  const beforeApproval = approvalSheet.getRange(testRow, 1).getValue() === true;
  const beforeItem = itemSheet.getRange(itemRow, cols['承認(kim)']).getValue() === true;
  let checkedResult = null;
  let uncheckedResult = null;
  try {
    approvalSheet.getRange(testRow, 1).setValue(true);
    SpreadsheetApp.flush();
    const s1 = _Procure_syncApprovalFromSheet(zissiSs, itemSheet, cols);
    SpreadsheetApp.flush();
    checkedResult = { sync: s1, itemApproval: itemSheet.getRange(itemRow, cols['承認(kim)']).getValue() === true };

    approvalSheet.getRange(testRow, 1).setValue(false);
    SpreadsheetApp.flush();
    const s2 = _Procure_syncApprovalFromSheet(zissiSs, itemSheet, cols);
    SpreadsheetApp.flush();
    uncheckedResult = { sync: s2, itemApproval: itemSheet.getRange(itemRow, cols['承認(kim)']).getValue() === true };
  } finally {
    approvalSheet.getRange(testRow, 1).setValue(beforeApproval);
    itemSheet.getRange(itemRow, cols['承認(kim)']).setValue(beforeItem);
    SpreadsheetApp.flush();
  }
  return {
    itemRow: itemRow, itemName: itemName,
    checkedPropagates: checkedResult && checkedResult.itemApproval === true,
    uncheckedPropagates: uncheckedResult && uncheckedResult.itemApproval === false,
    checked: checkedResult, unchecked: uncheckedResult,
    restoredApprovalSheet: approvalSheet.getRange(testRow, 1).getValue() === beforeApproval,
    restoredItemList: itemSheet.getRange(itemRow, cols['承認(kim)']).getValue() === beforeItem
  };
}

function _Procure_rebuildApprovalSheet(zissiSs, itemSheet, cols) {
  // 作り直す前に必ず承認シート→アイテムリストへ同期する。
  // これを忘れると「kim がチェックを入れた直後に 🧾 手配物リストを作る を押す」だけで
  // アイテムリスト側の false で上書きされ、承認が黙って消える。
  _Procure_syncApprovalFromSheet(zissiSs, itemSheet, cols);
  const lastRow = itemSheet.getLastRow();
  const lastColumn = itemSheet.getLastColumn();
  const displayValues = lastRow >= 3 ? itemSheet.getRange(3, 1, lastRow - 2, lastColumn).getDisplayValues() : [];
  const values = lastRow >= 3 ? itemSheet.getRange(3, 1, lastRow - 2, lastColumn).getValues() : [];
  const rows = [];
  displayValues.forEach(function (displayRow, i) {
    const name = String(displayRow[cols['品名'] - 1] || '').trim();
    const status = String(displayRow[cols['ステータス'] - 1] || '').trim();
    if (!name || status === '手配依頼済') return;
    rows.push([
      values[i][cols['承認(kim)'] - 1] === true,
      name,
      displayRow[cols['手配数量'] - 1],
      displayRow[cols['必着日'] - 1],
      displayRow[cols['予算'] - 1],
      displayRow[cols['根拠(議事録日付)'] - 1],
      displayRow[cols['根拠(該当発言)'] - 1],
      status,
      i + 3
    ]);
  });

  let sheet = zissiSs.getSheetByName(PROCUREMENT_APPROVAL_SHEET_NAME);
  if (!sheet) sheet = zissiSs.insertSheet(PROCUREMENT_APPROVAL_SHEET_NAME);
  sheet.clear();
  sheet.getRange('A1:H1').breakApart();
  const description = '✅ 承認する行の A列にチェックを入れる → 実行パネルの「📮 承認済みを購買部へ手配依頼」を実行。チェックできるのは kim だけです。ここは自動生成なので直接編集しても次回の生成で消えます（A列のチェックだけが反映されます）';
  const headers = ['承認(kim)', '品名', '数量', '必着日', '予算', '根拠(議事録日付)', '根拠(該当発言)', 'ステータス', 'アイテムリスト行'];
  const output = [[description, '', '', '', '', '', '', '', ''], headers].concat(rows);
  sheet.getRange(1, 1, output.length, headers.length).setValues(output);
  sheet.getRange('A1:H1').merge();
  if (rows.length) {
    sheet.getRange(3, 1, rows.length, 1).insertCheckboxes();
  } else {
    sheet.getRange('A3').setValue('（承認待ちの手配物はありません）');
  }
  sheet.setColumnWidth(2, 260);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(7, 320);
  sheet.setFrozenRows(2);
  sheet.hideColumns(9);
  _Procure_protectApproval(sheet, 1);
  return {
    url: 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + zissiSs.getId() + '/edit#gid=' + sheet.getSheetId(),
    rowCount: rows.length
  };
}

function _Procure_syncApprovalFromSheet(zissiSs, itemSheet, cols) {
  const approvalSheet = zissiSs.getSheetByName(PROCUREMENT_APPROVAL_SHEET_NAME);
  if (!approvalSheet) return { synced: 0, skipped: 0 };
  const approvalLastRow = approvalSheet.getLastRow();
  if (approvalLastRow < 3) return { synced: 0, skipped: 0 };
  const approvalValues = approvalSheet.getRange(3, 1, approvalLastRow - 2, 9).getValues();
  const itemLastRow = itemSheet.getLastRow();
  const itemLastColumn = itemSheet.getLastColumn();
  const itemValues = itemLastRow >= 3 ? itemSheet.getRange(3, 1, itemLastRow - 2, itemLastColumn).getValues() : [];
  let synced = 0;
  let skipped = 0;
  const writes = [];
  approvalValues.forEach(function (row) {
    const approval = row[0] === true;
    const approvalName = String(row[1] || '').trim();
    const itemRow = Number(row[8]);
    const itemIndex = itemRow - 3;
    if (!approvalName || !Number.isInteger(itemRow) || itemIndex < 0 || itemIndex >= itemValues.length) {
      skipped++;
      return;
    }
    const itemName = String(itemValues[itemIndex][cols['品名'] - 1] || '').trim();
    const status = String(itemValues[itemIndex][cols['ステータス'] - 1] || '').trim();
    if (itemName !== approvalName || status === '手配依頼済') {
      skipped++;
      return;
    }
    itemSheet.getRange(itemRow, cols['承認(kim)']).setValue(approval);
    writes.push({ row: itemRow, value: approval });
  });
  SpreadsheetApp.flush();
  const approvalReadBack = itemLastRow >= 3
    ? itemSheet.getRange(3, cols['承認(kim)'], itemLastRow - 2, 1).getValues()
    : [];
  writes.forEach(function (write) {
    if (approvalReadBack[write.row - 3][0] === write.value) synced++;
    else skipped++;
  });
  return { synced: synced, skipped: skipped };
}

function _Procure_protectApproval(sheet, col) {
  try {
    const description = '手配物 承認列(kim専用) - Phase_ProcurementRequest';
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    let protection = null;
    for (let i = 0; i < protections.length; i++) {
      if (protections[i].getDescription() === description) { protection = protections[i]; break; }
    }
    if (!protection) protection = sheet.getRange(3, col, Math.max(1, sheet.getMaxRows() - 2), 1).protect().setDescription(description);
    const editors = protection.getEditors();
    if (editors.length) protection.removeEditors(editors);
    const configured = PropertiesService.getScriptProperties().getProperty('PROCUREMENT_APPROVERS') || 'kim@orgiast.jp';
    configured.split(',').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (email) { protection.addEditor(email); });
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
    return '';
  } catch (e) {
    return '承認列の保護に失敗しました: ' + String(e && e.message || e);
  }
}

function _Procure_approvalMessage(c, written, url) {
  const lines = ['【承認依頼】' + (c.clientName || '') + ' / ' + (c.caseName || '') + ' 手配物 ' + written.length + '件', ''];
  written.forEach(function (x) {
    const item = x.item;
    lines.push('・' + x.name + ' / 数量: ' + (item.quantity == null ? '' : item.quantity) + ' / 必着日: ' + x.requiredBy + ' / 予算: ' + (item.budget || '未確定'));
    lines.push('  根拠: ' + item.evidence.date + ' ' + item.evidence.quote);
  });
  lines.push('', '手配物承認シート: ' + url, '', '1. 下のリンクを開いて「承認(kim)」列にチェック', '2. 実行パネルの「📮 承認済みを購買部へ手配依頼」を実行');
  return lines.join('\n');
}

// 送信結果の詳細を返す (診断できないと「送れていない」に気付けないため)。
function _Procure_sendDiscordDetail(message) {
  const props = PropertiesService.getScriptProperties();
  const hook = props.getProperty('DISCORD_PROCUREMENT_WEBHOOK');
  if (!hook) return { sent: false, reason: 'DISCORD_PROCUREMENT_WEBHOOK 未設定' };
  try {
    // User-Agent を明示しないと Cloudflare が 429 / error code 1015 を返す
    // (GAS 既定の UA は Discord 側でブロックされる。[[project_claude_watch_inbox]] と同じ罠)
    const options = {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'User-Agent': 'DiscordBot (https://orgiast.jp, 1.0) orgiast-booth-app' },
      payload: Utilities.newBlob(JSON.stringify({ content: String(message).slice(0, 1900), username: 'ブース制作アプリ 手配物' }), 'application/json').getBytes(),
      muteHttpExceptions: true
    };
    let response = UrlFetchApp.fetch(hook, options);
    let code = response.getResponseCode();
    // 通常のレート制限(1015 以外の 429)は1度だけ待って再送する
    if (code === 429 && String(response.getContentText()).indexOf('1015') < 0) {
      Utilities.sleep(2000);
      response = UrlFetchApp.fetch(hook, options);
      code = response.getResponseCode();
    }
    const sent = code >= 200 && code < 300;
    return { sent: sent, code: code, reason: sent ? '' : String(response.getContentText()).slice(0, 300) };
  } catch (e) { return { sent: false, reason: 'fetch例外: ' + String(e && e.message || e) }; }
}

function _Procure_sendDiscord(message) { return _Procure_sendDiscordDetail(message).sent; }

function _Procure_notifyApproval(c, message) {
  const configured = PropertiesService.getScriptProperties().getProperty('PROCUREMENT_APPROVERS') || 'kim@orgiast.jp';
  const to = configured.split(',').map(function (x) { return x.trim(); }).filter(Boolean).join(',');
  // メール送信は使わない。MailApp を使うと oauthScopes に script.send_mail が必要になり、
  // バインド script の simple onOpen とコマンドキューの time-based トリガーが再認可まで停止する
  // ([[feedback_gas_scope_addition_suppresses_onopen]])。通知は追加スコープ不要の
  // script.external_request (Discord webhook) だけで行う。
  const detail = _Procure_sendDiscordDetail(message);
  return {
    mailSent: false,
    discordSent: detail.sent,
    discordCode: detail.code,
    to: to,
    note: detail.sent ? '' : ('Discord へ送れていません: ' + (detail.reason || '') + ' / 承認依頼文は実行パネルの結果列に出ます')
  };
}

function _Procure_requestType(referenceUrl, spec) { return referenceUrl && spec ? '発注依頼(指定品)' : '購入(安値調査込)'; }

function _Procure_defaultDestination(c, venue) {
  const target = [venue, c.caseName, c.clientName].join(' ');
  return /(大阪|インテックス)/.test(target)
    ? '大阪市東成区深江北2-15-24 東邦ハイツ212（大阪事務所）'
    : '〒350-0013 埼玉県川越市渋井1351-3（渋井倉庫）';
}

function _Procure_formatDate(value) {
  const date = _AssignSheet_parseFirstDate(value, value);
  return date && !isNaN(date.getTime()) ? Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd') : '';
}

// Date 値は String() すると英語表記 (Sat Sep 05 2026 ...) になり数字の並びが崩れるため、
// 比較前に必ず yyyyMMddHHmmss へ正規化する。
function _Procure_dateDigits(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyyMMddHHmmss').replace(/0+$/, function (tail) {
      return tail.length >= 6 ? '' : tail;
    });
  }
  return String(value == null ? '' : value).replace(/[^0-9]/g, '');
}

function _Procure_sameDate(a, b) {
  const left = _Procure_dateDigits(a);
  const right = _Procure_dateDigits(b);
  if (!left && !right) return true;
  if (!left || !right) return false;
  // 列の表示書式で 'yyyy/MM/dd HH:mm:ss' が 'yyyy/MM/dd' に丸められることがあるため前方一致も許容する
  return left === right || left.indexOf(right) === 0 || right.indexOf(left) === 0;
}

function _Procure_offsetDate(value, days) {
  const date = _AssignSheet_parseFirstDate(value, value);
  if (!date || isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + days);
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd');
}

function _Procure_purchaseKey(requester, item, deadline) {
  // 必着日は列の表示書式で表記が揺れるため数字のみに正規化して突き合わせる
  return [String(requester || '').trim(), String(item || '').trim(), String(deadline || '').replace(/[^0-9]/g, '')].join('\n');
}
