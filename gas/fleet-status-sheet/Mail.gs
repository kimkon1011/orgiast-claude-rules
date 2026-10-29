// Fleet mail uses the existing authenticated WebApp transport and spreadsheet.
const FLEET_MAIL_HEADERS_ = ['id', 'from', 'to', 'replyTo', 'kind', 'body', 'why', 'createdAt', 'expiresAt', 'status', 'deliveredAt', 'deliveredBy', 'resultBody', 'resultAt', 'seenAt', 'seenBy', 'ackAt', 'failedAt', 'failReason', 'auto', 'hop', 'priority', 'receipts', 'meta', 'exec', 'execCwd', 'resumeSessionId'];

function fleetMailObject(row) {
  const mail = {};
  FLEET_MAIL_HEADERS_.forEach(function(key, i) { mail[key] = _fleetMailCellText_(row[i]); });
  return mail;
}
function fleetMailRow(mail) {
  return FLEET_MAIL_HEADERS_.map(function(key) { return _fleetMailCellText_(mail[key]); });
}
function fleetMailRequired(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid_' + name);
  return value;
}
function fleetMailId(id) {
  if (!/^mail-[A-Za-z0-9-]{1,180}$/.test(String(id || ''))) throw new Error('invalid_id');
  return id;
}
function fleetMailNew(payload, now) {
  const createdAt = new Date(now).toISOString();
  const expiresAt = payload.expiresAt || new Date(now + 86400000).toISOString();
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) throw new Error('invalid_expiresAt');
  if (payload.messageKind !== 'prompt' && payload.messageKind !== 'note') throw new Error('invalid_messageKind');
  return {
    id: fleetMailId(payload.id), from: fleetMailRequired(payload.from, 'from', 128),
    to: fleetMailRequired(payload.to, 'to', 128), replyTo: payload.replyTo ? fleetMailId(payload.replyTo) : '', kind: payload.messageKind,
    body: String(payload.body || '').slice(0, 20000), why: fleetMailRequired(payload.why, 'why', 1000),
    createdAt: createdAt, expiresAt: expiresAt, status: 'new',
    meta: payload.meta ? (typeof payload.meta === 'string' ? payload.meta : JSON.stringify(payload.meta)) : '',
    exec: payload.exec || '', execCwd: payload.execCwd || '', resumeSessionId: payload.resumeSessionId || '',
    auto: payload.auto === true || payload.auto === 'true', hop: fleetMailHop(payload.hop),
    priority: payload.priority === 'urgent' || /\[(判断依頼|作業依頼)\]/.test(payload.why) || /^\s*\[(判断依頼|作業依頼)\]/.test(payload.body) ? 'urgent' : 'normal'
  };
}
function fleetMailHop(value) {
  const hop = Number(value || 0);
  if (!Number.isSafeInteger(hop) || hop < 0) throw new Error('invalid_hop');
  return hop;
}
function fleetMailMatches(mail, label, hostname, now, legacy) {
  // Broadcast replies set done as usual, but must not consume delivery to other PCs.
  return (mail.status === 'new' || (mail.to === 'all' && ['delivered', 'seen', 'done'].indexOf(mail.status) >= 0)) &&
    Date.parse(mail.expiresAt) > now && !!mail.to &&
    (mail.to === 'all' || label === mail.to || String(hostname || '').toLowerCase() === mail.to.toLowerCase() ||
      (legacy && (String(label || '').indexOf(mail.to) >= 0 || String(hostname || '').toLowerCase().indexOf(mail.to.toLowerCase()) >= 0)));
}
function fleetMailPrunable(mail, now) {
  return ['done', 'expired'].indexOf(mail.status) >= 0 && Date.parse(mail.createdAt) < now - 30 * 86400000;
}
function _fleetMailSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not configured');
  const book = SpreadsheetApp.openById(id);
  const sheet = book.getSheetByName('fleet-mail') || book.insertSheet('fleet-mail');
  // Hub metadata extends beyond a new sheet's default 26 columns.
  if (typeof sheet.getMaxColumns === 'function' && sheet.getMaxColumns() < FLEET_MAIL_HEADERS_.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), FLEET_MAIL_HEADERS_.length - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0) _fleetMailWrite_(sheet, 1, FLEET_MAIL_HEADERS_);
  const headers = sheet.getRange(1, 1, 1, FLEET_MAIL_HEADERS_.length).getValues()[0];
  // Append v2 columns without rewriting historical rows; reject shifted/unknown columns.
  if (headers.some(function(key, i) { return key && key !== FLEET_MAIL_HEADERS_[i]; })) throw new Error('fleet-mail header mismatch');
  if (JSON.stringify(headers) !== JSON.stringify(FLEET_MAIL_HEADERS_)) _fleetMailWrite_(sheet, 1, FLEET_MAIL_HEADERS_);
  sheet.setFrozenRows(1);
  return sheet;
}
function _fleetMailCellText_(value) {
  if (value == null) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function _fleetMailWrite_(sheet, row, values) {
  const range = sheet.getRange(row, 1, 1, FLEET_MAIL_HEADERS_.length);
  // Literal rich text prevents messages beginning with '=' becoming formulas.
  const expected = values.map(_fleetMailCellText_);
  range.setRichTextValues([expected.map(function(value) { return SpreadsheetApp.newRichTextValue().setText(value).build(); })]);
  SpreadsheetApp.flush();
  if (JSON.stringify(range.getValues()[0].map(_fleetMailCellText_)) !== JSON.stringify(expected)) throw new Error('fleet-mail read-back mismatch');
}
function _fleetMailLocked_(action) {
  const lock = LockService.getScriptLock();
  const alreadyLocked = typeof lock.hasLock === 'function' && lock.hasLock();
  if (!alreadyLocked && !lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const sheet = _fleetMailSheet_();
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, FLEET_MAIL_HEADERS_.length).getValues().map(fleetMailObject) : [];
    return action(sheet, rows, Date.now());
  } finally { if (!alreadyLocked) lock.releaseLock(); }
}
function sendFleetMail(payload) {
  return _fleetMailLocked_(function(sheet, rows, now) {
    fleetMailId(payload.id);
    const old = rows.find(function(mail) { return mail.id === payload.id; });
    if (old) return { ok: true, duplicate: true, mail: old };
    const mail = fleetMailNew(payload, now);
    _fleetMailWrite_(sheet, rows.length + 2, fleetMailRow(mail));
    return { ok: true, mail: mail };
  });
}
const FLEET_MAIL_POLL_LIMIT_ = 20;
function _fleetMailKnownRecipients_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const book = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
    const sheets = [book.getSheetByName('fleet-beacon'), book.getSheetByName('fleet-status')];
    if (typeof _fleetReadSheet_ === 'function') sheets.push(_fleetReadSheet_());
    const names = new Set();
    let available = false;
    sheets.filter(function(sheet, i) { return sheet && sheets.indexOf(sheet) === i; }).forEach(function(sheet) {
      if (!sheet.getLastRow()) return;
      const width = sheet.getLastColumn();
      const headers = sheet.getRange(1, 1, 1, width).getValues()[0];
      const keys = ['label', 'hostname'];
      if (typeof FLEET_HEADERS_ !== 'undefined') keys.push(FLEET_HEADERS_.hostname, FLEET_HEADERS_.realHostname);
      const columns = headers.map(function(key, i) { return keys.indexOf(key) >= 0 ? i : -1; }).filter(function(i) { return i >= 0; });
      if (!columns.length) return;
      available = true;
      if (sheet.getLastRow() < 2) return;
      sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues().forEach(function(row) {
        columns.forEach(function(i) { if (row[i]) names.add(String(row[i]).toLowerCase()); });
      });
    });
    return available ? names : null;
  } catch (error) { return null; } // No reliable roster: exact delivery only.
}
function pollFleetMail(payload) {
  fleetMailRequired(payload.to, 'to', 128);
  fleetMailRequired(payload.hostname, 'hostname', 128);
  return _fleetMailLocked_(function(sheet, rows, now) {
    const excluded = new Set(Array.isArray(payload.processedIds) ? payload.processedIds : []);
    const properties = PropertiesService.getScriptProperties();
    let receiptKey = '', receipt = null;
    if (payload.requestId && !payload.dryRun) {
      fleetMailRequired(payload.requestId, 'requestId', 80);
      receiptKey = 'FLEET_MAIL_POLL_' + _fleetMailDigest_(payload.to + '\n' + payload.hostname);
      try { receipt = JSON.parse(properties.getProperty(receiptKey) || 'null'); } catch (error) {}
    }
    const replay = receipt && receipt.requestId === payload.requestId;
    const eligible = rows.filter(function(mail) { return !excluded.has(mail.id); });
    const exact = eligible.filter(function(mail) { return fleetMailMatches(mail, payload.to, payload.hostname, now, false); });
    // Known canonical recipients must never be consumed by a different partial label.
    const known = _fleetMailKnownRecipients_();
    const candidates = exact.some(function(mail) { return mail.to !== 'all'; }) || !known ? exact : eligible.filter(function(mail) {
      return fleetMailMatches(mail, payload.to, payload.hostname, now, !known.has(mail.to.toLowerCase()));
    });
    const selected = replay ? receipt.ids.map(function(id) { return rows.find(function(mail) { return mail.id === id; }); }).filter(Boolean) :
      candidates.filter(function(mail) { return mail.to !== 'all'; }).concat(candidates.filter(function(mail) { return mail.to === 'all'; })).slice(0, FLEET_MAIL_POLL_LIMIT_);
    // Save only IDs (<4KB), before consuming rows. A lost HTTP response can be replayed.
    if (receiptKey && !replay) properties.setProperty(receiptKey, JSON.stringify({ requestId: payload.requestId, ids: selected.map(function(mail) { return mail.id; }) }));
    const messages = [];
    selected.forEach(function(mail) {
      const i = rows.indexOf(mail);
      if (!payload.dryRun && mail.to !== 'all' && mail.status === 'new') {
        mail.status = 'delivered'; mail.deliveredAt = new Date(now).toISOString(); mail.deliveredBy = payload.to;
        _fleetMailWrite_(sheet, i + 2, fleetMailRow(mail));
      }
      messages.push(mail);
    });
    if (!payload.dryRun) {
      let deleted = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const mail = rows[i];
        if (['new', 'delivered', 'seen', 'failed'].indexOf(mail.status) >= 0 && Date.parse(mail.expiresAt) <= now) {
          mail.status = 'expired'; _fleetMailWrite_(sheet, i + 2, fleetMailRow(mail));
        }
        if (deleted < 100 && fleetMailPrunable(mail, now)) { sheet.deleteRow(i + 2); deleted++; }
      }
    }
    // 実 poll の成功時だけ最終 poll を記録する（dryRun では記録しない）。記録失敗は poll 成功を妨げない。
    if (!payload.dryRun) { try { fleetRecordPoll_(properties, payload.to, now); } catch (error) {} }
    return { ok: true, messages: messages };
  });
}
function _fleetMailDigest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text).map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 16);
}
// 実 poll の成功時に「そのPCが最後に受信処理をした時刻」をサーバー側で記録する。
// converge 未実行のPCでも最終 poll が分かるようにするのが目的。JSON が 8500 字を超えたら古い順に削る。
function fleetRecordPoll_(properties, label, now) {
  let polls = {};
  try {
    const parsed = JSON.parse(properties.getProperty('FLEET_LAST_POLL') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) polls = parsed;
  } catch (error) { polls = {}; }
  polls[label] = new Date(now).toISOString();
  let keys = Object.keys(polls);
  while (keys.length > 1 && JSON.stringify(polls).length > 8500) {
    const oldest = keys.reduce(function(a, b) { return Date.parse(polls[a]) <= Date.parse(polls[b]) ? a : b; });
    delete polls[oldest];
    keys = Object.keys(polls);
  }
  properties.setProperty('FLEET_LAST_POLL', JSON.stringify(polls));
  return polls;
}
function replyFleetMail(payload) {
  fleetMailId(payload.id); fleetMailRequired(payload.from, 'from', 128);
  return _fleetMailLocked_(function(sheet, rows, now) {
    const index = rows.findIndex(function(mail) { return mail.id === payload.id; });
    if (index < 0) return { ok: false, status: 404, error: 'mail_not_found' };
    const original = rows[index];
    const body = String(payload.resultBody || '').slice(0, 20000);
    // A stable reply id makes retry after a lost HTTP response idempotent, per PC.
    const stableId = 'mail-reply-' + _fleetMailDigest_(original.id + '\n' + payload.from);
    const first = rows.find(function(mail) { return mail.id === stableId; });
    const replyId = !first || first.body === body ? stableId : stableId + '-' + _fleetMailDigest_(body);
    let reply = rows.find(function(mail) { return mail.id === replyId; });
    if (reply) {
      // Recover an append that succeeded before the original-row write/response failed.
      const latestReply = rows.filter(function(mail) { return mail.replyTo === original.id; }).pop();
      if (['failed', 'expired'].indexOf(original.status) < 0 && (!latestReply || latestReply.id === reply.id)) {
        original.status = 'done'; original.resultBody = reply.body; original.resultAt = reply.createdAt;
        _fleetMailWrite_(sheet, index + 2, fleetMailRow(original));
      }
      return { ok: true, duplicate: true, mail: original, reply: reply };
    }
    const hop = fleetMailHop(original.hop) + 1;
    const auto = payload.auto === true || payload.auto === 'true';
    if ((auto && (original.auto === true || original.auto === 'true')) || hop >= 3) return { ok: false, reason: 'loop' };
    if (['failed', 'expired'].indexOf(original.status) >= 0) return { ok: true, mail: original };
    reply = {
      id: replyId, from: payload.from, to: original.from, replyTo: original.id, kind: 'note',
      body: body, why: original.why, auto: auto, hop: hop, priority: 'normal',
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3 * 86400000).toISOString(), status: 'new'
    };
    _fleetMailWrite_(sheet, rows.length + 2, fleetMailRow(reply));
    original.status = 'done'; original.resultBody = body; original.resultAt = new Date(now).toISOString();
    _fleetMailWrite_(sheet, index + 2, fleetMailRow(original));
    return { ok: true, mail: original, reply: reply };
  });
}
function getFleetMail(payload) {
  fleetMailId(payload.id);
  return _fleetMailLocked_(function(sheet, rows) {
    return { ok: true, mail: rows.find(function(mail) { return mail.id === payload.id; }) || null };
  });
}

