/**
 * 顧客宛メール送信の承認判定・テキスト処理・純粋関数群
 * (GAS / Node 両対応)
 */

/**
 * 宛先リスト (to, cc 等、配列またはカンマ区切り文字列) に @orgiast.jp が含まれるか判定。
 * 1つでも含まれれば内部宛とみなす。
 * @param {string|string[]} list
 * @return {boolean}
 */
function MailApproval_isInternalRecipient(list) {
  if (!list) return false;
  var items = [];
  if (Array.isArray(list)) {
    items = list;
  } else if (typeof list === 'string') {
    items = list.split(/[,;\s]+/);
  }
  for (var i = 0; i < items.length; i++) {
    var raw = String(items[i] || '').trim().toLowerCase();
    if (!raw) continue;
    if (/@orgiast\.jp(?:>|$|\s|,|;)/i.test(raw) || raw.indexOf('@orgiast.jp') >= 0) {
      return true;
    }
  }
  return false;
}

/**
 * 返信テキストを分類し、判定種別を返す。
 * - OK / ok / 送信 / 承認 -> 'APPROVED'
 * - NG / 保留 / ダメ -> 'REJECTED'
 * - それ以外の 20 字以上のテキスト -> 'REPLACEMENT' (本文差替で APPROVED)
 * - それ以外の 20 字未満のテキスト -> 'UNKNOWN'
 * @param {string} text
 * @return {{ action: string, cleanText: string }}
 */
