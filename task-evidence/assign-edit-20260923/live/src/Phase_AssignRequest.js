/** アサイン依頼の社内ルール(Growi マニュアル要約 2026-08-17 時点)。 */
var _ASSIGN_MANUAL_NOTES = [
  '## アサイン依頼の社内ルール(Reブース・イベント案件)',
  '- 施工スタッフの依頼には「施工図面」を添付する。図面が無くても依頼は進めてよいが、その場合は特記事項に「施工図面は入手次第すぐ共有します」と書く。',
  '- 申し送り事項はレイアウトシートまたは施工図面と一緒に送る。',
  '- 設営日は通常2日間あり、半日・半日で施工依頼する。1日目は施工開始できる時間から開始し、作業時間はブース面積に応じて見積もる。2日目は前半半分の時間(例 9:00〜13:00)でアサインし、加えて職人1名を終日(例 9:00〜17:00)アサインする。',
  '- 撤去は会期最終日の閉会後(例 17:00〜20:00)。',
  '- 設営撤去立会者は施工人員がブースにいる時間で設定する。',
  '- 通話フォロー者を立会者と同じ時間で依頼する: イベント関連→当日スタッフ→その他「通話フォロー」、依頼金額=時間×1,000円、人数1名。',
  '- 費用の目安: 施工リーダー(職人) 25,000円/日、施工スタッフ(アルバイト) 1,300円/時。その他ポジションは制作物価格表を参照し、勤務10時間以上は加算ルール適用(例: 照明オペ【関東】14時間 = 25,000円+(4×1,200円)=29,800円)。',
  '- 本番日まで3ヶ月を切っている案件は営業中でも全て依頼を出す。',
  '- スタッフの勤務時間は実施計画書スタッフシートの I列以降に記載する(仮記入でよい)。'
].join('\n');

var _ASSIGN_SS_ID = '1a3VlFzkuH8jMJZhIPZPekWfdpJ7NgPo5p3fQqHelzmU';
var _ASSIGN_SHEET_NAME = 'マスター';
var _ASSIGN_SHEET_GID = 628864949;
var _ASSIGN_ROLE_ID_DEFAULT = '1382685625228066836';

