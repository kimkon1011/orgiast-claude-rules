/**
 * 顧客宛メールの Discord DM 承認ループ (REBOOTH-T1-mail-approval)
 *
 * 返信案をキューに積み、承認者の Discord DM に提示。
 * OK / 本文差替 / NG を既存の 15 分 sweep で読み取り、
 * 承認されたものだけを送信し、案件シートに記録する。
 */

const MAIL_APPROVAL_SHEET_NAME = 'Claude_送信承認';
const MAIL_APPROVAL_RESPONSE_SHEET_NAME = 'Claude_メール対応';
const MAIL_APPROVAL_DEFAULT_APPROVER_ID = '715210673642012733';
const MAIL_APPROVAL_DEFAULT_CHANNEL_ID = '1525295493364846692';
const MAIL_APPROVAL_DEFAULT_FROM = 'seisaku-team@orgiast.jp';
const MAIL_APPROVAL_SEQ_PROP = 'MAIL_APPROVAL_SEQ';

const MAIL_APPROVAL_COLUMNS = [
  'id', 'caseId', 'status', 'to', 'cc', 'subject', 'body',
  'attachmentIds', 'source', 'createdAt', 'dmMessageId',
  'lastNotifiedAt', 'decidedAt', 'decidedBy', 'sentMessageId', 'note'
];

if (typeof module !== 'undefined' && typeof require === 'function') {
  var _core = require('./MailApprovalCore.js');
  if (typeof MailApproval_checkHoldHuman === 'undefined') MailApproval_checkHoldHuman = _core.MailApproval_checkHoldHuman;
  if (typeof MailApproval_isInternalRecipient === 'undefined') MailApproval_isInternalRecipient = _core.MailApproval_isInternalRecipient;
  if (typeof MailApproval_formatProposalDm === 'undefined') MailApproval_formatProposalDm = _core.MailApproval_formatProposalDm;
  if (typeof MailApproval_splitDm === 'undefined') MailApproval_splitDm = _core.MailApproval_splitDm;
  if (typeof MailApproval_extractId === 'undefined') MailApproval_extractId = _core.MailApproval_extractId;
  if (typeof MailApproval_classifyReply === 'undefined') MailApproval_classifyReply = _core.MailApproval_classifyReply;
  if (typeof MailApproval_shouldRenotify === 'undefined') MailApproval_shouldRenotify = _core.MailApproval_shouldRenotify;
}

/**
 * 外部入出力インターフェース (テスト時に差し替え可能)
 */
