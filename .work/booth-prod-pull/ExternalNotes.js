/**
 * 外部連絡（メール・Discord・LINE）を案件フォルダの Google ドキュメントへ追記する共通部品。
 * ドキュメント ID は案件一覧に空き列が無いため Script property EXTNOTES_DOC_<caseId> に保持する。
 */

const EXTNOTES_DOC_TITLE = '📨外部連絡（メール・Discord・LINE）';
const EXTNOTES_PROP_PREFIX = 'EXTNOTES_DOC_';
const EXTNOTES_TZ_OFFSET_MS = 9 * 60 * 60 * 1000; // Asia/Tokyo (DST なし)

function _ExtNotes_pad(n) { return (n < 10 ? '0' : '') + n; }

function _ExtNotes_formatAt(at) {
  const d = at instanceof Date ? at : new Date(at || Date.now());
  const t = new Date((isNaN(d.getTime()) ? Date.now() : d.getTime()) + EXTNOTES_TZ_OFFSET_MS);
  return t.getUTCFullYear() + '-' + _ExtNotes_pad(t.getUTCMonth() + 1) + '-' + _ExtNotes_pad(t.getUTCDate()) +
    ' ' + _ExtNotes_pad(t.getUTCHours()) + ':' + _ExtNotes_pad(t.getUTCMinutes());
}

/** 追記する行の配列を返す純粋関数: 先頭行 `[日時][source][author] text`、続けて links（1件1行）。 */
function ExternalNotes_formatLines(source, entry) {
  const e = entry || {};
  const head = '[' + _ExtNotes_formatAt(e.at) + '][' + String(source || '') + '][' + String(e.author || '') + '] ' +
    String(e.text || '');
  const lines = [head];
  (e.links || []).forEach(function (u) { if (u) lines.push('  ' + String(u)); });
  return lines;
}

function _ExtNotes_wrapDoc(doc) {
  return {
    id: doc.getId(), url: doc.getUrl(),
    appendLines: function (lines) {
      const body = doc.getBody();
      lines.forEach(function (l) { body.appendParagraph(l); });
      doc.saveAndClose();
    }
  };
}

function _ExtNotes_defaultDeps() {
  return {
    getProp: function (k) { return PropertiesService.getScriptProperties().getProperty(k); },
    setProp: function (k, v) { PropertiesService.getScriptProperties().setProperty(k, v); },
    getCase: function (caseId) { return CaseList_getById(caseId); },
    openDoc: function (id) { return _ExtNotes_wrapDoc(DocumentApp.openById(id)); },
    createDoc: function (folderId, title) {
      const doc = DocumentApp.create(title);
      if (folderId) DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId));
      return _ExtNotes_wrapDoc(doc);
    }
  };
}

function ExternalNotes_append(caseId, source, entry, deps) {
  const d = deps || _ExtNotes_defaultDeps();
  const c = d.getCase(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const key = EXTNOTES_PROP_PREFIX + c.caseId;
  let doc = null;
  const savedId = d.getProp(key);
  if (savedId) {
    try { doc = d.openDoc(savedId); } catch (e) { doc = null; } // 削除・権限喪失時は作り直す
  }
  if (!doc) {
    doc = d.createDoc(c.folderId || '', EXTNOTES_DOC_TITLE);
    d.setProp(key, doc.id);
  }
  doc.appendLines(ExternalNotes_formatLines(source, entry));
  return { docId: doc.id, url: doc.url };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExternalNotes_formatLines: ExternalNotes_formatLines, ExternalNotes_append: ExternalNotes_append,
    _ExtNotes_formatAt: _ExtNotes_formatAt };
}
