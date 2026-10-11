// fleet ビーコン: 各PCの converge 結果（ステップの ok/skip/fail）と最終 poll を1行に集約する。
// Mail.gs とは独立にロードできるよう、関数は _fleetBeacon... 接頭辞で名前空間を分ける。
const FLEET_BEACON_HEADERS_ = ['label', 'account', 'reportedAt', 'steps', 'failing', 'pollAt', 'serverPollAt'];
const FLEET_BEACON_STEPS_LIMIT_ = 6000;
const FLEET_LAST_POLL_KEY_ = 'FLEET_LAST_POLL';
const FLEET_LAST_POLL_LIMIT_ = 8500;

function _fleetBeaconLabel_(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('invalid_label');
  return value;
}
function _fleetBeaconSteps_(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value === undefined ? [] : value);
  return String(text).slice(0, FLEET_BEACON_STEPS_LIMIT_);
}
function _fleetBeaconFailing_(value) {
  if (Array.isArray(value)) return value.map(function(id) { return String(id); }).join(',');
  return String(value === undefined || value === null ? '' : value);
}
function _fleetBeaconSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not configured');
  const book = SpreadsheetApp.openById(id);
  const sheet = book.getSheetByName('fleet-beacon') || book.insertSheet('fleet-beacon');
  if (sheet.getLastRow() === 0) _fleetBeaconWrite_(sheet, 1, FLEET_BEACON_HEADERS_);
  const headers = sheet.getRange(1, 1, 1, FLEET_BEACON_HEADERS_.length).getValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(FLEET_BEACON_HEADERS_)) throw new Error('fleet-beacon header mismatch');
  sheet.setFrozenRows(1);
  return sheet;
}
function _fleetBeaconWrite_(sheet, row, values) {
  const range = sheet.getRange(row, 1, 1, FLEET_BEACON_HEADERS_.length);
  // '=' で始まる steps が数式化しないよう、Mail.gs と同じくリテラル文字列として書く。
  range.setRichTextValues([values.map(function(value) { return SpreadsheetApp.newRichTextValue().setText(String(value)).build(); })]);
  SpreadsheetApp.flush();
  if (JSON.stringify(range.getValues()[0]) !== JSON.stringify(values)) throw new Error('fleet-beacon read-back mismatch');
}
function _fleetBeaconObject_(row) {
  const beacon = {};
  FLEET_BEACON_HEADERS_.forEach(function(key, i) { beacon[key] = String(row[i] || ''); });
  return beacon;
}
function _fleetBeaconRow_(beacon) {
  return FLEET_BEACON_HEADERS_.map(function(key) { return String(beacon[key] || ''); });
}
function _fleetBeaconServerPolls_() {
  try {
    const parsed = JSON.parse(PropertiesService.getScriptProperties().getProperty(FLEET_LAST_POLL_KEY_) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) { return {}; }
}
function _fleetBeaconLocked_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const sheet = _fleetBeaconSheet_();
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, FLEET_BEACON_HEADERS_.length).getValues().map(_fleetBeaconObject_) : [];
    return action(sheet, rows, Date.now());
  } finally { lock.releaseLock(); }
}
function upsertFleetBeacon(payload) {
  const label = _fleetBeaconLabel_(payload.label);
  return _fleetBeaconLocked_(function(sheet, rows, now) {
    const reportedAt = new Date(now).toISOString();
    const serverPolls = _fleetBeaconServerPolls_();
    const beacon = {
      label: label,
      account: String(payload.account || '').slice(0, 128),
      reportedAt: reportedAt,
      steps: _fleetBeaconSteps_(payload.steps),
      failing: _fleetBeaconFailing_(payload.failing),
      pollAt: String(payload.pollAt || '').slice(0, 64),
      serverPollAt: String(serverPolls[label] || '')
    };
    const index = rows.findIndex(function(row) { return row.label === label; });
    if (index >= 0) _fleetBeaconWrite_(sheet, index + 2, _fleetBeaconRow_(beacon));
    else _fleetBeaconWrite_(sheet, rows.length + 2, _fleetBeaconRow_(beacon));
    return { ok: true, beacon: { label: label, reportedAt: reportedAt } };
  });
}
function listFleetBeacons() {
  return _fleetBeaconLocked_(function(sheet, rows) {
    const serverPolls = _fleetBeaconServerPolls_();
    const beacons = rows.map(function(row) {
      const beacon = {
        label: row.label, account: row.account, reportedAt: row.reportedAt, steps: row.steps,
        failing: row.failing, pollAt: row.pollAt, serverPollAt: row.serverPollAt
      };
      if (serverPolls[beacon.label]) beacon.serverPollAt = String(serverPolls[beacon.label]);
      return beacon;
    });
    return { ok: true, beacons: beacons, serverPolls: serverPolls };
  });
}