/** 制作担当からアサインチームへ送る依頼書を作成し、依頼シートへ登録する。 */
function Phase_AssignRequest_generate(caseId, opts) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const dryRun = Boolean(opts && opts.dryRun);

  let venue = '';
  let setupDate = '';
  let eventDates = '';
  let producerRaw = '';
  let producerDeputyRaw = '';
  let implementationPlanName = '';
  if (c.masterCol) {
    try {
      const task = SpreadsheetApp.openById('1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI').getSheetByName('task');
      if (task) {
        const col = Number(c.masterCol);
        const masterValues = task.getRange(3, col, 3, 1).getDisplayValues();
        venue = String(masterValues[0][0] || '');
        setupDate = String(masterValues[1][0] || '');
        eventDates = String(masterValues[2][0] || '');
        implementationPlanName = String(task.getRange(6, col).getDisplayValue() || '');
        producerRaw = task.getRange(8, col).getDisplayValue();
        producerDeputyRaw = task.getRange(8, col + 1).getDisplayValue();
      }
    } catch (e) { /* master 情報は未取得でも生成を続行 */ }
  }
  const producerName = _AssignSheet_producerName(producerRaw) || _AssignSheet_producerName(producerDeputyRaw);
  const requesterName = producerName || 'ブース制作アプリ(自動)';

  const clientContext = Case_loadClientContext(c) || '';
  const proposalUrl = _AssignSheet_findProposalUrl(c);
  const cachedContext = clientContext ? [clientContext] : [];
  // 社内マニュアル「アサイン依頼フォームの使い方」「スタッフシートの仮記入」「当日スタッフのアサイン」要約
  // (ManualLoader の実行時ロードは 6 分制限超過するため静的に保持。マニュアル改訂時はここを更新
  //  一次ソース: https://orgiast-manual.com/66c2f9ebbca30903a3ceff28 / 62a69b00bca30903a38bb1c8)
  cachedContext.push(_ASSIGN_MANUAL_NOTES);

  const prompt = [
    '以下の案件について、制作担当からアサインチームへ送る「アサイン依頼」を作成してください。',
    'cachedContext 内のマニュアル抜粋を「アサイン依頼の社内ルール」として優先して参照してください。',
    '', '## 案件情報',
    '- クライアント: ' + (c.clientName || '未確定'),
    '- 案件名: ' + (c.caseName || '未確定'),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '- 会場: ' + (venue || '未確定'),
    '- 設営日: ' + (setupDate || '未確定'),
    '- 開催日程: ' + (eventDates || '未確定'),
    '- 提案書URL: ' + (proposalUrl || '未確認(本文で提案書に言及する場合は「提案書は別途共有します」と書き、URLを創作しないこと)'),
    '', '## 出力形式（JSON のみ）',
    '{"title":"...","body":"...","construction":{"needed":true,"boothArea":null,"schedule":"【設営】…【撤去】…","work":"<業務内容>","truss":"トラス組みあり|なし","crew":"<設営/撤去ごとの人員構成>","cost":"<費用目安>","notes":"<特記事項>"},"eventStaff":{"needed":true,"staffType":"制作スタッフ","positions":[{"position":"...","fee":0,"count":0}],"notes":""},"confirmations":[]}',
    '', 'construction.needed と eventStaff.needed は必要性に応じて true/false にすること。eventStaff.positions は最大2件。',
    'construction.boothArea は数値の㎡で出力すること。小間寸法(mm)が判る場合は必ず寸法から算出する(例 9000×8100mm = 72.9㎡)。寸法が無い場合に限りコマ数×1コマ9㎡で概算する。根拠が無ければ null にすること。',
    'eventStaff.positions[].fee は必ず 1 以上の数値(1名あたりの依頼金額)にすること。0 や空は禁止。通話フォローは「立会時間×1,000円」の総額を入れる(例 8時間なら 8000)。相場が不明な場合も概算値を入れたうえで confirmations に「◯◯の依頼金額は要確認」を追加すること。',
    '人員構成と費用相場はマニュアルと顧客コンテキストに基づくこと。情報が無い項目は「要確認」と書き、confirmations にも入れること。',
    '本文には案件概要、会場、設営日・会期（撤去は会期最終日後）、必要ロールと人数目安、設営日から逆算した回答希望期日、「詳細は実施計画書参照」を含めること。',
    '顧客コンテキストに実機搬入・セミナー等があれば反映すること。未確定事項は推測で断定しないこと。',
    '本文中で提案書に言及する場合、上記の提案書URLが未確認でなければ必ずそのURLを本文に含めること。'
  ].join('\n');
  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: prompt,
    maxTokens: 4000
  });
  const parsed = _Phase1_parseJson(res.text);
  if (!parsed.body) throw new Error('アサイン依頼本文を生成できませんでした');

  const construction = parsed.construction || {};
  const eventStaff = parsed.eventStaff || {};
  const positions = Array.isArray(eventStaff.positions) ? eventStaff.positions.slice(0, 2) : [];
  const clientName = _AssignSheet_clientName(c.clientName);
  const projectCodeMatch = implementationPlanName.match(/(\d{6}[A-Z]{3})/);
  const projectCodeResult = projectCodeMatch
    ? { code: projectCodeMatch[1], resolved: 'reused' }
    : _AssignSheet_projectCode(eventDates || c.startDate, c.startDate, c.clientName);
  const projectCode = projectCodeResult.code;
  const boothArea = _AssignSheet_boothArea(c.boothSize);
  const urls = _AssignSheet_zissiUrls(c.zissiId);
  const autoCodeNote = projectCodeResult.resolved === 'unknown' ? 'PJコードの英字3字が未確定です(要確認・暫定XXX)' : '';
  const boothAreaNote = boothArea === '' ? '小間面積は自動判定できませんでした(要確認)' : '';
  const confirmations = Array.isArray(parsed.confirmations) ? parsed.confirmations : [];
  if (boothArea === '') confirmations.push('小間面積が不明(要確認)');
  if (!producerName) confirmations.push('アサイン依頼の依頼者名(制作P)が未設定です。タスク進捗管理表 task シート row8 の該当列に制作P名を入れてください');
  const plannedRows = [];

  if (construction.needed === true) {
    const constructionRow = _AssignSheet_emptyRow();
    constructionRow[0] = new Date();
    constructionRow[1] = requesterName;
    constructionRow[2] = '施工スタッフ';
    constructionRow[49] = c.caseName || '';
    constructionRow[50] = clientName;
    constructionRow[51] = projectCode;
    constructionRow[52] = boothArea;
    constructionRow[53] = urls.drawing;
    constructionRow[54] = construction.schedule || '要確認';
    constructionRow[55] = construction.work || '要確認';
    constructionRow[56] = construction.truss || '要確認';
    constructionRow[57] = construction.crew || '要確認';
    constructionRow[58] = construction.cost || '要確認';
    constructionRow[59] = [construction.notes || '', autoCodeNote, boothAreaNote].filter(function (x) { return x; }).join('\n');
    constructionRow[63] = urls.staff;
    constructionRow[64] = producerName;
    plannedRows.push({ type: 'construction', values: constructionRow });
  }
  if (eventStaff.needed === true) {
    const eventRow = _AssignSheet_emptyRow();
    eventRow[0] = new Date();
    eventRow[1] = requesterName;
    eventRow[2] = 'イベント関連';
    eventRow[11] = clientName;
    eventRow[12] = c.caseName || '';
    eventRow[13] = projectCode;
    eventRow[14] = producerName || requesterName;
    eventRow[15] = eventStaff.staffType || '制作スタッフ';
    positions.forEach(function (p, i) {
      const offset = 16 + i * 3;
      eventRow[offset] = p.position || '要確認';
      eventRow[offset + 1] = _AssignSheet_number(p.fee);
      eventRow[offset + 2] = _AssignSheet_number(p.count);
    });
    plannedRows.push({ type: 'event', values: eventRow });
  }

  const title = parsed.title || 'アサイン依頼';
  const doc = DocumentApp.create(c.caseId + '_' + (c.caseName || '案件') + '_アサイン依頼');
  const body = doc.getBody();
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(String(parsed.body));
  if (construction.needed === true) {
    body.appendParagraph('施工スタッフ依頼').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendTable([
      ['勤務日時', String(construction.schedule || '要確認')],
      ['業務内容', String(construction.work || '要確認')],
      ['トラス', String(construction.truss || '要確認')],
      ['人員構成', String(construction.crew || '要確認')],
      ['費用', String(construction.cost || '要確認')],
      ['特記事項', String(construction.notes || '')]
    ]);
  }
  if (eventStaff.needed === true) {
    body.appendParagraph('イベント関連スタッフ依頼').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const eventRows = [['スタッフ種別', 'ポジション', '依頼金額', '必要人数']];
    positions.forEach(function (p) {
      eventRows.push([String(eventStaff.staffType || '制作スタッフ'), String(p.position || '要確認'), String(p.fee == null ? '' : p.fee), String(p.count == null ? '' : p.count)]);
    });
    body.appendTable(eventRows);
    if (eventStaff.notes) body.appendParagraph('特記事項: ' + String(eventStaff.notes));
  }
  doc.saveAndClose();
  const folderId = Case_resolveProjectRoot(c);
  if (folderId) {
    try { DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }
  const docUrl = 'https://docs.google.com/a/orgiast.jp/document/d/' + doc.getId() + '/edit';
  plannedRows.forEach(function (planned) {
    planned.values[65] = docUrl;
  });

  const appendedRows = [];
  if (!dryRun) {
    _AssignSheet_ensureDocUrlHeader();
    const insertedRows = _AssignSheet_insertRowsTop(plannedRows.map(function (planned) { return planned.values; }));
    plannedRows.forEach(function (planned, index) {
      appendedRows.push({ type: planned.type, row: insertedRows[index] });
    });
  }
  const assignSheetUrl = appendedRows.length > 0 ? _AssignSheet_masterUrl(appendedRows[0].row) : '';

  let discordResult = { sent: false, code: null, reason: '' };
  if (!dryRun) {
    const roleId = PropertiesService.getScriptProperties().getProperty('DISCORD_ASSIGN_ROLE_ID') || _ASSIGN_ROLE_ID_DEFAULT;
    const notifyText = _AssignSheet_buildNotifyText({
      roleId: roleId,
      requesterName: requesterName,
      requestTypes: plannedRows.map(function (row) { return row.type === 'construction' ? '施工スタッフ' : 'イベント関連'; }),
      clientName: c.clientName || '',
      caseName: c.caseName || '',
      projectCode: projectCode,
      rows: appendedRows,
      docUrl: docUrl,
      timestampText: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
      producerMissing: !producerName
    });
    discordResult = _AssignSheet_notifyDiscord(notifyText);
  }

  if (confirmations.length > 0) {
    const tagged = confirmations.map(function (x) {
      if (typeof x === 'string') return { category: '[アサイン依頼]', content: x };
      return { category: '[アサイン依頼] ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, 'アサイン依頼', title, docUrl);

  const constructionCount = plannedRows.filter(function (x) { return x.type === 'construction'; }).length;
  const eventCount = plannedRows.filter(function (x) { return x.type === 'event'; }).length;
  return {
    docUrl: docUrl,
    clientProposalUrl: proposalUrl || undefined,
    assignSheetUrl: assignSheetUrl || undefined,
    title: title,
    roleCount: constructionCount + positions.length,
    discordSent: discordResult.sent,
    discordReason: discordResult.reason,
    dryRun: dryRun,
    plannedRows: dryRun ? plannedRows : undefined,
    appendedRows: appendedRows,
    panelStatus: (dryRun ? '🧪 dryRun: 登録予定 ' : '✅ アサイン依頼シートの先頭に登録しました') +
      '(施工' + constructionCount + '行/イベント' + eventCount + '行)。' +
      (dryRun ? '依頼書は結果リンクから' : '依頼書とアサイン依頼シートは結果リンクから開けます') +
      (dryRun ? '' : (discordResult.sent ? '／Discord通知 ✅' : '／Discord通知 ⚠️ ' + discordResult.reason))
  };
}

/**
 * 提案書候補から1件を選ぶ純粋関数。
 * @param {Array<{name:string, url:string, updatedAt:number}>} candidates
 * @return {string} 採用する URL（該当なしなら ''）
 */
function AssignRequest_pickProposalFile(candidates) {
  const eligible = (candidates || []).filter(function (candidate) {
    const name = String(candidate && candidate.name || '');
    return name.indexOf('提案') >= 0 && !/(テンプレ|サンプル|雛形|ひな形)/.test(name);
  });
  const proposalDocuments = eligible.filter(function (candidate) {
    return String(candidate.name || '').indexOf('提案書') >= 0;
  });
  const pool = proposalDocuments.length > 0 ? proposalDocuments : eligible;
  let selected = null;
  pool.forEach(function (candidate) {
    if (!selected || Number(candidate.updatedAt) > Number(selected.updatedAt)) selected = candidate;
  });
  return selected ? String(selected.url || '') : '';
}

function _AssignSheet_findProposalUrl(c) {
  try {
    const folderId = Case_resolveProjectRoot(c);
    if (!folderId) return '';
    const root = DriveApp.getFolderById(folderId);
    const allowedMimeTypes = {
      'application/vnd.google-apps.document': true,
      'application/vnd.google-apps.presentation': true,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': true,
      'application/vnd.ms-powerpoint': true,
      'application/pdf': true
    };
    const visitedFolderIds = new Set();
    const candidates = [];
    const maxDepth = 3;
    const maxFolders = 60;
    // 巨大フォルダを掴んだときに 6 分制限で落ちないよう、見たファイル数でも打ち切る
    const maxFiles = 800;
    let scannedFiles = 0;

    const scanFolder = function (folder, depth) {
      if (depth > maxDepth || visitedFolderIds.size >= maxFolders || scannedFiles >= maxFiles) return;
      const currentFolderId = folder.getId();
      if (visitedFolderIds.has(currentFolderId)) return;
      visitedFolderIds.add(currentFolderId);

      const files = folder.getFiles();
      while (files.hasNext() && scannedFiles < maxFiles) {
        const file = files.next();
        scannedFiles++;
        if (!allowedMimeTypes[file.getMimeType()]) continue;
        candidates.push({
          name: file.getName(),
          url: file.getUrl(),
          updatedAt: file.getLastUpdated().getTime()
        });
      }
      if (depth >= maxDepth) return;

      const folders = folder.getFolders();
      while (folders.hasNext() && visitedFolderIds.size < maxFolders && scannedFiles < maxFiles) {
        scanFolder(folders.next(), depth + 1);
      }
    };

    scanFolder(root, 0);
    return AssignRequest_pickProposalFile(candidates);
  } catch (e) { return ''; }
}

function _AssignSheet_masterUrl(rowNumber) {
  try {
    if (!rowNumber) return '';
    return 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + _ASSIGN_SS_ID +
      '/edit?gid=' + _ASSIGN_SHEET_GID + '&range=A' + Number(rowNumber);
  } catch (e) { return ''; }
}

function _AssignSheet_append(rowValues) {
  const sheet = SpreadsheetApp.openById(_ASSIGN_SS_ID).getSheetByName(_ASSIGN_SHEET_NAME);
  if (!sheet) throw new Error('アサイン依頼シート「マスター」が見つかりません');
  sheet.appendRow(rowValues);
  return sheet.getLastRow();
}

function _AssignSheet_insertRowsTop(rowsValues, sheetOverride) {
  if (!rowsValues || rowsValues.length === 0) return [];
  const sheet = sheetOverride || SpreadsheetApp.openById(_ASSIGN_SS_ID).getSheetByName(_ASSIGN_SHEET_NAME);
  if (!sheet) throw new Error('アサイン依頼シート「マスター」が見つかりません');

  const rowCount = rowsValues.length;
  const columnCount = rowsValues.reduce(function (max, row) {
    return Math.max(max, Array.isArray(row) ? row.length : 0);
  }, 0);
  const paddedValues = rowsValues.map(function (row) {
    const padded = Array.isArray(row) ? row.slice() : [];
    while (padded.length < columnCount) padded.push('');
    return padded;
  });

  sheet.insertRowsBefore(2, rowCount);
  const originalSecondRow = 2 + rowCount;
  if (sheet.getLastRow() >= originalSecondRow) {
    const formatColumnCount = sheet.getMaxColumns();
    sheet.getRange(originalSecondRow, 1, 1, formatColumnCount).copyTo(
      sheet.getRange(2, 1, rowCount, formatColumnCount),
      SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
      false
    );
  }
  if (columnCount > 0) sheet.getRange(2, 1, rowCount, columnCount).setValues(paddedValues);
  SpreadsheetApp.flush();

  const insertedRows = [];
  rowsValues.forEach(function (rowValues, index) {
    const row = 2 + index;
    insertedRows.push(row);
    const expectedType = String((rowValues && rowValues[2]) == null ? '' : rowValues[2]);
    if (String(sheet.getRange(row, 3).getDisplayValue()) !== expectedType) {
      throw new Error('アサイン依頼行の read-back verify に失敗しました: row ' + row);
    }
  });
  return insertedRows;
}

function _AssignSheet_ensureDocUrlHeader(sheetOverride) {
  try {
    const sheet = sheetOverride || SpreadsheetApp.openById(_ASSIGN_SS_ID).getSheetByName(_ASSIGN_SHEET_NAME);
    if (!sheet) return;
    const headerCell = sheet.getRange(1, 66);
    if (String(headerCell.getDisplayValue()) === '') headerCell.setValue('依頼書URL');
  } catch (e) { /* ヘッダ更新失敗でメイン処理を止めない */ }
}

function _AssignSheet_emptyRow() {
  return Array.apply(null, Array(66)).map(function () { return ''; });
}

function _AssignSheet_producerName(value) {
  return String(value == null ? '' : value)
    .replace(/^[\s\u3000]*制作[PD][\s\u3000]*[：:][\s\u3000]*/, '')
    .replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

function _AssignSheet_buildNotifyText(params) {
  params = params || {};
  const rowLabels = { construction: '施工スタッフ', event: 'イベント関連' };
  const requesterLines = [String(params.requesterName || '')];
  if (params.producerMissing === true) requesterLines.push('※制作Pが未設定のため自動名義です。依頼者を確認してください');
  const parts = [
    '<@&' + String(params.roleId || '') + '>',
    'アサイン依頼シートに登録がありました（ブース制作アプリからの自動登録・フォーム外）。',
    'アサインチームの方はご対応お願いします。',
    '日時: ' + String(params.timestampText || ''),
    '----------',
    '【依頼者名】',
    requesterLines.join('\n'),
    '',
    '【アサインチームへの依頼内容】',
    (params.requestTypes || []).join(' / '),
    '',
    '【案件】',
    String(params.clientName || '') + ' / ' + String(params.caseName || '') + '（PJコード: ' + String(params.projectCode || '') + '）'
  ];
  if (params.rows && params.rows.length) {
    parts.push('', '【登録行】');
    params.rows.forEach(function (item) {
      parts.push((rowLabels[item.type] || String(item.type || '')) + ': ' + item.row + '行目 ' +
        'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + _ASSIGN_SS_ID + '/edit?gid=' + _ASSIGN_SHEET_GID + '&range=A' + item.row);
    });
    parts.push('※行番号は登録時点のものです（新しい依頼が上に入ると下にずれます）');
  }
  const beforeDoc = parts.join('\n');
  const fullText = beforeDoc + '\n\n【依頼書(Doc)】\n' + String(params.docUrl || '') + '\n----------';
  if (fullText.length <= 1900) return fullText;
  const suffix = '…（省略）';
  return beforeDoc.substring(0, 1900 - suffix.length) + suffix;
}

function _AssignSheet_notifyDiscord(text) {
  try {
    const hook = PropertiesService.getScriptProperties().getProperty('DISCORD_ASSIGN_WEBHOOK');
    if (!hook) return { sent: false, code: null, reason: 'DISCORD_ASSIGN_WEBHOOK 未設定' };
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: text }),
      muteHttpExceptions: true
    };
    let response = UrlFetchApp.fetch(hook, options);
    let code = response.getResponseCode();
    if (code === 429) {
      Utilities.sleep(3000);
      response = UrlFetchApp.fetch(hook, options);
      code = response.getResponseCode();
    }
    if (code >= 200 && code < 300) return { sent: true, code: code, reason: '' };
    return { sent: false, code: code, reason: 'Discord HTTP ' + code };
  } catch (e) {
    return { sent: false, code: null, reason: String(e) };
  }
}

function Phase_AssignRequest_testNotify() {
  const timestampText = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  return _AssignSheet_notifyDiscord('【テスト送信・無視してください】ブース制作アプリからのアサイン依頼通知の接続テストです（' + timestampText + '）');
}

function _AssignSheet_clientName(value) {
  const name = String(value || '').trim();
  return /様$/.test(name) ? name : name + '様';
}

function _AssignSheet_number(value) {
  const match = String(value == null ? '' : value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return '';
  const number = Number(match[0]);
  return isFinite(number) ? number : '';
}

function _AssignSheet_boothArea(value) {
  const source = String(value == null ? '' : value);
  const normalized = (source.normalize ? source.normalize('NFKC') : source).replace(/,/g, '');
  const hasAreaUnit = /(?:㎡|m2|m²|平米)/i.test(source) || /(?:m2|平米)/i.test(normalized);
  const matches = normalized.replace(/m2/gi, 'm').match(/\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return '';

  let area = '';
  if (matches.length >= 2) {
    let width = Number(matches[0]);
    let depth = Number(matches[1]);
    if (!isFinite(width) || !isFinite(depth)) return '';
    if (width >= 100 || depth >= 100) {
      width = width / 1000;
      depth = depth / 1000;
    }
    area = width * depth;
  } else {
    if (/小間|ブース/.test(normalized) && !hasAreaUnit) return '';
    area = Number(matches[0]);
  }
  return isFinite(area) ? Math.round(area * 10) / 10 : '';
}

function _AssignSheet_projectCode(taskDate, fallbackDate, clientName) {
  const firstDate = _AssignSheet_parseFirstDate(taskDate, fallbackDate) || _AssignSheet_parseFirstDate(fallbackDate, '');
  const datePart = firstDate ? Utilities.formatDate(firstDate, 'Asia/Tokyo', 'yyMMdd') : '000000';
  const normalized = String(clientName || '').normalize ? String(clientName || '').normalize('NFKC') : String(clientName || '');
  const comparableName = _AssignSheet_comparableClientName(normalized);
  const sheet = SpreadsheetApp.openById(_ASSIGN_SS_ID).getSheetByName(_ASSIGN_SHEET_NAME);
  if (sheet && comparableName) {
    const values = sheet.getDataRange().getValues();
    for (let i = values.length - 1; i >= 0; i--) {
      const constructionMatch = String(values[i][51] || '').match(/^\d{6}([A-Z]{2,4})$/);
      // 暫定値 XXX を実績として再利用してはいけない (要確認注記が消えてしまう)
      if (constructionMatch && constructionMatch[1] !== 'XXX' && _AssignSheet_comparableClientName(values[i][50]) === comparableName) {
        return { code: datePart + constructionMatch[1], resolved: 'reused' };
      }
      const eventMatch = String(values[i][13] || '').match(/^\d{6}([A-Z]{2,4})$/);
      if (eventMatch && eventMatch[1] !== 'XXX' && _AssignSheet_comparableClientName(values[i][11]) === comparableName) {
        return { code: datePart + eventMatch[1], resolved: 'reused' };
      }
    }
  }
  const letters = normalized.replace(/[^A-Za-z]/g, '').substring(0, 3).toUpperCase();
  if (letters) return { code: datePart + letters, resolved: 'letters' };
  return { code: datePart + 'XXX', resolved: 'unknown' };
}

function _AssignSheet_comparableClientName(value) {
  const source = String(value || '');
  const normalized = source.normalize ? source.normalize('NFKC') : source;
  return normalized.replace(/\s/g, '').replace(/様$/, '');
}

function _AssignSheet_parseFirstDate(value, yearSource) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const text = String(value || '');
  let match = text.match(/(20\d{2})\s*[\/年.-]\s*(\d{1,2})\s*[\/月.-]\s*(\d{1,2})/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  match = text.match(/(\d{1,2})\s*[\/月.-]\s*(\d{1,2})/);
  if (!match) return null;
  const yearMatch = String(yearSource || '').match(/(20\d{2})/);
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  return new Date(year, Number(match[1]) - 1, Number(match[2]));
}

function _AssignSheet_zissiUrls(zissiId) {
  const result = { drawing: '', staff: '' };
  if (!zissiId) return result;
  try {
    const ss = SpreadsheetApp.openById(zissiId);
    const baseUrl = ss.getUrl();
    result.drawing = baseUrl;
    result.staff = baseUrl;
    const sheets = ss.getSheets();
    for (let i = 0; i < sheets.length; i++) {
      const name = sheets[i].getName();
      if (result.drawing === baseUrl && /施工|図面/.test(name)) result.drawing = PanelLinks_sheetUrl(ss, sheets[i]);
      if (result.staff === baseUrl && name.indexOf('スタッフ') >= 0) result.staff = PanelLinks_sheetUrl(ss, sheets[i]);
    }
  } catch (e) {
    const baseUrl = 'https://docs.google.com/spreadsheets/d/' + zissiId + '/edit';
    result.drawing = baseUrl;
    result.staff = baseUrl;
  }
  return result;
}