const FLEET_MAIL_TERMINAL_STATUSES_ = Object.freeze(['done', 'failed', 'expired']);
const FLEET_MAIL_ACK_LIMIT_ = 100;
function _fleetMailApplyTransition_(sheet, rows, now, payload, action) {
  const index = rows.findIndex(function(mail) { return mail.id === payload.id; });
  if (index < 0) return { ok: false, status: 404, error: 'mail_not_found' };
  const mail = rows[index];
  const label = String(payload.from || payload.label || '');
  if (!label || (mail.to !== 'all' && mail.deliveredBy && mail.deliveredBy !== label)) return { ok: false, reason: 'not-recipient' };
  const at = new Date(now).toISOString();
  if (mail.to === 'all') {
    const receipts = JSON.parse(mail.receipts || '{}');
    const receipt = Object.prototype.hasOwnProperty.call(receipts, label) ? receipts[label] : {};
    const field = action === 'seen' ? 'seenAt' : action === 'ack' ? 'ackAt' : 'failedAt';
    if (!receipt[field]) receipt[field] = at;
    Object.defineProperty(receipts, label, { value: receipt, enumerable: true, configurable: true });
    mail.receipts = JSON.stringify(receipts);
  } else {
    if (!mail.deliveredBy) {
      mail.deliveredBy = label;
      _fleetMailWrite_(sheet, index + 2, fleetMailRow(mail));
    }
    if (FLEET_MAIL_TERMINAL_STATUSES_.indexOf(mail.status) >= 0) return { ok: true, mail: mail };
    if (action === 'seen') {
      if (mail.status === 'seen') return { ok: true, mail: mail };
      mail.status = 'seen'; mail.seenAt = at; mail.seenBy = String(payload.seenBy || label).slice(0, 256);
    } else if (action === 'ack') {
      mail.status = 'done'; mail.ackAt = at;
    } else {
      mail.status = payload.reason === 'expired' ? 'expired' : 'failed';
      mail.failedAt = at; mail.failReason = String(payload.reason || 'processing_failed').slice(0, 1000);
    }
  }
  _fleetMailWrite_(sheet, index + 2, fleetMailRow(mail));
  return { ok: true, mail: mail };
}
function _fleetMailTransition_(payload, action) {
  fleetMailId(payload.id);
  return _fleetMailLocked_(function(sheet, rows, now) {
    return _fleetMailApplyTransition_(sheet, rows, now, payload, action);
  });
}
function seenFleetMail(payload) { return _fleetMailTransition_(payload, 'seen'); }
function ackFleetMail(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'ids')) return _fleetMailTransition_(payload, 'ack');
  if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > FLEET_MAIL_ACK_LIMIT_) throw new Error('invalid_ids');
  payload.ids.forEach(fleetMailId);
  return _fleetMailLocked_(function(sheet, rows, now) {
    return { ok: true, results: payload.ids.map(function(id) {
      return Object.assign({ id: id }, _fleetMailApplyTransition_(sheet, rows, now, Object.assign({}, payload, { id: id }), 'ack'));
    }) };
  });
}
function failFleetMail(payload) { return _fleetMailTransition_(payload, 'fail'); }