function MailApproval_classifyReply(text) {
  var raw = String(text || '').trim();
  // #A<id> タグが含まれる場合は判定・本文から除去
  raw = raw.replace(/#A[0-9a-zA-Z_-]+/ig, '').trim();

  // 全角英数・記号の正規化 (NFKC 相当、Node/GAS 共通)
  var normalized = raw;
  if (typeof normalized.normalize === 'function') {
    normalized = normalized.normalize('NFKC');
  }
  var cleaned = normalized.trim().toLowerCase();

  // OK 系: OK, ok, 送信, 承認, ｏｋ
  var okWords = ['ok', '送信', '承認'];
  for (var i = 0; i < okWords.length; i++) {
    if (cleaned === okWords[i]) {
      return { action: 'APPROVED', cleanText: raw };
    }
  }

  // NG 系: NG, ng, 保留, ダメ, ｎｇ, だめ
  var ngWords = ['ng', '保留', 'ダメ', 'だめ'];
  for (var j = 0; j < ngWords.length; j++) {
    if (cleaned === ngWords[j]) {
      return { action: 'REJECTED', cleanText: raw };
    }
  }

  // 20 字以上のテキストは本文差替
  if (raw.length >= 20) {
    return { action: 'REPLACEMENT', cleanText: raw };
  }

  return { action: 'UNKNOWN', cleanText: raw };
}

/**
 * PENDING 案件の再通知が必要か判定。
 * lastNotifiedAt (または createdAt) から 24 時間以上経過し、
 * かつ本日まだ再通知されていない（または lastNotifiedAt から 24h 超）場合に true。
 * @param {object} row
 * @param {Date|number} now
 * @return {boolean}
 */
function MailApproval_shouldRenotify(row, now) {
  if (!row) return false;
  var status = String(row.status || '').toUpperCase();
  if (status !== 'PENDING') return false;

  var nowMs = (now instanceof Date) ? now.getTime() : Number(now || Date.now());
  var lastNotified = row.lastNotifiedAt || row.createdAt;
  if (!lastNotified) return false;

  var lastMs = (lastNotified instanceof Date) ? lastNotified.getTime() : (new Date(lastNotified)).getTime();
  if (isNaN(lastMs)) return false;

  var diffMs = nowMs - lastMs;
  var TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  return diffMs >= TWENTY_FOUR_HOURS_MS;
}

/**
 * 過去履歴から、同一スレッド/案件で直近連続して 3 回以上 REJECTED が発生しているか確認する。
 * @param {object[]} historyRows
 * @return {boolean}
 */
function MailApproval_checkHoldHuman(historyRows) {
  if (!Array.isArray(historyRows) || !historyRows.length) return false;
  var count = 0;
  for (var i = historyRows.length - 1; i >= 0; i--) {
    var st = String(historyRows[i].status || '').toUpperCase();
    if (st === 'REJECTED') {
      count++;
      if (count >= 3) return true;
    } else if (st === 'SENT' || st === 'APPROVED' || st === 'APPROVED_WAITING_SENDER') {
      // 承認済みのものがあれば連続カウントリセット
      break;
    }
  }
  return count >= 3;
}

/**
 * 承認 DM 用のメッセージ本文を生成する。
 * @param {object} params
 * @param {string|number} params.id
 * @param {string} params.caseId
 * @param {string} params.clientName
 * @param {string} params.to
 * @param {string} [params.cc]
 * @param {string} params.subject
 * @param {string} params.body
 * @param {string|string[]} [params.attachments]
 * @param {boolean} [params.isInternal]
 * @return {string}
 */
function MailApproval_formatProposalDm(params) {
  var p = params || {};
  var id = p.id != null ? p.id : '';
  var caseId = p.caseId || '';
  var clientName = p.clientName || '';
  var to = p.to || '';
  var cc = p.cc || '';
  var subject = p.subject || '';
  var body = p.body || '';

  var attachInfo = 'なし';
  if (Array.isArray(p.attachments) && p.attachments.length) {
    attachInfo = p.attachments.length + '件 (' + p.attachments.join(', ') + ')';
  } else if (typeof p.attachments === 'string' && p.attachments.trim()) {
    attachInfo = p.attachments.trim();
  }

  var lines = [];
  lines.push('【送信承認 #A' + id + '】案件 ' + caseId + ' ' + clientName);
  lines.push('宛先: ' + to + (cc ? ' / CC: ' + cc : ''));
  lines.push('件名: ' + subject);
  lines.push('本文:');
  lines.push(body);
  lines.push('添付: ' + attachInfo);
  if (p.isInternal) {
    lines.push('※ 内部宛のため送信しません');
  } else {
    lines.push('返信: OK＝送信 / NG＝保留 / 本文を返信＝差し替えて送信');
  }
  return lines.join('\n');
}

/**
 * メッセージが Discord 上限 (2000字) を超える場合に分割する。
 * 先頭メッセージに #A<id> (1/2) のような接頭辞を付与する。
 * @param {string} text
 * @param {string|number} id
 * @param {number} [maxLen=1900]
 * @return {string[]}
 */
function MailApproval_splitDm(text, id, maxLen) {
  var str = String(text || '');
  var limit = maxLen || 1900;
  if (str.length <= limit) {
    return [str];
  }

  var chunks = [];
  var current = str;
  while (current.length > 0) {
    chunks.push(current.slice(0, limit));
    current = current.slice(limit);
  }

  var total = chunks.length;
  var tag = id != null ? '#A' + id + ' ' : '';
  return chunks.map(function (c, idx) {
    return tag + '(' + (idx + 1) + '/' + total + ')\n' + c;
  });
}

/**
 * メッセージから #A<id> を抽出する。
 * @param {string} text
 * @return {string|null}
 */
function MailApproval_extractId(text) {
  if (!text) return null;
  var m = /#A([0-9a-zA-Z_-]+)/i.exec(String(text));
  return m ? m[1] : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MailApproval_isInternalRecipient: MailApproval_isInternalRecipient,
    MailApproval_classifyReply: MailApproval_classifyReply,
    MailApproval_shouldRenotify: MailApproval_shouldRenotify,
    MailApproval_checkHoldHuman: MailApproval_checkHoldHuman,
    MailApproval_formatProposalDm: MailApproval_formatProposalDm,
    MailApproval_splitDm: MailApproval_splitDm,
    MailApproval_extractId: MailApproval_extractId
  };
}
