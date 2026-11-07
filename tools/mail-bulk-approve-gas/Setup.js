function setupOnce() {
  assertSender_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('送信承認');
  if (!sheet) throw new Error('送信承認シートがありません');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  props.setProperty('APPROVAL_SHEET_ID', String(sheet.getSheetId()));
  // Protect content and delivery receipts; only the approval checkbox is editable.
  if (!sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).some(function (p) { return p.getDescription() === 'bulk-mail-approval'; })) {
    var protection = sheet.protect().setDescription('bulk-mail-approval');
    protection.removeEditors(protection.getEditors());
    protection.addEditor('seisaku-team@orgiast.jp');
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
    protection.setUnprotectedRanges([sheet.getRange(2, 6, Math.max(1, sheet.getLastRow() - 1), 1)]);
  }
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'onApprovalEdit'; }).forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('onApprovalEdit').forSpreadsheet(ss).onEdit().create();
  installCommandQueue();
  sheet.getRange('F1').setNote('kim@orgiast.jp でチェックすると、この行のメールを送信します。');
  SpreadsheetApp.flush();
  Logger.log('command queue installed; mail approval ready');
}
function approvalStatus() {
  var props = PropertiesService.getScriptProperties();
  return { spreadsheetId: props.getProperty('SPREADSHEET_ID'), commandFolderId: props.getProperty('CMD_FOLDER_ID'), triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
}
function _COMMANDS_() { return { approvalStatus: approvalStatus }; }
function installCommandQueue() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CMD_FOLDER_ID')) {
    var folder = DriveApp.createFolder('claude-mail-bulk-approve-cmds');
    ensureKimEditor_(folder);
    props.setProperty('CMD_FOLDER_ID', folder.getId());
  }
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processCommandQueue'; })) ScriptApp.newTrigger('processCommandQueue').timeBased().everyMinutes(1).create();
}
function processCommandQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('CMD_FOLDER_ID'));
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      var match = file.getName().match(/^cmd_([\w-]+)\.json$/);
      if (!match) continue;
      var raw = file.getBlob().getDataAsString();
      file.setTrashed(true);
      var result;
      try {
        var payload = JSON.parse(raw);
        var commands = _COMMANDS_();
        if (!Object.prototype.hasOwnProperty.call(commands, payload.command)) throw new Error('Unknown command');
        result = { ok: true, value: commands[payload.command].apply(null, payload.args || []) };
      } catch (error) { result = { ok: false, error: String(error.message) }; }
      ensureKimEditor_(folder.createFile('result_' + match[1] + '.txt', JSON.stringify(result), MimeType.PLAIN_TEXT));
    }
  } finally { lock.releaseLock(); }
}

// GAS adapter for the same kim editor contract (silent Drive API grant + read-back).
function ensureKimEditor_(file) {
  var base = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.getId());
  function request(url, method, body) {
    var response = UrlFetchApp.fetch(url, { method: method || 'get', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, contentType: 'application/json', muteHttpExceptions: true, payload: body ? JSON.stringify(body) : undefined });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('kim-editor: Drive HTTP ' + response.getResponseCode());
    return JSON.parse(response.getContentText() || '{}');
  }
  request(base + '?supportsAllDrives=true', 'patch', { properties: { orgiastAutomation: 'true' } });
  function hasEditor() {
    var next, found = false;
    do {
      var page = request(base + '/permissions?supportsAllDrives=true&fields=nextPageToken,permissions(emailAddress,role,type,deleted)' + (next ? '&pageToken=' + encodeURIComponent(next) : ''));
      found = found || (page.permissions || []).some(function (p) { return !p.deleted && p.type === 'user' && String(p.emailAddress).toLowerCase() === 'kim@orgiast.jp' && ['owner','writer','organizer','fileOrganizer'].indexOf(p.role) !== -1; });
      next = page.nextPageToken;
    } while (next);
    return found;
  }
  if (!hasEditor()) {
    request(base + '/permissions?supportsAllDrives=true&sendNotificationEmail=false', 'post', { type: 'user', role: 'writer', emailAddress: 'kim@orgiast.jp' });
    if (!hasEditor()) throw new Error('kim-editor: writer read-back failed');
  }
  return file;
}
