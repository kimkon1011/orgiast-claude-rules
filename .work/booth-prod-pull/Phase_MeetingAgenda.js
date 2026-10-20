const MEETING_AGENDA_SHEET_NAME = 'Claude_次回MTGアジェンダ';
const _MEETING_AGENDA_MASTER_SS = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
// master task シート: 行11=ヘッダー/集計、行12=イベント列ブロック見出し、行13〜=実タスク
const _MEETING_AGENDA_TASK_START_ROW = 13;
const _MEETING_AGENDA_TASK_GAP_LIMIT = 3;

function Phase_MeetingAgenda_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  const zissiSs = _Zissi_open(c);
  const context = Case_loadClientContext(c);
  if (!context) {
    throw new Error('お客様のメール・議事録がまだ取り込まれていません。パネルの「📥 最新の打合せ・メールを取り込む」を実行してから再実行してください。');
  }
  const contextTruncated = context.length >= 11500;
  const master = _MeetingAgenda_loadMaster(c);
  const artifacts = _MeetingAgenda_loadArtifacts(caseId);
  const panelLabels = _Panel_features().filter(function (f) {
    return f.command && !f.noCase;
  }).map(function (f) {
    return f.label;
  });
  const promptTasks = master.openTasks.slice(0, 60);
  const omittedTaskCount = Math.max(0, master.openTasks.length - promptTasks.length);
  const daysToShowtime = _MeetingAgenda_daysToShowtime(c.startDate);

  const prompt = [
    '## 案件情報',
    '- クライアント: ' + (c.clientName || '未確定'),
    '- 案件名: ' + (c.caseName || '未確定'),
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '- 次回MTG日: ' + (master.nextMeetingDate || '未定'),
    '- 本番までの残日数: ' + daysToShowtime,
    '- 会場: ' + (master.venue || '未確定'),
    '- 設営日: ' + (master.setupDate || '未確定'),
    '',
    '上記の顧客コンテキスト(打合せ議事録とメールの時系列)を読み、次回ミーティングのアジェンダを作成してください。',
    '',
    '## master の未完了タスク一覧(タスク名 / フェーズ)',
    promptTasks.length > 0 ? promptTasks.map(function (task) {
      return '- ' + task.taskName + ' / ' + (task.phase || 'フェーズ不明');
    }).join('\n') : '- なし' + (master.linked ? '' : '(master 未連携)'),
    omittedTaskCount > 0 ? '- 上記以外に ' + omittedTaskCount + ' 件あり(件数のみ共有)' : null,
    '',
    '## これまで作った書類(成果物タイプ / 生成日時)',
    artifacts.length > 0 ? artifacts.map(function (artifact) {
      return '- ' + artifact.artifactType + ' / ' + artifact['生成日時'];
    }).join('\n') : '- なし',
    '',
    '## 実行パネルで実行できる機能ラベル一覧',
    panelLabels.map(function (label) { return '- ' + label; }).join('\n'),
    '',
    '## 抽出・構成ルール',
    '- open_tasks は議事録・メールの中で依頼/宿題/持ち帰りとして出たものを全部拾い、その後の議事録・メールで完了が確認できたものを除外する。未完了とする各項目の evidence に判断根拠を書く。完了か未完了か判断できない場合は未完了側に倒し、evidence に「完了の確認が取れない」と書く。取りこぼしより過剰検出を優先する。',
    '- plan_updates は、議事録で決まっている、またはメールで指示されているのに、既存の書類一覧を見る限りその決定の後に作り直されていない書類を挙げる。生成日時より新しい決定があるものを候補にする。',
    '- plan_updates の action は「再生成」「手修正」のどちらかだけを使う。',
    '- panel_feature は上記の機能ラベル一覧の文字列と一字一句一致させる。該当が無ければ空文字にする。',
    '- open_tasks の owner は「オージャスト」「クライアント」「外部」のいずれか、agenda の purpose は「決定」「共有」「確認」のいずれかにする。',
    '- agenda は、①open_tasks のうち会議で詰める必要があるもの、②master の未完了タスクのうち本番日から逆算して次回MTGまでに決めないと間に合わないもの、③議事録で「保留」「次回」「追って」となっている論点、の3つを材料にする。合計 minutes が recommended_minutes に収まるよう4〜7件に絞り、重要な順に並べる。',
    '- 顧客コンテキストに無い事実を推測で断定しない。不明な点は本文に書かず confirmations に入れる。',
    '',
    '## 出力形式（厳守・前後の説明文やコードフェンス禁止）',
    '{',
    '  "meeting": {"next_date": "<次回MTG日 or 未定>", "days_to_showtime": "<本番まで n 日 or 不明>", "recommended_minutes": 30},',
    '  "plan_updates": [{"topic": "<何の話か>", "decided_fact": "<議事録/メールで決まった事実>", "source": "<出典 例: 8/17 打合せ / 8/19 メール>", "target_document": "<反映先の書類名 例: 実施計画書 アイテムリスト>", "panel_feature": "<パネル機能ラベル or 空文字>", "action": "再生成", "reason": "<なぜ更新が必要か 1行>"}],',
    '  "open_tasks": [{"task": "<宿題・タスク>", "owner": "オージャスト", "raised_at": "<いつの議事録/メールで出たか>", "evidence": "<未完了と判断した根拠>", "due_hint": "<期限目安>"}],',
    '  "agenda": [{"no": 1, "title": "<議題>", "purpose": "決定", "background": "<背景 1-2行>", "decide": "<この場で決めること。決定でなければ空文字>", "options": "<選択肢があれば。無ければ空文字>", "minutes": 10}],',
    '  "confirmations": [{"category": "<カテゴリ>", "content": "<確認事項>"}]',
    '}'
  ].filter(function (line) { return line !== null; }).join('\n');

  const res = ClaudeClient_call({
    cachedContext: [context],
    userMessage: prompt,
    maxTokens: 8000
  });
  const parsed = _Phase1_parseJson(res.text);
  if (!parsed.meeting || typeof parsed.meeting !== 'object' || Array.isArray(parsed.meeting)) {
    throw new Error('応答をJSONとして読めませんでした(出力途切れの可能性)。再実行してください。');
  }
  const meeting = parsed.meeting;
  const agenda = Array.isArray(parsed.agenda) ? parsed.agenda : [];
  const openTasks = Array.isArray(parsed.open_tasks) ? parsed.open_tasks : [];
  const planUpdates = Array.isArray(parsed.plan_updates) ? parsed.plan_updates : [];
  const confirmations = Array.isArray(parsed.confirmations) ? parsed.confirmations : [];

  let sheet = zissiSs.getSheetByName(MEETING_AGENDA_SHEET_NAME);
  if (!sheet) sheet = zissiSs.insertSheet(MEETING_AGENDA_SHEET_NAME);
  else sheet.clear();
  sheet.getRange('A1').setValue('🗓 次回ミーティング アジェンダ').setFontWeight('bold');
  sheet.getRange('B1').setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));

  let row = 3;
  row = _MeetingAgenda_section(sheet, row, '■ 次回MTG');
  const meetingRows = [
    ['日時', meeting.next_date || master.nextMeetingDate || '未定'],
    ['本番まで残り', meeting.days_to_showtime || daysToShowtime],
    ['想定所要', String(meeting.recommended_minutes || 30) + '分'],
    ['会場', master.venue || '未確定'],
    ['設営日', master.setupDate || '未確定']
  ];
  if (contextTruncated) {
    meetingRows.push(['⚠', '議事録が多く一部が読み込み上限で省略されています(古い回の宿題は取りこぼす可能性があります)']);
  }
  sheet.getRange(row, 1, meetingRows.length, 2).setValues(meetingRows).setWrap(true);
  row += meetingRows.length + 1;

  row = _MeetingAgenda_table(sheet, row, '■ アジェンダ',
    ['No', '議題', '目的', '背景', 'この場で決めること', '選択肢', '所要分'],
    agenda.map(function (item, i) {
      return [item.no || i + 1, item.title || '', item.purpose || '', item.background || '', item.decide || '', item.options || '', item.minutes || ''];
    }));
  row = _MeetingAgenda_table(sheet, row, '■ 未完了のタスク・宿題（議事録から）',
    ['タスク', '担当', 'いつ出た', '未完了と判断した根拠', '期限目安'],
    openTasks.map(function (task) {
      return [task.task || '', task.owner || '', task.raised_at || '', task.evidence || '', task.due_hint || ''];
    }));
  row = _MeetingAgenda_table(sheet, row, '■ 残っている工程タスク（タスク進捗管理表から）',
    ['フェーズ', 'タスク', '状態'],
    master.linked ? master.openTasks.map(function (task) {
      return [task.phase || '', task.taskName || '', task.status || ''];
    }) : [['', 'master 未連携のため残タスクは取得できませんでした', '']]);
  row = _MeetingAgenda_table(sheet, row, '■ 書類の更新が必要なもの',
    ['書類', '更新理由', '出典', '対応'],
    planUpdates.map(function (item) {
      return [
        item.target_document || '',
        item.reason || '',
        item.source || '',
        item.panel_feature ? '▶「' + item.panel_feature + '」をパネルでチェック' : '(手作業)'
      ];
    }));
  sheet.getRange(row, 1).setValue('更新は 🚀実行パネルでイベントを選び、該当機能の▶をチェックすると実行されます（このシートは書類を自動では書き換えません）').setWrap(true);
  sheet.setColumnWidth(1, 140);
  sheet.setColumnWidth(2, 420);
  sheet.getDataRange().setWrap(true);

  const sheetUrl = PanelLinks_sheetUrl(zissiSs, sheet);
  if (confirmations.length > 0) {
    const tagged = confirmations.map(function (x) {
      return { category: '[次回MTG] ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  let ledger;
  try {
    const ledgerItems = openTasks.map(function (task) {
      return { source: '議事録', taskName: String(task.task || '').slice(0, 80), detail: String('未完了と判断した根拠: ' + (task.evidence || '')).slice(0, 500), evidence: task.raised_at || '', due: task.due_hint || '', owner: task.owner === 'クライアント' ? 'お客様' : 'オージャスト', aiFeature: '', sourceStatus: 'open' };
    }).concat(planUpdates.map(function (item) {
      return { source: '書類更新', taskName: String('書類更新: ' + (item.target_document || '')).slice(0, 80), detail: String((item.reason || '') + ' / 決定事実: ' + (item.decided_fact || '') + ' / 対応: ' + (item.action || '')).slice(0, 500), evidence: item.source || '', due: '', owner: 'オージャスト', aiFeature: item.action === '再生成' ? TaskLedger_normalizeFeatureLabel(item.panel_feature) : '', sourceStatus: 'open' };
    }));
    ledger = TaskLedger_upsert(caseId, ledgerItems);
  } catch (e) { console.warn('Phase_MeetingAgenda ledger: ' + e); ledger = { error: String(e) }; }
  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, '次回MTGアジェンダ',
    '議題' + agenda.length + '件 / 未完了' + openTasks.length + '件', sheetUrl);

  return {
    sheetUrl: sheetUrl,
    sheetName: MEETING_AGENDA_SHEET_NAME,
    nextMeetingDate: meeting.next_date || master.nextMeetingDate || '未定',
    agendaCount: agenda.length,
    openTaskCount: openTasks.length,
    masterOpenTaskCount: master.openTasks.length,
    planUpdateCount: planUpdates.length,
    confirmationCount: confirmations.length,
    usage: res.usage,
    ledger: ledger
  };
}

function _MeetingAgenda_loadMaster(c) {
  const result = { linked: Boolean(c.masterCol), nextMeetingDate: '', venue: '', setupDate: '', openTasks: [] };
  if (!c.masterCol) return result;
  const sheet = SpreadsheetApp.openById(_MEETING_AGENDA_MASTER_SS).getSheetByName('task');
  if (!sheet) throw new Error('master タスク進捗管理表の「task」シートが見つかりません');
  const col = Number(c.masterCol);
  result.venue = String(sheet.getRange(3, col).getDisplayValue() || '');
  result.setupDate = String(sheet.getRange(4, col).getDisplayValue() || '');
  // 行9 = 次MTG日(実施計画書から IMPORTRANGE で引く式)。式が壊れている列が多く
  // #N/A / #REF! がそのまま表示値になるため、エラー値は未定として扱う。
  const nextMeeting = String(sheet.getRange(9, col).getDisplayValue() || '').trim();
  result.nextMeetingDate = nextMeeting.charAt(0) === '#' ? '' : nextMeeting;
  const lastRow = sheet.getLastRow();
  if (lastRow < _MEETING_AGENDA_TASK_START_ROW) return result;
  // 行12 = 各イベント列ブロックの見出し(名前/日付/進捗)。実タスクは行13から。
  // 行232前後で本体ブロックが終わり、その下に集計対象外の旧タスク行が残っているため
  // (シート自身の集計式も CC15:CC234 までしか数えていない)、D列の空行が
  // _MEETING_AGENDA_TASK_GAP_LIMIT 行続いたらそこで打ち切る。
  const rowCount = lastRow - _MEETING_AGENDA_TASK_START_ROW + 1;
  const taskInfo = sheet.getRange(_MEETING_AGENDA_TASK_START_ROW, 1, rowCount, 5).getDisplayValues();
  const eventValues = sheet.getRange(_MEETING_AGENDA_TASK_START_ROW, col, rowCount, 3).getDisplayValues();
  let emptyRun = 0;
  for (let i = 0; i < rowCount; i++) {
    const taskName = String(taskInfo[i][3] || '').trim();
    if (!taskName) {
      emptyRun++;
      if (emptyRun >= _MEETING_AGENDA_TASK_GAP_LIMIT) break;
      continue;
    }
    emptyRun = 0;
    if (String(taskInfo[i][4] || '').indexOf('不要') >= 0) continue;
    const cells = eventValues[i].map(function (value) { return String(value || '').trim(); });
    // 3列ブロックは [担当者名, 日付, 進捗]。進捗列(3列目)が状態の正。
    // 並び順が変わっても壊れないよう、3列のどこに済/不要があっても拾う。
    let status = '着手中';
    if (cells.some(function (value) { return value.indexOf('不要') >= 0; })) status = '対象外';
    else if (cells.some(function (value) { return value.indexOf('済') >= 0; })) status = '完了';
    else if (cells.every(function (value) { return !value; })) status = '未着手';
    if (status === '未着手' || status === '着手中') {
      result.openTasks.push({
        taskName: taskName,
        category: String(taskInfo[i][0] || ''),
        phase: String(taskInfo[i][1] || ''),
        status: status
      });
    }
  }
  result.openTasks.sort(function (a, b) { return a.phase.localeCompare(b.phase, 'ja'); });
  return result;
}

function _MeetingAgenda_loadArtifacts(caseId) {
  const sheet = SpreadsheetApp.openById(_MEETING_AGENDA_MASTER_SS).getSheetByName(_MASTER_ARTIFACT_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  return values.filter(function (row) {
    return String(row[0]) === String(caseId);
  }).map(function (row) {
    const generatedAt = row[6] instanceof Date
      ? Utilities.formatDate(row[6], 'Asia/Tokyo', 'yyyy/MM/dd HH:mm') : String(row[6] || '');
    return { artifactType: String(row[3] || ''), summary: String(row[4] || ''), url: String(row[5] || ''), '生成日時': generatedAt };
  });
}

function _MeetingAgenda_daysToShowtime(startDate) {
  const date = startDate instanceof Date ? startDate : new Date(startDate);
  if (!startDate || isNaN(date.getTime())) return '不明';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const showtime = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return '本番まで ' + Math.ceil((showtime.getTime() - today.getTime()) / 86400000) + ' 日';
}

function _MeetingAgenda_section(sheet, row, title) {
  sheet.getRange(row, 1, 1, 7).setBackground('#fff2cc').setFontWeight('bold');
  sheet.getRange(row, 1).setValue(title);
  return row + 1;
}

function _MeetingAgenda_table(sheet, row, title, headers, rows) {
  row = _MeetingAgenda_section(sheet, row, title);
  sheet.getRange(row, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#cfe2f3');
  row++;
  if (rows.length > 0) {
    sheet.getRange(row, 1, rows.length, headers.length).setValues(rows).setWrap(true);
    row += rows.length;
  }
  return row + 1;
}
