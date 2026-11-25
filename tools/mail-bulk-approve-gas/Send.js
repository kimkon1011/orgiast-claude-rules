function assertSender_() {
  if (Session.getEffectiveUser().getEmail().toLowerCase() !== 'seisaku-team@orgiast.jp') throw new Error('seisaku-team@orgiast.jp で setupOnce を実行してください');
}
function verifiedWrite_(range, values) {
  range.setValues(values);
  SpreadsheetApp.flush();
  if (JSON.stringify(range.getValues()) !== JSON.stringify(values)) throw new Error('シート書き戻し確認に失敗しました');
}
function onApprovalEdit(e) {
  assertSender_();
  if (!e || !e.range || !e.triggerUid) return;
  // Unknown editor identities never authorize mail. API writes do not fire onEdit.
  if (!e.user || e.user.getEmail().toLowerCase() !== 'kim@orgiast.jp') return;
  var sheet = e.range.getSheet();
  var props = PropertiesService.getScriptProperties();
  if (String(sheet.getSheetId()) !== props.getProperty('APPROVAL_SHEET_ID') || sheet.getParent().getId() !== props.getProperty('SPREADSHEET_ID')) return;
  var rows = approvalRows(e.range.getRow(), e.range.getNumRows(), e.range.getColumn(), e.range.getNumColumns());
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    rows.forEach(function (r) {
      var key = 'SEND_' + r;
      if (props.getProperty(key)) return;
      var data = sheet.getRange(r, 1, 1, 8).getValues()[0];
      var mail = approvalMail(data);
      if (!mail) return;
      var pending = { status: 'sending', startedAt: new Date().toISOString() };
      // Reserve durably BEFORE calling Gmail. Any uncertain outcome needs inspection,
      // never an automatic retry (including timeout between send and sheet update).
      props.setProperty(key, JSON.stringify(pending));
      verifiedWrite_(sheet.getRange(r, 8), [['送信中（再送禁止）']]);
      try {
        var subject = Utilities.base64Encode(mail.subject, Utilities.Charset.UTF_8);
        var mime = ['From: seisaku-team@orgiast.jp', 'To: ' + mail.to];
        if (mail.cc) mime.push('Cc: ' + mail.cc);
        mime.push('Subject: =?UTF-8?B?' + subject + '?=', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Utilities.base64Encode(mail.body, Utilities.Charset.UTF_8));
        var raw = Utilities.base64EncodeWebSafe(mime.join('\r\n'), Utilities.Charset.UTF_8);
        var sent = Gmail.Users.Messages.send({ raw: raw }, 'me');
        if (!sent.id) throw new Error('messageId を取得できません');
        var done = { status: 'sent', sentAt: new Date().toISOString(), messageId: sent.id };
        props.setProperty(key, JSON.stringify(done));
        verifiedWrite_(sheet.getRange(r, 7, 1, 2), [[done.sentAt, done.messageId]]);
      } catch (error) {
        // Do not erase a successful messageId from the durable ledger.
        verifiedWrite_(sheet.getRange(r, 8), [['要確認（自動再送しません）']]);
        throw error;
      }
    });
  } finally { lock.releaseLock(); }
}
