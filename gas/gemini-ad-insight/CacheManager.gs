/**
 * 広告テキスト解析結果のキャッシュ制御。
 * 同一テキストの再解析を防止し、API呼び出しコストと時間を削減する。
 *
 * キャッシュキー: 正規化されたテキストの MD5 ハッシュ
 * 保存先: Script Properties（キー接頭辞: CACHE_）
 * 有効期限: 30日間（エポック秒で管理）
 */

var CACHE_PREFIX_ = 'CACHE_';
var CACHE_TTL_SEC_ = 30 * 24 * 60 * 60; // 30日

/**
 * テキストの正規化済みMD5ハッシュを返す。
 * 空白の正規化と小文字統一を行う。
 */
function _cacheKey_(text) {
  var normalized = String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    normalized,
    Utilities.Charset.UTF_8
  );
  return digest.map(function (b) {
    return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join('');
}

/**
 * キャッシュに結果が存在し、有効期限内なら true を返す。
 * @param {string} text - 解析対象の広告テキスト
 * @return {boolean}
 */
function hasCachedResult(text) {
  var key = CACHE_PREFIX_ + _cacheKey_(text);
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return false;
  try {
    var entry = JSON.parse(raw);
    var now = Math.floor(Date.now() / 1000);
    return (now - entry.ts) < CACHE_TTL_SEC_;
  } catch (e) {
    return false;
  }
}

/**
 * キャッシュから解析結果を取得する。
 * 有効期限切れの場合は null を返す。
 * @param {string} text - 解析対象の広告テキスト
 * @return {Object|null}
 */
function getCachedResult(text) {
  var key = CACHE_PREFIX_ + _cacheKey_(text);
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try {
    var entry = JSON.parse(raw);
    var now = Math.floor(Date.now() / 1000);
    if ((now - entry.ts) >= CACHE_TTL_SEC_) {
      PropertiesService.getScriptProperties().deleteProperty(key);
      return null;
    }
    return entry.result;
  } catch (e) {
    return null;
  }
}

/**
 * 解析結果をキャッシュに保存する。
 * @param {string} text - 解析対象の広告テキスト
 * @param {Object} result - 解析結果オブジェクト
 */
function setCachedResult(text, result) {
  var key = CACHE_PREFIX_ + _cacheKey_(text);
  var entry = {
    ts: Math.floor(Date.now() / 1000),
    result: result
  };
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(entry));
}

/**
 * 期限切れキャッシュを掃除する。
 * @return {number} 削除した件数
 */
function pruneExpiredCache() {
  var props = PropertiesService.getScriptProperties();
  var allKeys = props.getKeys();
  var now = Math.floor(Date.now() / 1000);
  var removed = 0;
  allKeys.forEach(function (key) {
    if (key.indexOf(CACHE_PREFIX_) !== 0) return;
    try {
      var entry = JSON.parse(props.getProperty(key));
      if ((now - entry.ts) >= CACHE_TTL_SEC_) {
        props.deleteProperty(key);
        removed++;
      }
    } catch (e) {
      props.deleteProperty(key);
      removed++;
    }
  });
  return removed;
}