const MAIL_RESPONSE_SHEET_NAME = 'Claude_メール対応';

function _Zissi_open(c) {
  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) {
    try {
      const folder = DriveApp.getFolderById(c.projectFolderId || c.folderId);
      const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
      while (files.hasNext()) {
        const f = files.next();
        if (f.getName().indexOf('実施計画書') >= 0 && f.getName().indexOf('提出') < 0) {
          zissiSs = SpreadsheetApp.openById(f.getId());
          break;
        }
      }
    } catch (e) {}
  }
  if (!zissiSs) {
    throw new Error('実施計画書が見つかりません。先に Phase1 ② 見積初版を生成するか、既存の実施計画を取り込んでください。');
  }
  return zissiSs;
}

function Phase_MailResponse_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  const zissiSs = _Zissi_open(c);

  const context = Case_loadClientContext(c);
  if (!context) {
    throw new Error('お客様のメール・議事録がまだ取り込まれていません。パネルの「📥 最新の打合せ・メールを取り込む」を実行してから再実行してください。');
  }

  const panelLabels = _Panel_features().filter(function (f) {
    return f.command && !f.noCase;
  }).map(function (f) {
    return f.label;
  });
  const userPrompt = [
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '',
    '上記の顧客コンテキスト(打合せ議事録とメールの時系列)から、**お客様から届いた最新のメール**(議事録ではなくメール)を特定し、以下を作成してください。',
    '',
    '(a) そのメールへの返信文ドラフト',
    '- 件名と本文を作る。',
    '- 宛名は「' + c.clientName + ' ご担当者様」とする。',
    '- 丁寧なビジネス日本語で書き、署名は「株式会社オージャスト」で締める。',
    '',
    '(b) メールと直近の議事録から発生する、やるべきタスク一覧',
    '- 担当が「オージャスト側」のものだけを挙げ、期限目安を付ける。',
    '- 各タスクが次の実行パネル機能で実行できる場合、panel_feature に機能ラベルを一字一句正確に入れる。できない場合は空文字にする。',
    '',
    '## 実行パネルで実行できる機能ラベル一覧',
    panelLabels.map(function (label) { return '- ' + label; }).join('\n'),
    '',
    '## 出力形式（厳守・前後の説明文やコードフェンス禁止）',
    '{',
    '  "target_mail": {"date": "<メール日時 or 不明>", "from": "<差出人 or 不明>", "summary": "<メール要旨2-3行>"},',
    '  "reply": {"subject": "<返信件名>", "body": "<返信本文>"},',
    "  \"tasks\": [{\"task\": \"<短いタスク名>\", \"detail\": \"<内容>\", \"due_hint\": \"<期限目安>\", \"panel_feature\": \"<パネル機能ラベル or ''>\"}],",
    '  "confirmations": [{"category": "<カテゴリ>", "content": "<確認事項>"}]',
    '}',
    '',
    'お客様からのメールが1通も見当たらない場合は target_mail.summary に「顧客メールが見つかりません(議事録のみ)」と書き、reply は議事録の直近論点への近況報告メール案にしてください。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: [context],
    userMessage: userPrompt,
    maxTokens: 8000
  });
  const parsed = _Phase1_parseJson(res.text);
  if (!parsed.reply || typeof parsed.reply !== 'object' || Array.isArray(parsed.reply)) {
    throw new Error('応答をJSONとして読めませんでした(出力途切れの可能性)。再実行してください。');
  }

  const targetMail = parsed.target_mail && typeof parsed.target_mail === 'object' ? parsed.target_mail : {};
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const confirmations = Array.isArray(parsed.confirmations) ? parsed.confirmations : [];
  let sheet = zissiSs.getSheetByName(MAIL_RESPONSE_SHEET_NAME);
  if (!sheet) sheet = zissiSs.insertSheet(MAIL_RESPONSE_SHEET_NAME);
  else sheet.clear();

  sheet.getRange('A1').setValue('📧 お客様メール対応').setFontWeight('bold');
  sheet.getRange('B1').setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));

  let row = 3;
  sheet.getRange(row, 1, 1, 4).setBackground('#fff2cc').setFontWeight('bold');
  sheet.getRange(row, 1).setValue('■ 対象メール');
  row++;
  sheet.getRange(row, 1, 3, 2).setValues([
    ['日時', targetMail.date || '不明'],
    ['差出人', targetMail.from || '不明'],
    ['要旨', targetMail.summary || '']
  ]).setWrap(true);

  row += 4;
  sheet.getRange(row, 1, 1, 4).setBackground('#fff2cc').setFontWeight('bold');
  sheet.getRange(row, 1).setValue('■ 返信文ドラフト(コピーして使ってください)');
  row++;
  sheet.getRange(row, 1, 2, 2).setValues([
    ['件名', parsed.reply.subject || ''],
    ['本文', parsed.reply.body || '']
  ]);
  sheet.getRange(row + 1, 2).setWrap(true);

  row += 3;
  sheet.getRange(row, 1, 1, 4).setBackground('#fff2cc').setFontWeight('bold');
  sheet.getRange(row, 1).setValue('■ やるべきタスク');
  row++;
  sheet.getRange(row, 1, 1, 4).setValues([['タスク', '内容', '期限目安', '実行パネルで実行']])
    .setFontWeight('bold').setBackground('#cfe2f3');
  row++;
  if (tasks.length > 0) {
    const taskRows = tasks.map(function (task) {
      return [
        task.task || '',
        task.detail || '',
        task.due_hint || '',
        task.panel_feature ? '▶「' + task.panel_feature + '」をパネルでチェック' : '(手作業)'
      ];
    });
    sheet.getRange(row, 1, taskRows.length, 4).setValues(taskRows).setWrap(true);
    row += taskRows.length;
  }
  sheet.getRange(row, 1).setValue('このタスクは実施計画書「Claude_タスク台帳」にも自動登録されました。残タスクの管理・AI実行はそちらで行ってください（台帳の ▶AI実行 にチェックを入れると最大20分以内に実行されます）').setWrap(true);
  sheet.setColumnWidth(1, 140);
  sheet.setColumnWidth(2, 520);

  const sheetUrl = PanelLinks_sheetUrl(zissiSs, sheet);
  if (confirmations.length > 0) {
    const tagged = confirmations.map(function (x) {
      return { category: '[メール対応] ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  let ledger;
  try {
    ledger = TaskLedger_upsert(caseId, tasks.map(function (task) {
      return { source: 'メール', taskName: String(task.task || '').slice(0, 80), detail: String(task.detail || '').slice(0, 500), evidence: 'メール ' + (targetMail.date || '日時不明') + ' / ' + (targetMail.from || '差出人不明'), due: task.due_hint || '', owner: 'オージャスト', aiFeature: TaskLedger_normalizeFeatureLabel(task.panel_feature), sourceStatus: 'open' };
    }));
  } catch (e) { console.warn('Phase_MailResponse ledger: ' + e); ledger = { error: String(e) }; }
  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, 'メール返信対応',
    (parsed.reply.subject || 'メール返信ドラフト') + ' / タスク' + tasks.length + '件', sheetUrl);

  return {
    sheetUrl: sheetUrl,
    sheetName: MAIL_RESPONSE_SHEET_NAME,
    replySubject: parsed.reply.subject || '',
    taskCount: tasks.length,
    panelTaskCount: tasks.filter(function (task) { return !!task.panel_feature; }).length,
    confirmationCount: confirmations.length,
    usage: res.usage,
    ledger: ledger
  };
}