var MailApproval_io_ = {
  getScriptProperties: function () {
    return PropertiesService.getScriptProperties();
  },
  getLock: function () {
    return (typeof LockService !== 'undefined') ? LockService.getScriptLock() : null;
  },
  nextId: function () {
    var lock = MailApproval_io_.getLock();
    var locked = false;
    try {
      if (lock) { locked = true; lock.waitLock(10000); }
      var props = MailApproval_io_.getScriptProperties();
      var cur = parseInt(props.getProperty(MAIL_APPROVAL_SEQ_PROP) || '0', 10);
      if (isNaN(cur) || cur < 0) cur = 0;
      var next = cur + 1;
      props.setProperty(MAIL_APPROVAL_SEQ_PROP, String(next));
      return next;
    } catch (e) {
      return Date.now();
    } finally {
      if (locked) { try { lock.releaseLock(); } catch (e) {} }
    }
  },
  getConfig: function () {
    var props = MailApproval_io_.getScriptProperties();
    return {
      botToken: props.getProperty('DISCORD_BOT_TOKEN') || '',
      approverUserId: props.getProperty('APPROVER_DISCORD_USER_ID') || MAIL_APPROVAL_DEFAULT_APPROVER_ID,
      approvalChannelId: props.getProperty('APPROVAL_DM_CHANNEL_ID') || MAIL_APPROVAL_DEFAULT_CHANNEL_ID,
      fromAddress: props.getProperty('MAIL_FROM_ADDRESS') || MAIL_APPROVAL_DEFAULT_FROM,
      lastMessageId: props.getProperty('APPROVAL_LAST_MESSAGE_ID') || ''
    };
  },
  setLastMessageId: function (id) {
    var props = MailApproval_io_.getScriptProperties();
    props.setProperty('APPROVAL_LAST_MESSAGE_ID', String(id || ''));
  },
  postDmMessage: function (token, channelId, content) {
    if (!token || !channelId) return null;
    try {
      var res = UrlFetchApp.fetch('https://discord.com/api/v10/channels/' + encodeURIComponent(String(channelId)) + '/messages', {
        method: 'post',
        headers: { Authorization: 'Bot ' + token },
        contentType: 'application/json',
        payload: JSON.stringify({ content: String(content || '').slice(0, 2000) }),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
        var parsed = JSON.parse(res.getContentText() || '{}');
        return parsed.id || true;
      }
    } catch (e) {
      console.warn('MailApproval postDmMessage error: ' + (e.message || e));
    }
    return null;
  },
  getChannelMessages: function (token, channelId, afterId) {
    if (!token || !channelId) return [];
    try {
      var url = 'https://discord.com/api/v10/channels/' + encodeURIComponent(String(channelId)) + '/messages?limit=50';
      if (afterId) {
        url += '&after=' + encodeURIComponent(String(afterId));
      }
      var res = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Authorization: 'Bot ' + token },
        muteHttpExceptions: true
      });
      if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
        return JSON.parse(res.getContentText() || '[]');
      }
    } catch (e) {
      console.warn('MailApproval getChannelMessages error: ' + (e.message || e));
    }
    return [];
  },
  getFileBlob: function (fileId) {
    return DriveApp.getFileById(String(fileId)).getBlob();
  },
  getSenderAliases: function () {
    try {
      if (typeof GmailApp !== 'undefined' && GmailApp.getAliases) {
        return GmailApp.getAliases() || [];
      }
    } catch (e) {}
    return [];
  },
  sendEmail: function (to, subject, body, options) {
    if (typeof GmailApp !== 'undefined' && GmailApp.sendEmail) {
      GmailApp.sendEmail(to, subject, body, options);
      return true;
    }
    return false;
  },
  openZissi: function (caseId) {
    var c = CaseList_getById(caseId);
    if (!c) throw new Error('案件が見つかりません: ' + caseId);
    return _Zissi_open(c);
  },
  listAllCases: function () {
    if (typeof CaseList_listAll === 'function') {
      return CaseList_listAll() || [];
    }
    return [];
  }
};

/**
 * 送信承認シートの取得または作成
 */
