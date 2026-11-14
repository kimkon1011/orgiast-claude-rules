/**
 * weekly-photo-list メインロジック
 *
 * 指定された Drive フォルダ内の画像ファイル一覧を HTML メールで送信する。
 * トリガーエントリ: weeklyPhotoListSend()
 */

/**
 * トリガーから呼ばれるエントリポイント。
 * 毎週月曜朝に自動実行される。
 */
function weeklyPhotoListSend() {
  var result = generateAndSendPhotoList();
  console.log('weeklyPhotoListSend result: ' + JSON.stringify(result));
}

/**
 * 写真リストを生成してメール送信する。
 * 設定未完了の場合はエラーを返す（送信しない）。
 */
function generateAndSendPhotoList() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('PHOTO_FOLDER_ID');
  var recipients = props.getProperty('RECIPIENT_EMAILS');

  if (!folderId) {
    return { ok: false, error: 'PHOTO_FOLDER_ID が未設定です。setPhotoFolder で設定してください。' };
  }
  if (!recipients) {
    return { ok: false, error: 'RECIPIENT_EMAILS が未設定です。setRecipients で設定してください。' };
  }

  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    return { ok: false, error: 'フォルダが見つかりません: ' + e.message };
  }

  var list = buildPhotoList(folder);
  var now = new Date();

  if (list.length === 0) {
    // 写真がない場合も「0件」として送信
    var emptyHtml = '<p>対象フォルダに画像ファイルはありませんでした。</p>';
    emptyHtml += '<p>フォルダ: <a href="' + folder.getUrl() + '">' + folder.getName() + '</a></p>';
    MailApp.sendEmail({
      to: recipients,
      subject: '【自動配信】週次写真リスト ' + formatDate(now) + '（0件）',
      htmlBody: emptyHtml
    });
    return { ok: true, totalFiles: 0, folderName: folder.getName() };
  }

  // HTML メール本文の構築
  var html = '<h2>週次写真リスト</h2>';
  html += '<p>フォルダ: <a href="' + folder.getUrl() + '">' + escapeHtml(folder.getName()) + '</a></p>';
  html += '<p>生成日時: ' + formatDate(now) + '</p>';
  html += '<p>合計: ' + list.length + ' 件</p>';
  html += '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; font-size:13px;">';
  html += '<tr style="background:#f0f0f0;"><th>ファイル名</th><th>更新日</th><th>サイズ</th><th>種類</th><th>リンク</th></tr>';

  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    html += '<tr>';
    html += '<td>' + escapeHtml(f.name) + '</td>';
    html += '<td>' + f.updated + '</td>';
    html += '<td style="text-align:right;">' + f.sizeKB + ' KB</td>';
    html += '<td>' + escapeHtml(f.mimeLabel) + '</td>';
    html += '<td><a href="' + f.url + '">開く</a></td>';
    html += '</tr>';
  }

  html += '</table>';
  html += '<hr><p style="color:#888; font-size:11px;">このメールは週次自動配信システム（weekly-photo-list GAS）により生成されています。</p>';

  MailApp.sendEmail({
    to: recipients,
    subject: '【自動配信】週次写真リスト ' + formatDate(now) + '（' + list.length + '件）',
    htmlBody: html
  });

  return { ok: true, totalFiles: list.length, folderName: folder.getName() };
}

/**
 * フォルダ内の画像ファイル一覧を取得する。
 * サブフォルダは再帰しない。
 */
function buildPhotoList(folder) {
  var files = folder.getFiles();
  var list = [];
  var imageMimes = {
    'image/jpeg': true,
    'image/png': true,
    'image/gif': true,
    'image/webp': true,
    'image/bmp': true,
    'image/svg+xml': true,
    'image/heic': true,
    'image/heif': true
  };

  while (files.hasNext()) {
    var file = files.next();
    var mime = file.getMimeType();
    if (!imageMimes[mime]) continue;

    list.push({
      name: file.getName(),
      updated: formatDate(file.getLastUpdated()),
      sizeKB: Math.round(file.getSize() / 1024),
      mimeLabel: mime.replace('image/', ''),
      url: file.getUrl()
    });
  }

  // 更新日の新しい順にソート
  list.sort(function(a, b) {
    if (a.updated > b.updated) return -1;
    if (a.updated < b.updated) return 1;
    return 0;
  });

  return list;
}

// ---- ユーティリティ ----

function formatDate(d) {
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}