const FLEET_MAIL_ALERT_HEADERS_ = ['id', 'kind', 'to', 'from', 'why', 'firstAt', 'lastNotifiedAt', 'notifiedCount'];
const FLEET_MAIL_RENOTIFY_MS_ = 6 * 60 * 60 * 1000;
const FLEET_MAIL_SLA_ = { undelivered: 30 * 60 * 1000, urgent: 2 * 60 * 60 * 1000, normal: 6 * 60 * 60 * 1000, sweepMinutes: 10 };
function _fleetMailAlertKind_(mail, now) {
  if (Date.parse(mail.expiresAt) <= now) return '';
  if (mail.status === 'new' && !mail.deliveredAt && now - Date.parse(mail.createdAt) > FLEET_MAIL_SLA_.undelivered) return 'undelivered';
  // auto=true は PC 間の機械報告（[lane-health] 等）。人が読む連絡ではないので未読 SLA の対象外（未配達の監視は残す）。
  if (mail.auto === true || mail.auto === 'true') return '';
  if (mail.status === 'delivered' && !mail.seenAt && now - Date.parse(mail.deliveredAt) > FLEET_MAIL_SLA_[mail.priority === 'urgent' ? 'urgent' : 'normal']) return 'unseen';
  return '';
}
function _fleetMailAlertsSheet_() {
  const book = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  const sheet = book.getSheetByName('fleet-mail-alerts') || book.insertSheet('fleet-mail-alerts');
  if (!sheet.getLastRow()) _fleetMailAlertWrite_(sheet, 1, FLEET_MAIL_ALERT_HEADERS_);
  sheet.setFrozenRows(1);
  return sheet;
}
function _fleetMailAlertWrite_(sheet, row, values) {
  const range = sheet.getRange(row, 1, 1, FLEET_MAIL_ALERT_HEADERS_.length);
  const strings = values.map(function(v) { return String(v == null ? '' : v); });
  range.setRichTextValues([strings.map(function(v) { return SpreadsheetApp.newRichTextValue().setText(v).build(); })]);
  SpreadsheetApp.flush();
  if (JSON.stringify(range.getValues()[0]) !== JSON.stringify(strings)) throw new Error('fleet-mail alert read-back mismatch');
}
function _fleetMailAlertsRead_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, FLEET_MAIL_ALERT_HEADERS_.length).getValues().map(function(row) {
    const alert = {};
    FLEET_MAIL_ALERT_HEADERS_.forEach(function(key, i) { alert[key] = String(row[i] || ''); });
    alert.notifiedCount = Number(alert.notifiedCount || 0);
    return alert;
  });
}
function _fleetMailAlertSave_(sheet, index, alert) {
  _fleetMailAlertWrite_(sheet, index + 2, FLEET_MAIL_ALERT_HEADERS_.map(function(key) { return alert[key]; }));
}
function _fleetMailAlertDue_(alert, now) {
  return !alert.lastNotifiedAt || now - Date.parse(alert.lastNotifiedAt) >= FLEET_MAIL_RENOTIFY_MS_;
}
// Never include raw secret-bearing reasons in external notifications or the alert ledger.
function _fleetMailAlertText_(value) {
  return String(value || '')
    .replace(/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s]+/gi, '[REDACTED]')
    .replace(/\b(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/\s+/g, ' ').slice(0, 60);
}
function fleetMailSweep() {
  return _fleetMailLocked_(function(sheet, rows, now) {
    let expired = 0, notified = 0, active = 0, alerted = 0;
    // Complete expiry before touching the optional alert ledger or transport.
    rows.forEach(function(mail, row) {
      if (FLEET_MAIL_TERMINAL_STATUSES_.indexOf(mail.status) < 0 && Date.parse(mail.expiresAt) <= now) {
        mail.status = 'expired'; _fleetMailWrite_(sheet, row + 2, fleetMailRow(mail)); expired++;
      }
    });
    const alertsSheet = _fleetMailAlertsSheet_();
    const alerts = _fleetMailAlertsRead_(alertsSheet);
    const webhook = PropertiesService.getScriptProperties().getProperty('FLEET_MAIL_DISCORD_WEBHOOK');
    rows.forEach(function(mail) {
      try {
        const kind = _fleetMailAlertKind_(mail, now);
        if (!kind) return;
        active++;
        let index = alerts.findIndex(function(alert) { return alert.id === mail.id; });
        if (index < 0) { index = alerts.length; alerts.push({ id: mail.id, firstAt: new Date(now).toISOString(), lastNotifiedAt: '', notifiedCount: 0 }); }
        const alert = alerts[index];
        alert.kind = kind; alert.to = _fleetMailAlertText_(mail.to); alert.from = _fleetMailAlertText_(mail.from); alert.why = _fleetMailAlertText_(mail.why);
        // Count is per six-hour notification cycle; the last successful time is retained.
        if (_fleetMailAlertDue_(alert, now)) alert.notifiedCount = 0;
        _fleetMailAlertSave_(alertsSheet, index, alert); alerted++;
        if (!webhook || alert.notifiedCount > 0) return;
        const content = (kind === 'unseen' ? '未読 SLA 超過: ' : '未配達（受信タスク停止の疑い）: ') + alert.to + ' 宛 / ' + alert.why + ' / ' + alert.id;
        const response = UrlFetchApp.fetch(webhook, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ content: content, allowed_mentions: { parse: [] } }), muteHttpExceptions: true });
        if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return;
        alert.lastNotifiedAt = new Date(now).toISOString(); alert.notifiedCount++;
        _fleetMailAlertSave_(alertsSheet, index, alert); notified++;
      } catch (error) { console.warn('fleet-mail: alert failed=1'); }
    });
    return { ok: true, expired: expired, active: active, alerted: alerted, notified: notified };
  });
}
function getFleetMailAlerts(payload) {
  return _fleetMailLocked_(function(sheet, rows, now) {
    const alertsSheet = _fleetMailAlertsSheet_();
    const alerts = _fleetMailAlertsRead_(alertsSheet);
    const ids = Array.isArray(payload.notifiedIds) ? payload.notifiedIds : [];
    const pending = [];
    alerts.forEach(function(alert, index) {
      const mail = rows.find(function(mail) { return mail.id === alert.id; });
      if (!mail || !_fleetMailAlertKind_(mail, now)) return;
      if (ids.indexOf(alert.id) >= 0 && _fleetMailAlertDue_(alert, now)) {
        alert.lastNotifiedAt = new Date(now).toISOString(); alert.notifiedCount = 1;
        _fleetMailAlertSave_(alertsSheet, index, alert);
      }
      if (_fleetMailAlertDue_(alert, now)) pending.push(Object.assign({}, alert, { notifiedCount: 0 }));
    });
    return { ok: true, alerts: pending };
  });
}
function setupFleetMailTriggers() {
  ScriptApp.getProjectTriggers().filter(function(trigger) { return trigger.getHandlerFunction() === 'fleetMailSweep'; })
    .forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('fleetMailSweep').timeBased().everyMinutes(FLEET_MAIL_SLA_.sweepMinutes).create();
  return ScriptApp.getProjectTriggers().map(function(trigger) {
    return { handler: trigger.getHandlerFunction(), eventType: String(trigger.getEventType()), source: String(trigger.getTriggerSource()) };
  });
}

// Authenticated metadata-only investigation. Does not poll, deliver, expire, or prune mail.
function traceFleetMail(payload) {
  const matchWhy = fleetMailRequired(payload.matchWhy, 'matchWhy', 1000);
  const since = Date.parse(payload.since);
  if (!Number.isFinite(since)) throw new Error('invalid_since');
  return _fleetMailLocked_(function(sheet, rows) {
    const matched = rows.filter(function(mail) {
      return Date.parse(mail.createdAt) >= since && mail.why.indexOf(matchWhy) >= 0;
    }).sort(function(a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); });
    const fields = ['id', 'from', 'to', 'kind', 'why', 'createdAt', 'status', 'deliveredAt', 'seenAt', 'failedAt', 'failReason'];
    return { ok: true, total: matched.length, truncated: matched.length > 100, mails: matched.slice(0, 100).map(function(mail) {
      const result = {};
      fields.forEach(function(key) { result[key] = mail[key] || ''; });
      return result;
    }) };
  });
}
