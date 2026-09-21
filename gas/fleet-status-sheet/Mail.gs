// Fleet mail uses the existing authenticated WebApp transport and spreadsheet.
const FLEET_MAIL_HEADERS_ = ['id', 'from', 'to', 'replyTo', 'kind', 'body', 'why', 'createdAt', 'expiresAt', 'status', 'deliveredAt', 'deliveredBy', 'resultBody', 'resultAt'];

function fleetMailObject(row) {
  const mail = {};
  FLEET_MAIL_HEADERS_.forEach(function(key, i) { mail[key] = String(row[i] || ''); });
  return mail;
}
function fleetMailRow(mail) {
  return FLEET_MAIL_HEADERS_.map(function(key) { return String(mail[key] || ''); });
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
    to: fleetMailRequired(payload.to, 'to', 128), replyTo: '', kind: payload.messageKind,
    body: String(payload.body || '').slice(0, 20000), why: fleetMailRequired(payload.why, 'why', 1000),
    createdAt: createdAt, expiresAt: expiresAt, status: 'new'
  };
}
function fleetMailMatches(mail, label, hostname, now) {
  // Broadcast replies set done as usual, but must not consume delivery to other PCs.
  return (mail.status === 'new' || (mail.to === 'all' && mail.status === 'done')) &&
    Date.parse(mail.expiresAt) > now && !!mail.to &&
    (mail.to === 'all' || String(label || '').indexOf(mail.to) >= 0 || String(hostname || '').indexOf(mail.to) >= 0);
}
function fleetMailPrunable(mail, now) {
  return ['done', 'expired'].indexOf(mail.status) >= 0 && Date.parse(mail.createdAt) < now - 30 * 86400000;
}
function _fleetMailSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not configured');
  const book = SpreadsheetApp.openById(id);
  const sheet = book.getSheetByName('fleet-mail') || book.insertSheet('fleet-mail');
  if (sheet.getLastRow() === 0) _fleetMailWrite_(sheet, 1, FLEET_MAIL_HEADERS_);
  const headers = sheet.getRange(1, 1, 1, FLEET_MAIL_HEADERS_.length).getValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(FLEET_MAIL_HEADERS_)) throw new Error('fleet-mail header mismatch');
  sheet.setFrozenRows(1);
  return sheet;
}
function _fleetMailWrite_(sheet, row, values) {
  const range = sheet.getRange(row, 1, 1, FLEET_MAIL_HEADERS_.length);
  // Literal rich text prevents messages beginning with '=' becoming formulas.
  range.setRichTextValues([values.map(function(value) { return SpreadsheetApp.newRichTextValue().setText(String(value)).build(); })]);
  SpreadsheetApp.flush();
  if (JSON.stringify(range.getValues()[0]) !== JSON.stringify(values)) throw new Error('fleet-mail read-back mismatch');
}
function _fleetMailLocked_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const sheet = _fleetMailSheet_();
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, FLEET_MAIL_HEADERS_.length).getValues().map(fleetMailObject) : [];
    return action(sheet, rows, Date.now());
  } finally { lock.releaseLock(); }
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
    const selected = replay ? rows.filter(function(mail) { return receipt.ids.indexOf(mail.id) >= 0; }) :
      rows.filter(function(mail) { return !excluded.has(mail.id) && fleetMailMatches(mail, payload.to, payload.hostname, now); }).slice(0, 20);
    // Save only IDs (<4KB), before consuming rows. A lost HTTP response can be replayed.
    if (receiptKey && !replay) properties.setProperty(receiptKey, JSON.stringify({ requestId: payload.requestId, ids: selected.map(function(mail) { return mail.id; }) }));
    const messages = [];
    rows.forEach(function(mail, i) {
      if (selected.indexOf(mail) < 0) return;
      if (!payload.dryRun && mail.to !== 'all') {
        mail.status = 'delivered'; mail.deliveredAt = new Date(now).toISOString(); mail.deliveredBy = payload.to;
        _fleetMailWrite_(sheet, i + 2, fleetMailRow(mail));
      }
      messages.push(mail);
    });
    if (!payload.dryRun) {
      let deleted = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const mail = rows[i];
        if (['new', 'delivered'].indexOf(mail.status) >= 0 && Date.parse(mail.expiresAt) <= now) {
          mail.status = 'expired'; _fleetMailWrite_(sheet, i + 2, fleetMailRow(mail));
        }
        if (deleted < 100 && fleetMailPrunable(mail, now)) { sheet.deleteRow(i + 2); deleted++; }
      }
    }
    return { ok: true, messages: messages };
  });
}
function _fleetMailDigest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text).map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 16);
}
function replyFleetMail(payload) {
  fleetMailId(payload.id); fleetMailRequired(payload.from, 'from', 128);
  return _fleetMailLocked_(function(sheet, rows, now) {
    const index = rows.findIndex(function(mail) { return mail.id === payload.id; });
    if (index < 0) return { ok: false, status: 404, error: 'mail_not_found' };
    const original = rows[index];
    // A stable reply id makes retry after a lost HTTP response idempotent, per PC.
    const id = 'mail-reply-' + _fleetMailDigest_(original.id + '\n' + payload.from);
    let reply = rows.find(function(mail) { return mail.id === id; });
    if (!reply) {
      reply = {
        id: id, from: payload.from, to: original.from, replyTo: original.id, kind: 'note',
        body: String(payload.resultBody || '').slice(0, 20000), why: original.why,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), status: 'new'
      };
      _fleetMailWrite_(sheet, rows.length + 2, fleetMailRow(reply));
    }
    original.status = 'done'; original.resultBody = reply.body; original.resultAt = reply.createdAt;
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
