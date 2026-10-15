function _installBeaconWrite_(sheet, row, values) {
  const strings = values.map(String);
  const range = sheet.getRange(row, 1, 1, INSTALL_BEACON_HEADERS_.length);
  range.setRichTextValues([strings.map(function(value) { return SpreadsheetApp.newRichTextValue().setText(value).build(); })]);
  SpreadsheetApp.flush();
  if (JSON.stringify(range.getValues()[0]) !== JSON.stringify(strings)) throw new Error('install-beacon read-back mismatch');
}

function _installBeaconLocked_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) throw new Error('missing sheet');
    const book = SpreadsheetApp.openById(id);
    const sheet = book.getSheetByName('install-beacon') || book.insertSheet('install-beacon');
    if (!sheet.getLastRow()) _installBeaconWrite_(sheet, 1, INSTALL_BEACON_HEADERS_);
    if (JSON.stringify(sheet.getRange(1, 1, 1, 8).getValues()[0]) !== JSON.stringify(INSTALL_BEACON_HEADERS_)) throw new Error('header mismatch');
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues().map(function(values) {
      const row = {};
      INSTALL_BEACON_HEADERS_.forEach(function(key, i) { row[key] = key === 'count' ? Number(values[i]) : String(values[i]); });
      return row;
    }) : [];
    return action(sheet, rows);
  } catch (error) {
    // Public route: never expose service errors or configuration values.
    return { ok: false, status: 500, error: 'storage_failed' };
  } finally { lock.releaseLock(); }
}

function receiveInstallBeacon(e, payload) {
  const validated = installBeaconValidate(payload, ((e && e.postData && e.postData.contents) || '').length);
  if (!validated.ok) return validated;
  const result = _installBeaconLocked_(function(sheet, rows) {
    const plan = installBeaconPlan(rows, validated.value, new Date().toISOString());
    if (!plan.ok) return plan;
    _installBeaconWrite_(sheet, plan.index + 2, INSTALL_BEACON_HEADERS_.map(function(key) { return plan.row[key]; }));
    return { ok: true, action: plan.action };
  });
  if (result.ok && result.action === 'created') _installBeaconNotify_(validated.value);
  return result;
}

function _installBeaconNotify_(value) {
  try {
    const webhook = PropertiesService.getScriptProperties().getProperty('FLEET_MAIL_DISCORD_WEBHOOK');
    if (!webhook) return;
    const content = '🆕 インストーラ初報告: hostname=' + value.hostname + ' / Claude=' + value.claudeAccount + ' / os=' + value.os +
      (value.serial ? ' / serial=' + value.serial : '') + ' （台帳照合は fleet-liveness が行う）';
    const response = UrlFetchApp.fetch(webhook, {
      method: 'post', contentType: 'application/json',
      headers: { 'User-Agent': 'DiscordBot (https://orgiast.jp, 1.0) install-beacon' },
      payload: JSON.stringify({ username: 'インストーラ初報告', content: content, allowed_mentions: { parse: [] } }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) console.warn('install-beacon notification failed');
  } catch (error) { console.warn('install-beacon notification failed'); }
}

function listInstallBeacons() {
  return _installBeaconLocked_(function(sheet, rows) { return { ok: true, rows: rows }; });
}
