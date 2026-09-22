/**
 * 車両「外寸」マスタ。
 *
 * ⚠️ Phase2_VolumeCalc / トラック別積載量シミュレーションが持つ長さ・幅・高さは
 *    すべて【荷台内寸】であり、駐車場・高さ制限の判定には使えない。
 *    駐車場まわりの判定は必ずこのファイルの外寸を使うこと。
 *
 * 出典:
 *   デュトロ   … 車検証（川越400す5533 / TQG-XKU600M）＋
 *                 社内マニュアル「【必読！！】トラック乗車時注意事項（デュトロ）」
 *                 ※車検証の全高1,980mmは平ボディ状態。幌を架装した実高は2,970mm。
 *   キャラバン … 車検証（川越800さ4346 / GE-CQGE25 / キャンピング車登録）
 *   レンタル各種 … 車格ごとの代表値（実車は要確認）
 */
const TRUCK_EXTERIOR_SPECS = {
  'デュトロ': { lengthMm: 4690, widthMm: 1690, heightMm: 2970, gvwKg: 6145, plateClass: '4', licenseClass: '準中型', parkingFeeClass: '普通・準中型', confirmed: true, note: '幌込み実高2,970mm。車検証の1,980mm(平ボディ)を使わないこと' },
  '日産キャラバン': { lengthMm: 4990, widthMm: 1690, heightMm: 2280, gvwKg: 2590, plateClass: '8', licenseClass: '普通', parkingFeeClass: '普通・準中型', confirmed: true, note: '' },
  '軽トラック 標準': { lengthMm: 3395, widthMm: 1475, heightMm: 1780, gvwKg: 1100, plateClass: '4', licenseClass: '普通', parkingFeeClass: '普通・準中型', confirmed: false, note: '' },
  '軽トラック ハイルーフ': { lengthMm: 3395, widthMm: 1475, heightMm: 2000, gvwKg: 1150, plateClass: '4', licenseClass: '普通', parkingFeeClass: '普通・準中型', confirmed: false, note: '' },
  '2トン ショート箱車': { lengthMm: 4700, widthMm: 1890, heightMm: 2900, gvwKg: 4965, plateClass: '1', licenseClass: '準中型', parkingFeeClass: '普通・準中型', confirmed: false, note: '' },
  '2トン ロング箱車': { lengthMm: 6100, widthMm: 1890, heightMm: 3000, gvwKg: 4965, plateClass: '1', licenseClass: '準中型', parkingFeeClass: '普通・準中型', confirmed: false, note: '' },
  '2トン ワイドロング箱車': { lengthMm: 6300, widthMm: 2130, heightMm: 3100, gvwKg: 4965, plateClass: '1', licenseClass: '準中型', parkingFeeClass: '普通・準中型', confirmed: false, note: '' },
  '4トン 標準箱車': { lengthMm: 8000, widthMm: 2270, heightMm: 3150, gvwKg: 7965, plateClass: '1', licenseClass: '中型', parkingFeeClass: '大型・中型', confirmed: false, note: '' },
  '4トン セミワイド箱車': { lengthMm: 8000, widthMm: 2360, heightMm: 3200, gvwKg: 7965, plateClass: '1', licenseClass: '中型', parkingFeeClass: '大型・中型', confirmed: false, note: '' },
  '4トン フルワイド箱車': { lengthMm: 8000, widthMm: 2490, heightMm: 3250, gvwKg: 7965, plateClass: '1', licenseClass: '中型', parkingFeeClass: '大型・中型', confirmed: false, note: '' }
};

/** 一般的なコインパーキングの標準的な制限値（この値を超えたら警告する） */
const COIN_PARKING_TYPICAL_LIMIT = { lengthMm: 5000, widthMm: 1900, heightMm: 2100, gvwKg: 2500 };

function TruckExteriorSpec_get(truckName) {
  return Object.prototype.hasOwnProperty.call(TRUCK_EXTERIOR_SPECS, truckName) ? TRUCK_EXTERIOR_SPECS[truckName] : null;
}

function TruckExteriorSpec_requirementFor(truckNames) {
  const result = { maxLengthMm: 0, maxWidthMm: 0, maxHeightMm: 0, maxGvwKg: 0, unknownTrucks: [], unconfirmedTrucks: [] };
  (truckNames || []).forEach(function (truckName) {
    const spec = TruckExteriorSpec_get(truckName);
    if (!spec) {
      result.unknownTrucks.push(truckName);
      return;
    }
    result.maxLengthMm = Math.max(result.maxLengthMm, spec.lengthMm);
    result.maxWidthMm = Math.max(result.maxWidthMm, spec.widthMm);
    result.maxHeightMm = Math.max(result.maxHeightMm, spec.heightMm);
    result.maxGvwKg = Math.max(result.maxGvwKg, spec.gvwKg);
    if (!spec.confirmed) result.unconfirmedTrucks.push(truckName);
  });
  return result;
}