function _MailApproval_ensureSheet(zissiSs) {
  var sheet = zissiSs.getSheetByName(MAIL_APPROVAL_SHEET_NAME);
  if (!sheet) {
    sheet = zissiSs.insertSheet(MAIL_APPROVAL_SHEET_NAME);
    sheet.getRange(1, 1, 1, MAIL_APPROVAL_COLUMNS.length)
      .setValues([MAIL_APPROVAL_COLUMNS])
      .setFontWeight('bold')
      .setBackground('#cfe2f3');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * シート全行をオブジェクト配列で取得
 */
function _MailApproval_loadRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sheet.getLastColumn();
  var numCols = Math.max(lastCol, MAIL_APPROVAL_COLUMNS.length);
  var values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var obj = { _rowIndex: i + 2 };
    for (var c = 0; c < MAIL_APPROVAL_COLUMNS.length; c++) {
      obj[MAIL_APPROVAL_COLUMNS[c]] = r[c] !== undefined ? r[c] : '';
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * 1行を更新保存
 */
function _MailApproval_saveRow(sheet, rowObj) {
  var r = rowObj._rowIndex;
  if (!r) throw new Error('行番号が指定されていません');
  var arr = [];
  for (var c = 0; c < MAIL_APPROVAL_COLUMNS.length; c++) {
    arr.push(rowObj[MAIL_APPROVAL_COLUMNS[c]] !== undefined ? rowObj[MAIL_APPROVAL_COLUMNS[c]] : '');
  }
  sheet.getRange(r, 1, 1, arr.length).setValues([arr]);
}

/**
 * 新規行を追記
 */
function _MailApproval_appendRow(sheet, rowObj) {
  var arr = [];
  for (var c = 0; c < MAIL_APPROVAL_COLUMNS.length; c++) {
    arr.push(rowObj[MAIL_APPROVAL_COLUMNS[c]] !== undefined ? rowObj[MAIL_APPROVAL_COLUMNS[c]] : '');
  }
  sheet.appendRow(arr);
  rowObj._rowIndex = sheet.getLastRow();
  return rowObj;
}

/**
 * 送信案をキューに提案
 * @param {string} caseId
 * @param {object} draft {to, cc, subject, body, attachmentIds, source}
 */
function MailApproval_propose(caseId, draft) {
  var d = draft || {};
  var to = String(d.to || '').trim();
  var cc = String(d.cc || '').trim();
  var subject = String(d.subject || '').trim();
  var body = String(d.body || '').trim();
  var attachmentIds = Array.isArray(d.attachmentIds) ? d.attachmentIds.join(',') : String(d.attachmentIds || '');
  var source = String(d.source || 'mail_response');

  var zissiSs = MailApproval_io_.openZissi(caseId);
  var sheet = _MailApproval_ensureSheet(zissiSs);
  var existingRows = _MailApproval_loadRows(sheet);

  var c = typeof CaseList_getById === 'function' ? CaseList_getById(caseId) : null;
  var clientName = c ? (c.clientName || '') : '';

  // 同一案件で 3 回連続 REJECTED か判定
  var isHoldHuman = MailApproval_checkHoldHuman(existingRows);
  var cfg = MailApproval_io_.getConfig();

  if (isHoldHuman) {
    var holdId = MailApproval_io_.nextId();
    var nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    var holdRow = {
      id: holdId, caseId: caseId, status: 'HOLD_HUMAN',
      to: to, cc: cc, subject: subject, body: body, attachmentIds: attachmentIds,
      source: source, createdAt: nowStr, dmMessageId: '', lastNotifiedAt: nowStr,
      decidedAt: '', decidedBy: '', sentMessageId: '', note: 'REJECTED 3回連続のため自動保留'
    };
    _MailApproval_appendRow(sheet, holdRow);
    var holdMsg = '【人の対応に切替】案件 ' + caseId + ' ' + clientName + '\n送信案が3回連続で保留(REJECTED)されたため、送信キューを停止しました。手動で確認・対応してください。';
    MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, holdMsg);
    return { ok: true, status: 'HOLD_HUMAN', id: holdId };
  }

  // 内部宛（@orgiast.jp）判定
  var recipients = [to, cc].filter(Boolean).join(',');
  var isInternal = MailApproval_isInternalRecipient(recipients);

  var nextId = MailApproval_io_.nextId();
  var now = new Date();
  var createdAtStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

  var status = isInternal ? 'INTERNAL_DISPLAY_ONLY' : 'PENDING';
  var initialRow = {
    id: nextId,
    caseId: caseId,
    status: status,
    to: to,
    cc: cc,
    subject: subject,
    body: body,
    attachmentIds: attachmentIds,
    source: source,
    createdAt: createdAtStr,
    dmMessageId: '',
    lastNotifiedAt: createdAtStr,
    decidedAt: '',
    decidedBy: '',
    sentMessageId: '',
    note: isInternal ? '内部宛のため送信対象外' : ''
  };

  _MailApproval_appendRow(sheet, initialRow);

  // DM メッセージ作成＆送信
  var formatted = MailApproval_formatProposalDm({
    id: nextId,
    caseId: caseId,
    clientName: clientName,
    to: to,
    cc: cc,
    subject: subject,
    body: body,
    attachments: attachmentIds ? attachmentIds.split(',') : [],
    isInternal: isInternal
  });

  var chunks = MailApproval_splitDm(formatted, nextId, 1900);
  var lastSentDmId = '';
  for (var i = 0; i < chunks.length; i++) {
    var dmRes = MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, chunks[i]);
    if (dmRes && typeof dmRes === 'string') {
      lastSentDmId = dmRes;
    }
  }

  if (lastSentDmId) {
    initialRow.dmMessageId = lastSentDmId;
    _MailApproval_saveRow(sheet, initialRow);
  }

  return {
    ok: true,
    id: nextId,
    status: status,
    isInternal: isInternal
  };
}

/**
 * 最新のお客様メール対応シートから返信文案を読み取り、送信承認を申請する
 * @param {string} caseId
 * @param {object|string|Array} [options] 添付ファイルID一覧などのオプション
 */
function MailApproval_proposeFromLatest(caseId, options) {
  var zissiSs = MailApproval_io_.openZissi(caseId);
  var sheet = zissiSs.getSheetByName(MAIL_APPROVAL_RESPONSE_SHEET_NAME);
  if (!sheet) {
    return { ok: false, error: 'Claude_メール対応 がありません。先に「お客様メールの返信文とタスクを作る」を実行してください' };
  }

  function _getVal(cellA1, r, c) {
    try {
      if (typeof sheet.getRange === 'function') {
        var range = sheet.getRange(cellA1);
        if (range && typeof range.getValue === 'function') {
          return range.getValue();
        }
      }
    } catch (e) {}
    try {
      if (typeof sheet.getRange === 'function') {
        var range2 = sheet.getRange(r, c);
        if (range2 && typeof range2.getValue === 'function') {
          return range2.getValue();
        }
      }
    } catch (e) {}
    return '';
  }

  var rawFrom = String(_getVal('B5', 5, 2) || '').trim();
  var rawSubject = String(_getVal('B8', 8, 2) || '').trim();
  var rawBody = String(_getVal('B9', 9, 2) || '').trim();

  if (!rawSubject && !rawBody) {
    return { ok: false, error: '返信文ドラフトが空です。先に返信文を生成してください' };
  }

  var to = rawFrom;
  var emailMatch = rawFrom.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) {
    to = emailMatch[0];
  }

  var attachmentIds = '';
  if (options) {
    if (typeof options === 'string' || Array.isArray(options)) {
      attachmentIds = options;
    } else if (options.attachmentIds) {
      attachmentIds = options.attachmentIds;
    }
  }
  // options で指定されていない場合、案件フォルダ直下の見積・請求・申込書PDFなどの添付候補を探索
  if (!attachmentIds) {
    try {
      var c = typeof CaseList_getById === 'function' ? CaseList_getById(caseId) : null;
      if (c) {
        var folderId = c.projectFolderId || c.folderId;
        if (folderId && typeof DriveApp !== 'undefined') {
          var folder = DriveApp.getFolderById(folderId);
          if (folder && typeof _CoverLetter_recentFiles === 'function') {
            var recentFiles = _CoverLetter_recentFiles(folder);
            attachmentIds = (recentFiles || []).map(function (f) { return f.id; }).filter(Boolean).join(',');
          }
        }
      }
    } catch (e) {
      console.warn('MailApproval_proposeFromLatest 添付探索スキップ: ' + e);
    }
  }

  return MailApproval_propose(caseId, {
    to: to,
    subject: rawSubject,
    body: rawBody,
    attachmentIds: attachmentIds,
    source: 'mail_response'
  });
}

