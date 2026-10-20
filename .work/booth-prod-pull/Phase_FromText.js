function _FromText_enqueue(command, args) {
  var payload = JSON.stringify({ command: command, args: args || [] });
  var name = 'cmd_' + Utilities.getUuid().replace(/-/g, '') + '.json';
  DriveApp.getFolderById(CMD_FOLDER_ID).createFile(Utilities.newBlob(payload, 'application/json', name));
  return true;
}

function _FromText_normalizeDocuments(documents) {
  var allowed = { estimate: true, invoice: true, coverLetter: true }, seen = {};
  return (Array.isArray(documents) ? documents : []).filter(function (name) {
    name = String(name || '');
    if (!allowed[name] || seen[name]) return false;
    seen[name] = true; return true;
  });
}

function _FromText_emptyMessage() { return '下の「📝 …ここに貼る」欄にお客様の文章か口頭メモを貼ってから、もう一度 ▶ を押してください'; }

function Phase_FromText_generate(caseId) {
  var panel = _PanelInput_currentSheet();
  var pastedText = panel ? PanelInput_read(panel) : '';
  if (!pastedText) { var emptyMessage = _FromText_emptyMessage(); return { ok: false, message: emptyMessage, panelStatus: emptyMessage }; }
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  var response = ClaudeClient_call({
    cachedContext: [Case_loadClientContext(c)],
    userMessage: [
      '次のお客様文章または口頭メモから、作るべき書類を判定してください。',
      '金額・仕様・数量の相談 => estimate。「請求書を送ってほしい」・支払い・インボイス => invoice。送付文・メール文・送りたい => coverLetter。',
      '判断できない場合は estimate を既定にせず documents: [] にすること。複数でもよい。',
      '返値はJSONのみ: {"documents":["estimate"|"invoice"|"coverLetter"],"reason":"...","summary":"..."}',
      '', '【判定対象】', pastedText.slice(0, 12000)
    ].join('\n'), maxTokens: 1200
  });
  var decision = _Phase1_parseJson(response.text);
  var documents = _FromText_normalizeDocuments(decision.documents);
  if (!documents.length) {
    var question = '何を作ればよいか判断できませんでした。見積書・請求書・送付文のどれを作りますか？';
    return { ok: false, message: question, panelStatus: question, reason: decision.reason || '', summary: decision.summary || '' };
  }
  var commands = { estimate: 'Phase1_Estimate_generate', invoice: 'Phase_Invoice_generate', coverLetter: 'Phase_CoverLetter_generate' };
  var functions = { estimate: Phase1_Estimate_generate, invoice: Phase_Invoice_generate, coverLetter: Phase_CoverLetter_generate };
  var first = documents[0];
  var result = functions[first](caseId, pastedText) || {};
  var queued = [];
  documents.slice(1).forEach(function (doc) { _FromText_enqueue(commands[doc], [caseId, pastedText]); queued.push(doc); });
  result.ok = result.ok !== false;
  result.documents = documents;
  result.queuedDocuments = queued;
  result.reason = decision.reason || '';
  result.summary = decision.summary || '';
  result.panelStatus = '✅ ' + first + ' を作成' + (queued.length ? '／' + queued.join(', ') + ' は順番待ち' : '');
  return result;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { _FromText_normalizeDocuments: _FromText_normalizeDocuments, _FromText_emptyMessage: _FromText_emptyMessage };
