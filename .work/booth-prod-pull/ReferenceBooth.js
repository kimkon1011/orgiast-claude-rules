/**
 * 参考ブース写真の展示会別 Drive 蓄積機能（FB row28）。
 * 設営中・本番中に他社の参考ブース写真をアプリから送ると、
 * APP_ROOT_FOLDER_ID 配下の「参考ブース」フォルダ内に
 * 展示会ごとのフォルダを作って写真を蓄積する。
 */

var REFERENCE_BOOTH_ROOT_NAME = '参考ブース';

/**
 * Drive ファイル名/フォルダ名に使えない文字 [\\/:*?"<>|\r\n] を _ に置換し、40文字に切り詰める。
 */
function ReferenceBooth_safeName(v) {
  return String(v || '')
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .slice(0, 40);
}

/**
 * 展示会フォルダ名を作る純粋関数。
 * dateJst: Date または yyyy/MM/dd 形式の文字列。JST の月日を取り出す。
 * 戻り値: "<M>月<D>日_<展示会名>"（例: 10月5日_MACP展示会）
 * 展示会名が空なら "<M>月<D>日_展示会未設定"
 */
function ReferenceBooth_folderLabel(dateJst, caseName) {
  var month = 0, day = 0;
  if (dateJst instanceof Date && !isNaN(dateJst.getTime())) {
    // JST (UTC+9) の月日を計算
    var jstMs = dateJst.getTime() + (9 * 60 * 60 * 1000);
    var jstDate = new Date(jstMs);
    month = jstDate.getUTCMonth() + 1;
    day = jstDate.getUTCDate();
  } else if (typeof dateJst === 'string' && dateJst.trim()) {
    var m = dateJst.match(/(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})/);
    if (m) {
      month = parseInt(m[2], 10);
      day = parseInt(m[3], 10);
    }
  }

  var datePart = (month && day) ? (month + '月' + day + '日') : '日付未設定';
  var rawName = String(caseName || '').trim();
  var safeCaseName = rawName ? ReferenceBooth_safeName(rawName) : '展示会未設定';

  return datePart + '_' + safeCaseName;
}

/**
 * ファイル名を生成する純粋関数。
 * "<stamp>_<memo>_<index>.jpg" を返す。
 * stamp: yyyyMMdd_HHmm 形式の文字列。memo が空なら stamp + "_参考_" + index + ".jpg"。
 */
function ReferenceBooth_fileName(stamp, memo, index) {
  var safeStamp = String(stamp || '');
  var idx = (index != null) ? index : 1;
  var rawMemo = String(memo || '').trim();
  if (!rawMemo) {
    return safeStamp + '_参考_' + idx + '.jpg';
  }
  var safeMemo = ReferenceBooth_safeName(rawMemo);
  return safeStamp + '_' + safeMemo + '_' + idx + '.jpg';
}

/**
 * Drive の APP_ROOT_FOLDER_ID 配下に「参考ブース」フォルダを取得（無ければ作成）。
 */
function ReferenceBooth_rootFolder() {
  var rootId = (typeof APP_ROOT_FOLDER_ID !== 'undefined') ? APP_ROOT_FOLDER_ID : '1Yt1E9En7K8tMVONET32KgHkMWR4jWT8t';
  var root = DriveApp.getFolderById(rootId);
  var it = root.getFoldersByName(REFERENCE_BOOTH_ROOT_NAME);
  if (it.hasNext()) {
    return it.next();
  }
  return root.createFolder(REFERENCE_BOOTH_ROOT_NAME);
}

/**
 * CaseList_getById(caseId) から展示会名を作る。
 * caseName を優先し、空なら clientName。両方空なら ''。
 */
function ReferenceBooth_caseLabel(caseId) {
  if (!caseId) return '';
  try {
    if (typeof CaseList_getById === 'function') {
      var c = CaseList_getById(caseId);
      if (c) {
        var cn = String(c.caseName || '').trim();
        if (cn) return cn;
        var cl = String(c.clientName || '').trim();
        if (cl) return cl;
      }
    }
  } catch (e) {
    // 取得失敗時は空文字
  }
  return '';
}

/**
 * 展示会フォルダを取得（無ければ作る）。
 * opts.create === false のときは作成せず、無ければ null を返す。
 */
function ReferenceBooth_exhibitionFolder(caseId, opts) {
  var options = opts || {};
  var rootFolder = ReferenceBooth_rootFolder();
  var caseLabel = ReferenceBooth_caseLabel(caseId);
  var folderName = ReferenceBooth_folderLabel(new Date(), caseLabel);

  var it = rootFolder.getFoldersByName(folderName);
  if (it.hasNext()) {
    return it.next();
  }
  if (options.create === false) {
    return null;
  }
  return rootFolder.createFolder(folderName);
}