/**
 * 承認メールの送信処理
 */
function MailApproval_send_(row) {
  // 内部宛（@orgiast.jp）二重ガード: 送信直前にも宛先・CCに @orgiast.jp が含まれないことを必ず検証する
  var recipients = [row.to, row.cc].filter(Boolean).join(',');
  if (MailApproval_isInternalRecipient(recipients)) {
    return { ok: false, error: '内部宛（@orgiast.jp）のため送信を中止しました' };
  }

  var cfg = MailApproval_io_.getConfig();
  var targetFrom = cfg.fromAddress || MAIL_APPROVAL_DEFAULT_FROM;
  var aliases = MailApproval_io_.getSenderAliases();

  var canSendFromTarget = (aliases.indexOf(targetFrom) >= 0);
  if (!canSendFromTarget) {
    // 送信元エイリアスが無い場合は APPROVED_WAITING_SENDER にする
    return { ok: false, waitingSender: true, reason: 'no_alias' };
  }

  try {
    var options = {
      from: targetFrom
    };
    if (row.cc) options.cc = row.cc;

    // 添付の解決。1つでも取得できない時は送信しない (中身が欠けたまま顧客に送るより安全側)
    if (row.attachmentIds) {
      var ids = String(row.attachmentIds).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var blobs = [];
      for (var i = 0; i < ids.length; i++) {
        try {
          blobs.push(MailApproval_io_.getFileBlob(ids[i]));
        } catch (e) {
          return { ok: false, error: '添付を取得できません: ' + ids[i] + ' (' + (e.message || e) + ')' };
        }
      }
      if (blobs.length) options.attachments = blobs;
    }

    MailApproval_io_.sendEmail(row.to, row.subject, row.body, options);
    var sentId = 'local-' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
    return { ok: true, sentMessageId: sentId };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 送信完了後の記録（Claude_メール対応 シート追記）
 */
function _MailApproval_recordToMailResponseSheet(caseId, sentRow) {
  try {
    var zissiSs = MailApproval_io_.openZissi(caseId);
    var sheet = zissiSs.getSheetByName(MAIL_APPROVAL_RESPONSE_SHEET_NAME);
    if (!sheet) {
      sheet = zissiSs.insertSheet(MAIL_APPROVAL_RESPONSE_SHEET_NAME);
    }
    var nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    sheet.appendRow(['送信済み', nowStr, sentRow.subject || '', sentRow.sentMessageId || '']);
  } catch (e) {
    console.warn('MailApproval _MailApproval_recordToMailResponseSheet error: ' + (e.message || e));
  }
}

/**
 * 全案件から PENDING な送信承認行を探索
 */
function _MailApproval_collectAllPending() {
  var cases = MailApproval_io_.listAllCases();
  var pendingList = [];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    if (!c.caseId) continue;
    try {
      var zissiSs = MailApproval_io_.openZissi(c.caseId);
      var sheet = zissiSs.getSheetByName(MAIL_APPROVAL_SHEET_NAME);
      if (!sheet) continue;
      var rows = _MailApproval_loadRows(sheet);
      for (var j = 0; j < rows.length; j++) {
        if (String(rows[j].status || '').toUpperCase() === 'PENDING') {
          pendingList.push({
            caseId: c.caseId,
            sheet: sheet,
            row: rows[j]
          });
        }
      }
    } catch (e) {}
  }
  return pendingList;
}

/**
 * Discord DM の新着をポーリングして承認・差替・却下を処理
 */
function MailApproval_poll() {
  var cfg = MailApproval_io_.getConfig();
  if (!cfg.botToken || !cfg.approvalChannelId) {
    return { ok: false, skipped: 'no_config' };
  }

  var messages = MailApproval_io_.getChannelMessages(cfg.botToken, cfg.approvalChannelId, cfg.lastMessageId);
  if (!messages || !messages.length) {
    return { ok: true, processed: 0 };
  }

  // Discord messages は新しい順(降順)で返ってくるので昇順に並べ替える
  messages.sort(function (a, b) {
    return String(a.id).localeCompare(String(b.id));
  });

  var approverId = String(cfg.approverUserId || '');
  var lastHandledMsgId = cfg.lastMessageId;
  var processedCount = 0;
  var allPending = null;

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var currentMsgId = String(msg.id);

    // 承認者本人の発言のみ対象（それ以外の発言は処理対象外として安全に既読進める）
    var authorId = msg.author ? String(msg.author.id) : '';
    if (authorId !== approverId) {
      lastHandledMsgId = currentMsgId;
      MailApproval_io_.setLastMessageId(lastHandledMsgId);
      continue;
    }

    var content = String(msg.content || '').trim();
    if (!content) {
      lastHandledMsgId = currentMsgId;
      MailApproval_io_.setLastMessageId(lastHandledMsgId);
      continue;
    }

    var targetId = MailApproval_extractId(content);
    if (allPending === null) {
      allPending = _MailApproval_collectAllPending();
    }

    if (!allPending.length) {
      // 未承認がなければ以後のメッセージも処理できないため終了（既読位置は進めない）
      break;
    }

    var targetItem = null;
    if (targetId) {
      for (var p = 0; p < allPending.length; p++) {
        if (String(allPending[p].row.id) === String(targetId)) {
          targetItem = allPending[p];
          break;
        }
      }
    } else {
      if (allPending.length === 1) {
        targetItem = allPending[0];
      } else {
        // PENDING が 2 件以上で ID 指定がない場合は聞き返す
        MailApproval_io_.postDmMessage(
          cfg.botToken,
          cfg.approvalChannelId,
          '未承認の案件が複数あります。対象の番号を #A<番号> で指定して返信してください。'
        );
        lastHandledMsgId = currentMsgId;
        MailApproval_io_.setLastMessageId(lastHandledMsgId);
        continue;
      }
    }

    if (!targetItem) {
      if (targetId) {
        var pendingIdsStr = allPending.map(function (it) {
          return '#A' + (it.row ? it.row.id : '');
        }).join(', ');
        MailApproval_io_.postDmMessage(
          cfg.botToken,
          cfg.approvalChannelId,
          '#A' + targetId + ' は未承認の一覧に見つかりません。現在の未承認: ' + pendingIdsStr
        );
      }
      lastHandledMsgId = currentMsgId;
      MailApproval_io_.setLastMessageId(lastHandledMsgId);
      continue;
    }

    var classification = MailApproval_classifyReply(content);
    var nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    var row = targetItem.row;
    var sheet = targetItem.sheet;
    var caseId = targetItem.caseId;

    if (classification.action === 'APPROVED') {
      row.status = 'APPROVED';
      row.decidedAt = nowStr;
      row.decidedBy = authorId;

      var sendResult = MailApproval_send_(row);
      if (sendResult.ok) {
        row.status = 'SENT';
        row.sentMessageId = sendResult.sentMessageId || '';
        var noteNotice = 'Gmail messageId は gmail.compose 権限では取得不可のため送信ローカル時刻を記録';
        row.note = row.note ? (row.note + ' / ' + noteNotice) : noteNotice;
        _MailApproval_recordToMailResponseSheet(caseId, row);
        MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, '【送信完了】#A' + row.id + ' 案件 ' + caseId + ' のメールを送信しました。');
      } else if (sendResult.waitingSender) {
        row.status = 'APPROVED_WAITING_SENDER';
        row.note = (row.note ? row.note + ' / ' : '') + '送信元エイリアス未設定のため待機';
        MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, '【承認済・送信待機】#A' + row.id + ' 送信元エイリアスが未設定のため、Claude Code (seisaku-team@) 送信待ちに移行しました。');
      } else {
        row.note = (row.note ? row.note + ' / ' : '') + '送信失敗: ' + sendResult.error;
        MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, '【送信エラー】#A' + row.id + ' ' + sendResult.error);
      }
      _MailApproval_saveRow(sheet, row);
      processedCount++;
      allPending = allPending.filter(function (it) { return it !== targetItem; });
      lastHandledMsgId = currentMsgId;
      MailApproval_io_.setLastMessageId(lastHandledMsgId);
    } else if (classification.action === 'REPLACEMENT') {
      var oldBody = row.body;
      row.body = classification.cleanText;
      row.note = (row.note ? row.note + '\n' : '') + '[元本文]\n' + oldBody;
      row.status = 'APPROVED';
      row.decidedAt = nowStr;
      row.decidedBy = authorId;

      var sendResult2 = MailApproval_send_(row);
      if (sendResult2.ok) {
        row.status = 'SENT';
        row.sentMessageId = sendResult2.sentMessageId || '';
        var noteNotice2 = 'Gmail messageId は gmail.compose 権限では取得不可のため送信ローカル時刻を記録';
        row.note = row.note ? (row.note + ' / ' + noteNotice2) : noteNotice2;
        _MailApproval_recordToMailResponseSheet(caseId, row);
        MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, '【差替送信完了】#A' + row.id + ' 本文を差し替えてメールを送信しました。');
      } else if (sendResult2.waitingSender) {
        row.status = 'APPROVED_WAITING_SENDER';
        row.note = (row.note ? row.note + ' / ' : '') + '送信元エイリアス未設定のため待機';
        MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, '【承認済・差替・送信待機】#A' + row.id + ' 送信元エイリアスが未設定のため待機中です。');
      } else {
        row.note = (row.note ? row.note + ' / ' : '') + '差替送信失敗: ' + sendResult2.error;
        MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, '【送信エラー】#A' + row.id + ' ' + sendResult2.error);
      }
      _MailApproval_saveRow(sheet, row);
      processedCount++;
      allPending = allPending.filter(function (it) { return it !== targetItem; });
      lastHandledMsgId = currentMsgId;
      MailApproval_io_.setLastMessageId(lastHandledMsgId);
    } else if (classification.action === 'REJECTED') {
      row.status = 'REJECTED';
      row.decidedAt = nowStr;
      row.decidedBy = authorId;
      _MailApproval_saveRow(sheet, row);
      MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, '【保留】#A' + row.id + ' 案件 ' + caseId + ' の送信を保留にしました。');
      processedCount++;
      allPending = allPending.filter(function (it) { return it !== targetItem; });
      lastHandledMsgId = currentMsgId;
      MailApproval_io_.setLastMessageId(lastHandledMsgId);
    }
  }

  return { ok: true, processed: processedCount };
}

