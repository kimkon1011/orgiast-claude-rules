function _Doc_buildPdfExportUrl(fileId, opts) {
  opts = opts || {};
  if (opts.gid !== undefined && opts.gid !== null && opts.gid !== '') {
    return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(fileId) + '/export' +
      '?format=pdf&gid=' + encodeURIComponent(opts.gid) +
      '&portrait=true&fitw=true&gridlines=false&printtitle=false&sheetnames=false&pagenumbers=false' +
      '&top_margin=0.4&bottom_margin=0.4&left_margin=0.4&right_margin=0.4';
  }
  return 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/export?mimeType=application/pdf';
}

function Doc_exportPdf(fileId, pdfName, folder, opts) {
  var url = _Doc_buildPdfExportUrl(fileId, opts);
  var response = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error('PDF export 失敗: ' + response.getResponseCode() + ' ' + response.getContentText().slice(0, 200));
  var blob = response.getBlob().setName(pdfName);
  var file = folder.createFile(blob);
  try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { pdfUrl: file.getUrl(), sizeKb: Math.round(blob.getBytes().length / 1024) };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { _Doc_buildPdfExportUrl: _Doc_buildPdfExportUrl };

/** キュー用: フォルダ ID を受けて PDF 化。folderId 省略時はファイルの親フォルダ。 */
function Doc_exportPdfToFolder(fileId, pdfName, folderId, opts) {
  var folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getFileById(fileId).getParents().next();
  var name = pdfName || (DriveApp.getFileById(fileId).getName() + '.pdf');
  return Doc_exportPdf(fileId, name, folder, opts || {});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports.Doc_exportPdfToFolder = Doc_exportPdfToFolder;
}
