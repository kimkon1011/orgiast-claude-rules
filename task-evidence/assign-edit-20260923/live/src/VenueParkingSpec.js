/** 一次資料: 駐車場候補検証_260909GRE.md / CLAUDE.md「2026-09 実績」。
 * null は未確認の場合もあるため、確認済み制限なしと note を区別して表示する。
 */
const VENUE_PARKING_SPECS = {
  '幕張メッセ': {
    venue: '幕張メッセ',
    candidates: [
      { name: '本村邸akippa駐車場', rank: '本命', address: '千葉県千葉市美浜区磯辺7-35-14',
        distanceToVenue: '約4km・車で10分', lengthMm: 5000, widthMm: 1900,
        heightLimitMm: null, weightLimitKg: null, surface: '平面', open24h: true, overnightOk: true,
        capacity: 3, reservationRequired: true, eightNumberProhibited: false,
        feeText: '¥1,000/日（日貸し・24時間・再入庫可）',
        url: 'https://www.akippa.com/parking/cba8f5b25e5cd10c56dd5c8b3981817d', verifiedOn: '2026-09-05',
        note: '高さ・重量制限なし。3台分以上。キャラバン全長4,990mmに対し枠5,000mm（1cm差）。デュトロはオーナーへ事前連絡・承諾取得。早朝の騒音配慮' },
      { name: '幕張海浜公園A・Bブロック', rank: '予備', address: null, distanceToVenue: null,
        lengthMm: null, widthMm: null, heightLimitMm: null, weightLimitKg: null,
        surface: '平面', open24h: true, overnightOk: true, capacity: null,
        reservationRequired: false, eightNumberProhibited: null, feeText: null, url: null, verifiedOn: '2026-09-06',
        note: '予約不要・先着。予約制が全滅した対象日に利用成立。高さ制限は記載なし（無制限の確認ではない）。住所・距離・寸法・重量・台数・8ナンバー規約・料金・URLは未確認' }
    ],
    knownUnusable: [
      { name: 'タイムズ幕張新都心', reason: '全長5m・全幅1.9m・全高2.1m・重量2.5t制限。デュトロ・キャラバン不可' },
      { name: 'タイムズ幕張ベイタウン第3', reason: '全長5m・全幅1.9m・全高2.1m・重量2.5t制限。実体未確認・URL重複。連続48時間上限' },
      { name: 'タイムズ幕張（花見川区幕張町5-544）', reason: '全長5m・全幅1.9m・全高2.1m・重量2.5t制限。連続48時間上限' },
      { name: 'タイムズ幕張第5', reason: '全長5m・全幅1.9m・全高2.1m・重量2.5t制限。連続48時間上限' },
      { name: '幕張免許センター前', reason: '全長470cm制限でキャラバン不可' },
      { name: 'タイムズ県営幕張地下第1/第2', reason: '地下・高さ2.0m制限' },
      { name: 'タイムズ アパホテル東京ベイ幕張', reason: '高さ2.5m・重量2.5t制限でデュトロ不可' },
      { name: '幕張海浜公園D・E・Fブロック', reason: '8:30〜21:00で夜間不可・大型車不可（検証資料はF、実装指示はD・E・F）' },
      { name: '幕張メッセ大型車枠', reason: '4,100円/日で高額、8:00〜23:00で夜間閉鎖。サイズは適合（営業時間は実装指示より）' }
    ]
  }
};

function VenueParkingSpec_get(venueName) {
  var normalized = String(venueName || '').normalize('NFKC').replace(/\s/g, '');
  var names = Object.keys(VENUE_PARKING_SPECS);
  for (var i = 0; i < names.length; i++) {
    if (normalized.indexOf(names[i]) >= 0) return JSON.parse(JSON.stringify(VENUE_PARKING_SPECS[names[i]]));
  }
  return null;
}

function VenueParkingSpec_recommendFor(venueName, truckNames) {
  var spec = VenueParkingSpec_get(venueName);
  var result = { venue: spec ? spec.venue : venueName, matched: !!spec, ok: [], ng: [], knownUnusable: spec ? spec.knownUnusable : [] };
  if (!spec) return result;
  var evaluate = typeof TruckExteriorSpec_evaluateCandidate === 'function'
    ? TruckExteriorSpec_evaluateCandidate : require('./TruckExteriorSpec.js').TruckExteriorSpec_evaluateCandidate;
  spec.candidates.forEach(function (candidate) {
    var check = evaluate(truckNames, candidate);
    if (check.ok) result.ok.push(candidate);
    else result.ng.push({ candidate: candidate, ng: check.ng });
  });
  return result;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  VenueParkingSpec_get: VenueParkingSpec_get, VenueParkingSpec_recommendFor: VenueParkingSpec_recommendFor
};
