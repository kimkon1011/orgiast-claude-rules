/** 一次資料: 駐車場候補検証_260909GRE.md / CLAUDE.md「2026-09 実績」。
 * null は未確認の場合もあるため、確認済み制限なしと note を区別して表示する。
 */
const VENUE_PARKING_SPECS = {
  '幕張メッセ': {
    venue: '幕張メッセ',
    loadingDock: {
      name: '国際展示場 各ホールの搬入口（ホールの南側・トラックヤード側）',
      mapUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('幕張メッセ 国際展示場'),
      driverRoute: 'まず「搬入出車輌待機所」（1ホールの東・メッセ有料駐車場のさらに東）へ矢印の方向から入る → 待っている車がいなければ、そのまま南②ゲートからトラックヤードへ入り、ブースのあるホールの搬入口で荷下ろし（警備員に止められたら指示に従う） → 車が並んでいれば警備員から整理券を受け取り、呼ばれたら南②ゲートから搬入口へ。車両証はフロントガラスに掲示。荷下ろし後は駐車場へ戻す',
      staffRoute: '正面入口ではなく、ブースのあるホールの南側（トラックヤード側）の搬入口へ。ヘルメット・長袖・長ズボン',
      source: 'Japan IT Week 秋2026 搬入出車輌証の経路図（主催 RX・2026-10-01 受領）。主催者が違う展示会は車両証の経路図で確認する'
    },
    candidates: [
      // 2026-10-18 cr 指示: 幕張メッセは毎回この駐車場で確定。変える案件だけ当日アプリの案件設定（parkingName）で上書き
      { name: '幕張海浜公園 Bブロック駐車場', rank: '本命', fixed: true, address: '千葉県千葉市美浜区ひび野2-116',
        mapUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('幕張海浜公園 Bブロック駐車場'),
        distanceToVenue: '幕張メッセまで徒歩約11分', lengthMm: null, widthMm: null,
        heightLimitMm: null, weightLimitKg: null, surface: '平面', open24h: true, overnightOk: true,
        capacity: 92, reservationRequired: false, eightNumberProhibited: null,
        feeText: '8時間以内¥600＋以後1時間ごと¥100（24時間・年中無休）',
        url: 'https://www.seibu-la.co.jp/makuhari/access.html', verifiedOn: '2026-09-06',
        note: 'kim 確定（2026-09-06 実利用で成立）。予約不要・先着。屋外平面・高さ制限の記載なし。公式は「普通車」台数表記のため満車時はAブロックへ。問合せ 043-296-0126' },
      { name: '幕張海浜公園 Aブロック駐車場', rank: '予備', address: '千葉県千葉市美浜区ひび野1-110',
        mapUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('幕張海浜公園 Aブロック駐車場'),
        distanceToVenue: null, lengthMm: null, widthMm: null,
        heightLimitMm: null, weightLimitKg: null, surface: '平面', open24h: true, overnightOk: true,
        capacity: 63, reservationRequired: false, eightNumberProhibited: null, feeText: null,
        url: 'https://www.seibu-la.co.jp/makuhari/access.html', verifiedOn: '2026-09-06',
        note: 'Bブロックが満車のとき。予約不要・先着。料金・営業時間は公式に明記なし（9/6 はA・Bで成立）' },
      { name: '本村邸akippa駐車場', rank: '予備', address: '千葉県千葉市美浜区磯辺7-35-14',
        distanceToVenue: '約4km・車で10分', lengthMm: 5000, widthMm: 1900,
        heightLimitMm: null, weightLimitKg: null, surface: '平面', open24h: true, overnightOk: true,
        capacity: 3, reservationRequired: true, eightNumberProhibited: false,
        feeText: '¥1,000/日（日貸し・24時間・再入庫可）',
        url: 'https://www.akippa.com/parking/cba8f5b25e5cd10c56dd5c8b3981817d', verifiedOn: '2026-09-05',
        note: '予約制。A・Bブロックが満車のときの予備。高さ・重量制限なし。3台分以上。キャラバン全長4,990mmに対し枠5,000mm（1cm差）。デュトロはオーナーへ事前連絡・承諾取得。早朝の騒音配慮' }
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
  },
  // 以下3会場は 2026-10-01 Web 調査（予約ページ本文）で登録。現地未検証。8ナンバー可否・台数は予約前にオーナー確認。
  'ビッグサイト': {
    venue: '東京ビッグサイト',
    candidates: [
      { name: 'コインパーク東雲駅前（東雲駅前駐車場）', rank: '本命', address: '東京都江東区東雲2-11',
        distanceToVenue: '東雲駅から徒歩約3分', lengthMm: null, widthMm: null,
        heightLimitMm: null, weightLimitKg: null, surface: '平面', open24h: true, overnightOk: true,
        capacity: 8, reservationRequired: false, eightNumberProhibited: null,
        feeText: '最大 月〜土¥1,500／日祝¥1,700（24時間ごと）',
        url: 'https://www.s-park.jp/map/501864', verifiedOn: '2026-10-01',
        note: 'kim 確定（ビッグサイトでいつも利用）。予約不要・先着・平地自走・24時間。8台のため満車時は予備へ。同名のリパーク東雲駅前第3は高さ2m・重量2tでトラック不可なので間違えないこと' },
      { name: 'トモビル駐車場【2】(akippa)', rank: '予備', address: '東京都江東区新木場2-2-7',
        distanceToVenue: null, lengthMm: 7500, widthMm: 2400,
        heightLimitMm: null, weightLimitKg: null, surface: '平面', open24h: true, overnightOk: true,
        capacity: null, reservationRequired: true, eightNumberProhibited: null,
        feeText: '¥1,800〜/日（日貸し・24時間・再入庫可・複数日予約可）',
        url: 'https://www.akippa.com/parking/8445ac45a8c23c18163b8cb25b31e466', verifiedOn: '2026-10-01',
        note: '東雲駅前が満車のときの予約制の予備。高さ・重量制限なし・大型車可と記載。8ナンバー可否と台数は予約時にオーナーへ確認' }
    ],
    knownUnusable: [
      { name: 'リパーク東雲駅前第3', reason: '高さ2m・全長5m・重量2t制限でトラック不可（コインパーク東雲駅前と取り違え注意）' },
      { name: 'タイムズグランドシップ東雲', reason: '立体・高さ2.1m・重量2.5t' },
      { name: '東雲臨時駐車場', reason: '08:00〜23:00・入庫18時まで。夜間留置不可' },
      { name: '東棟屋外臨時駐車場／有明東臨時駐車場', reason: '7:00〜23:00で夜間閉鎖' },
      { name: '青海北臨時／青海臨時駐車場', reason: 'バス・トラック不可、または高さ2.4m・7:00〜22:00' },
      { name: 'TOC有明駐車場', reason: '屋上・高さ2.3m・日またぎ不可' },
      { name: 'タイムズ有明フロンティア／有明スポーツセンター／Dパーキング有明セントラルタワー', reason: '高さ2.1m以下・重量2.5t以下' },
      { name: 'トモビル駐車場【3】', reason: '全長480cm以下でキャラバン不可' }
    ]
  },
  'パシフィコ横浜': {
    venue: 'パシフィコ横浜',
    candidates: [
      { name: 'パシフィコ横浜 バス・大型車駐車場(P3)', rank: '本命', address: '神奈川県横浜市西区みなとみらい1-1',
        distanceToVenue: '会場併設', lengthMm: null, widthMm: null,
        heightLimitMm: null, weightLimitKg: null, surface: '未確認', open24h: false, overnightOk: true,
        capacity: 8, reservationRequired: true, eightNumberProhibited: null,
        feeText: '7:00〜22:00 ¥500/30分・22:00〜7:00 ¥500/1時間',
        url: 'https://www.city.yokohama.lg.jp/kurashi/machizukuri-kankyo/kotsu/toshikotsu/chushajo/kannkou.html', verifiedOn: '2026-10-01',
        note: '入出庫は7:00〜22:00のみ（夜間は留め置きのみ可）。予約は電話 045-221-1302。枠寸法・高さ・重量・8ナンバー可否は電話予約時に確認' }
    ],
    knownUnusable: [
      { name: 'みなとみらい公共駐車場', reason: '車高2.1m以下' },
      { name: 'パシフィコ ノース駐車場', reason: '高さ2.3m・重量3.5t制限でデュトロ不可' },
      { name: 'タイムズみなとみらい第5', reason: '全長5m・全幅1.9m・全高2.1m・重量2.5t制限' }
    ]
  },
  'インテックス大阪': {
    venue: 'インテックス大阪',
    candidates: [
      { name: '平林南2丁目駐車場【火〜金曜】(akippa)', rank: '本命', address: '大阪府大阪市住之江区平林南2-10-9',
        distanceToVenue: null, lengthMm: 16000, widthMm: 3300,
        heightLimitMm: null, weightLimitKg: null, surface: '平面', open24h: true, overnightOk: true,
        capacity: null, reservationRequired: true, eightNumberProhibited: null,
        feeText: '¥1,000〜/日（火〜金曜のみ・24時間・再入庫可）',
        url: 'https://www.akippa.com/parking/99b91b093cc314ad0fb069856dfe72b3', verifiedOn: '2026-10-01',
        note: 'kim 未確定（Web調査のみ）。周辺の公共・コイン駐車場（中ふ頭・南港中央公園等）は高さ2.0〜2.1m・重量2.5tで全滅のため予約制のここを本命にしている。高さ・重量制限なし、トラック利用のレビューあり。日曜は別枠(長500×幅250・¥1,200〜) https://www.akippa.com/parking/1e1b6cebbab4fcd66c228d2b4f62bbc8 。月・土は未確認。8ナンバー可否と台数は予約時に確認' }
    ],
    knownUnusable: [
      { name: 'タイムズインテックス大阪中ふ頭', reason: '普通車のみ・高さ2.0m・全長5.0m' },
      { name: 'インテックス大阪 臨時第1駐車場', reason: 'イベント時のみ8:00〜18:00で夜間不可' },
      { name: 'インテックス大阪 屋上駐車場', reason: '開催時間のみ・高さ2.0m' },
      { name: 'ミスターP平林南2丁目駐車場', reason: '立体・高さ2.3m・重量2.5t以下' }
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
