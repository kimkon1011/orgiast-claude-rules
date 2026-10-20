/** 案件成果物用。PrintChecklist のドメイン編集方針を共通化（公開共有にはしない）。 */
// GAS の1実行内だけで使用し、finally で復元。既存の間接呼び出しも報告できる。
var _CaseSharing_report = null;
function CaseSharing_withReport(report, fn) {
  var previous = _CaseSharing_report;
  _CaseSharing_report = report;
  try { return fn(); } finally { _CaseSharing_report = previous; }
}
function CaseSharing_ensureEditor(resource, caseId, opts) {
  // 所有者確認の失敗は共有処理の失敗と分離し、誤共有防止のため停止する。
  const owner = resource.getOwner();
  if (!CaseSharing_isCompanyOwner(owner && owner.getEmail())) {
    throw new Error('orgiast.jp 所有を確認できません: ' + resource.getId());
  }
  try {
    resource.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT);
    if (resource.getSharingAccess() !== DriveApp.Access.DOMAIN_WITH_LINK ||
        resource.getSharingPermission() !== DriveApp.Permission.EDIT) {
      throw new Error('編集共有の読み戻し不一致: ' + resource.getId());
    }
  } catch (e) {
    var reason = String(e.message || e);
    console.warn('[CaseSharing] ' + caseId + ': ' + reason);
    var report = opts && opts.report || _CaseSharing_report;
    if (report) report.push({ shared: false, reason: reason });
  }
  return resource;
}

/** DOMAIN_WITH_LINK の対象ドメインを所有者から確定できる場合だけ許可する。 */
function CaseSharing_isCompanyOwner(email) {
  return /^[^@\s]+@orgiast\.jp$/i.test(String(email || ''));
}