/**
 * 未承認のまま 24 時間経過したものを 1 日 1 回だけ再 DM 通知
 */
function MailApproval_renotify() {
  var cfg = MailApproval_io_.getConfig();
  if (!cfg.botToken || !cfg.approvalChannelId) {
    return { ok: false, skipped: 'no_config' };
  }

  var allPending = _MailApproval_collectAllPending();
  var now = new Date();
  var renotifiedCount = 0;

  for (var i = 0; i < allPending.length; i++) {
    var item = allPending[i];
    var row = item.row;
    if (MailApproval_shouldRenotify(row, now)) {
      var renotifyMsg = '【未承認のまま 24h 経過】#A' + row.id + ' 案件 ' + item.caseId + ' の送信承認が未完了です。\n件名: ' + (row.subject || '') + '\n返信: OK＝送信 / NG＝保留 / 本文を返信＝差し替えて送信';
      MailApproval_io_.postDmMessage(cfg.botToken, cfg.approvalChannelId, renotifyMsg);
      row.lastNotifiedAt = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
      _MailApproval_saveRow(item.sheet, row);
      renotifiedCount++;
    }
  }

  return { ok: true, renotified: renotifiedCount };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MailApproval_io_: MailApproval_io_,
    MailApproval_propose: MailApproval_propose,
    MailApproval_proposeFromLatest: MailApproval_proposeFromLatest,
    MailApproval_poll: MailApproval_poll,
    MailApproval_renotify: MailApproval_renotify,
    MailApproval_send_: MailApproval_send_,
    MAIL_APPROVAL_COLUMNS: MAIL_APPROVAL_COLUMNS
  };
}