/**
 * スタッフ画面から呼ばれる保存入口。
 * payload = { caseId, images: [{base64, mimeType, name}], memo }
 */
function ReferenceBooth_save(payload) {
  try {
    var p = payload || {};
    var caseId = String(p.caseId || '').trim();
    var memo = String(p.memo || '').trim();
    var rawImages = p.images || [];

    var decoded = [];
    if (typeof _FeedbackRelay_decodeImages === 'function') {
      decoded = _FeedbackRelay_decodeImages(rawImages);
    } else {
      // フォールバック
      var list = Array.isArray(rawImages) ? rawImages.slice(0, 20) : [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i] || {};
        try {
          var bytes = Utilities.base64Decode(String(item.base64 || ''));
          var mimeType = String(item.mimeType || 'image/jpeg');
          var name = String(item.name || 'image.jpg').replace(/[\\/]/g, '_');
          var blob = Utilities.newBlob(bytes, mimeType, name);
          decoded.push({ blob: blob, name: name, bytes: bytes.length });
        } catch (err) {}
      }
    }

    if (!decoded || decoded.length === 0) {
      return { ok: false, error: '写真がありません' };
    }

    var targetFolder = ReferenceBooth_exhibitionFolder(caseId);
    var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
    var files = [];
    var exhibition = ReferenceBooth_caseLabel(caseId);

    for (var j = 0; j < decoded.length; j++) {
      var fileName = ReferenceBooth_fileName(stamp, memo, j + 1);
      var blobToSave = decoded[j].blob.copyBlob().setName(fileName);
      var savedFile = targetFolder.createFile(blobToSave);
      files.push({
        name: fileName,
        url: savedFile.getUrl()
      });
    }

    return {
      ok: true,
      files: files,
      exhibition: exhibition,
      folderName: targetFolder.getName(),
      folderUrl: targetFolder.getUrl()
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 画面表示用サマリー。
 * { ok:true, exhibition, folderName, folderUrl, count } を返す。
 */
function ReferenceBooth_summary(caseId) {
  try {
    var caseLabel = ReferenceBooth_caseLabel(caseId);
    var folder = ReferenceBooth_exhibitionFolder(caseId, { create: false });
    if (!folder) {
      var plannedName = ReferenceBooth_folderLabel(new Date(), caseLabel);
      return {
        ok: true,
        exhibition: caseLabel,
        folderName: plannedName,
        folderUrl: '',
        count: 0
      };
    }

    var filesIt = folder.getFiles();
    var count = 0;
    while (filesIt.hasNext()) {
      filesIt.next();
      count++;
    }

    return {
      ok: true,
      exhibition: caseLabel,
      folderName: folder.getName(),
      folderUrl: folder.getUrl(),
      count: count
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * メニューから参考ブース蓄積フォルダを開く。
 */
function ReferenceBooth_openRoot() {
  try {
    var folder = ReferenceBooth_rootFolder();
    var url = folder.getUrl();
    var html = HtmlService.createHtmlOutput(
      '<p>参考ブースの蓄積フォルダを開きます。</p>' +
      '<p><a href="' + url + '" target="_blank" style="font-size:16px;font-weight:bold;">フォルダを開く</a></p>' +
      '<script>window.open("' + url + '", "_blank");</script>'
    ).setWidth(350).setHeight(150);
    SpreadsheetApp.getUi().showModalDialog(html, '参考ブース蓄積フォルダ');
  } catch (e) {
    SpreadsheetApp.getUi().alert('参考ブース蓄積フォルダ', '開けませんでした: ' + (e && e.message ? e.message : e), SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ReferenceBooth_safeName: ReferenceBooth_safeName,
    ReferenceBooth_folderLabel: ReferenceBooth_folderLabel,
    ReferenceBooth_fileName: ReferenceBooth_fileName,
    ReferenceBooth_rootFolder: ReferenceBooth_rootFolder,
    ReferenceBooth_caseLabel: ReferenceBooth_caseLabel,
    ReferenceBooth_exhibitionFolder: ReferenceBooth_exhibitionFolder,
    ReferenceBooth_save: ReferenceBooth_save,
    ReferenceBooth_summary: ReferenceBooth_summary,
    ReferenceBooth_openRoot: ReferenceBooth_openRoot
  };
}
