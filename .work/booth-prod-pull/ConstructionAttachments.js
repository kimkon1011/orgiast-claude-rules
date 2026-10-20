/** Resolve Drive attachments for the external construction-manual-app UI.
 * Originals stay in Drive; thumbnails are previews, never a full-page conversion.
 */
function ConstructionAttachments_resolve(caseId, attachments) {
  var c = CaseList_getById(String(caseId || ''));
  if (!c) throw new Error('案件が見つかりません');
  if (!Array.isArray(attachments) || attachments.length > 25) throw new Error('attachments は25件以下の配列で指定してください');
  var seen = {}, bytesUsed = 0;
  var results = attachments.map(function (entry) {
    if (!entry || !/^[A-Za-z0-9_-]{10,200}$/.test(String(entry.fileId || ''))) throw new Error('Drive fileId が不正です');
    var id = String(entry.fileId);
    if (seen[id]) return null;
    seen[id] = true;
    var file = DriveApp.getFileById(id);
    var mimeType = file.getMimeType();
    if (entry.mimeType && entry.mimeType !== mimeType) throw new Error('mimeType がDriveの実ファイルと一致しません: ' + id);
    var result = { fileId:id, mimeType:mimeType, name:file.getName(), url:file.getUrl(),
      preview:null, renderMode:'linkPlaceholder', previewOnly:true };
    try {
      var thumbnail = file.getThumbnail();
      if (thumbnail) {
        var bytes = thumbnail.getBytes();
        if (bytes.length <= 262144 && bytesUsed + bytes.length <= 3145728 && /^image\//.test(thumbnail.getContentType())) {
          result.preview = { mimeType:thumbnail.getContentType(), base64:Utilities.base64Encode(bytes) };
          result.renderMode = 'thumbnail'; bytesUsed += bytes.length;
        }
      }
    } catch (e) { /* A link placeholder is the supported fallback for any file type. */ }
    return result;
  }).filter(function (x) { return !!x; });
  return { ok:true, caseId:String(c.caseId), attachments:results };
}

function _debug_constructionAttachments(caseId, attachments) {
  return ConstructionAttachments_resolve(caseId, attachments || []);
}