function TruckExteriorSpec_checkCoinParking(truckNames) {
  const violations = [];
  const fields = ['lengthMm', 'widthMm', 'heightMm', 'gvwKg'];
  (truckNames || []).forEach(function (truckName) {
    const spec = TruckExteriorSpec_get(truckName);
    if (!spec) return;
    fields.forEach(function (field) {
      if (spec[field] > COIN_PARKING_TYPICAL_LIMIT[field]) {
        violations.push({ truck: truckName, field: field, actual: spec[field], limit: COIN_PARKING_TYPICAL_LIMIT[field] });
      }
    });
  });
  return { ok: violations.length === 0, violations: violations };
}

function TruckExteriorSpec_licenseClassFromGvw(gvwKg) {
  if (gvwKg < 3500) return '普通';
  if (gvwKg < 7500) return '準中型';
  if (gvwKg < 11000) return '中型';
  return '大型';
}

function TruckExteriorSpec_parkingSearchCriteria(truckNames) {
  const requirement = TruckExteriorSpec_requirementFor(truckNames);
  const eightNumberTrucks = [];
  const feeClasses = [];
  (truckNames || []).forEach(function (truckName) {
    const spec = TruckExteriorSpec_get(truckName);
    if (!spec) return;
    if (spec.plateClass === '8') eightNumberTrucks.push(truckName);
    if (spec.parkingFeeClass && feeClasses.indexOf(spec.parkingFeeClass) === -1) feeClasses.push(spec.parkingFeeClass);
  });
  const checkPoints = [
    '連続駐車の上限時間（「最大48時間まで」の規約に注意）',
    '台数分の枠を同一場所で確保できるか',
    '候補を出す前に対象日の空き状況を必ず確認する（予約制は満車だと一件も使えない）',
    '予約制が満車の場合に備え、予約不要（先着）の駐車場も候補に入れる'
  ];
  if (eightNumberTrucks.length > 0) checkPoints.push('8ナンバー車両お断りの規約がないか');
  checkPoints.push('住宅地の場合は早朝出庫の騒音配慮');
  return {
    maxLengthMm: requirement.maxLengthMm,
    maxWidthMm: requirement.maxWidthMm,
    maxHeightMm: requirement.maxHeightMm,
    requiredClearanceMm: requirement.maxHeightMm + 300,
    hasEightNumber: eightNumberTrucks.length > 0,
    eightNumberTrucks: eightNumberTrucks,
    feeClasses: feeClasses,
    mustHave: ['平面（屋外自走・屋根なし）', '24時間入出庫可', '夜間留置可（連続2日以上の予約）'],
    mustAvoid: ['立体・地下・機械式（高さ2.0〜2.1mが標準）', '高架下（高さ制限あり）', '会場・公園の駐車場（夜間閉鎖のため前泊不可）', '個人宅シェア型（1台枠・乗用車規模）'],
    checkPoints: checkPoints
  };
}

function TruckExteriorSpec_evaluateCandidate(truckNames, candidate) {
  const criteria = TruckExteriorSpec_parkingSearchCriteria(truckNames);
  const ng = [];
  const warn = [];
  candidate = candidate || {};
  if (typeof candidate.lengthMm === 'number' && candidate.lengthMm < criteria.maxLengthMm) ng.push('全長が不足（必要' + criteria.maxLengthMm + 'mm以上）');
  if (typeof candidate.widthMm === 'number' && candidate.widthMm < criteria.maxWidthMm) ng.push('横幅が不足（必要' + criteria.maxWidthMm + 'mm以上）');
  if (candidate.heightLimitMm != null) {
    if (candidate.heightLimitMm < criteria.maxHeightMm) {
      ng.push('高さ制限' + candidate.heightLimitMm + 'mmが車両最大全高' + criteria.maxHeightMm + 'mm未満');
    } else if (candidate.heightLimitMm - criteria.maxHeightMm < 300) {
      warn.push('クリアランス' + ((candidate.heightLimitMm - criteria.maxHeightMm) / 10) + 'cm・非推奨');
    }
  }
  if (candidate.surface !== '平面') ng.push('平面駐車場ではない（' + (candidate.surface || '不明') + '）');
  if (candidate.open24h === false) ng.push('24時間入出庫不可');
  if (candidate.overnightOk === false) ng.push('夜間留置不可');
  if (candidate.eightNumberProhibited && criteria.hasEightNumber) ng.push('8ナンバー車両お断り（該当: ' + criteria.eightNumberTrucks.join('、') + '）');
  return { ok: ng.length === 0, ng: ng, warn: warn };
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  TRUCK_EXTERIOR_SPECS: TRUCK_EXTERIOR_SPECS,
  COIN_PARKING_TYPICAL_LIMIT: COIN_PARKING_TYPICAL_LIMIT,
  TruckExteriorSpec_get: TruckExteriorSpec_get,
  TruckExteriorSpec_requirementFor: TruckExteriorSpec_requirementFor,
  TruckExteriorSpec_checkCoinParking: TruckExteriorSpec_checkCoinParking,
  TruckExteriorSpec_licenseClassFromGvw: TruckExteriorSpec_licenseClassFromGvw,
  TruckExteriorSpec_parkingSearchCriteria: TruckExteriorSpec_parkingSearchCriteria,
  TruckExteriorSpec_evaluateCandidate: TruckExteriorSpec_evaluateCandidate
};
