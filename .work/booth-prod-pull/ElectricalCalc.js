/** GAS API を一切使わない電気容量計算。 */
const ELECTRICAL_BUFFER_RATE = 0.15;

function ElectricalCalc_calculate(items, opts) {
  opts = opts || {};
  const master = typeof ELECTRICAL_EQUIPMENT_MASTER !== 'undefined' ? ELECTRICAL_EQUIPMENT_MASTER : require('./ElectricalEquipmentMaster.js').ELECTRICAL_EQUIPMENT_MASTER;
  const aliases = typeof ELECTRICAL_EQUIPMENT_ALIASES !== 'undefined' ? ELECTRICAL_EQUIPMENT_ALIASES : require('./ElectricalEquipmentMaster.js').ELECTRICAL_EQUIPMENT_ALIASES;
  const unknownEquipment = [];
  const equipment = (items || []).map(function (item) {
    item = item || {};
    const rawName = String(item.name || item.equipmentName || '').trim();
    const name = aliases[rawName] || rawName;
    const known = Object.prototype.hasOwnProperty.call(master, name);
    const specified = item.watts !== undefined && item.watts !== null && item.watts !== '';
    const watts = known ? Number(master[name]) : (specified ? Number(item.watts) : null);
    const quantity = Math.max(0, Number(item.quantity == null ? 1 : item.quantity) || 0);
    if (!known) unknownEquipment.push({ name: rawName, quantity: quantity, watts: watts, estimated: specified, unresolved: !specified });
    return { name: name || rawName, quantity: quantity, watts: Number.isFinite(watts) ? watts : null,
      totalWatts: Number.isFinite(watts) ? quantity * watts : 0, estimated: !known && specified,
      voltage: Number(item.voltage) === 200 ? 200 : 100, note: String(item.note || '') };
  });
  const totalWatts = equipment.reduce(function (sum, item) { return sum + item.totalWatts; }, 0);
  // p0360 の旧「+1kw」ではなく、現行の実シートどおり15%バッファを使う。
  // 1590 * 1.15 がIEEE 754上で1828.499999...になるため、SheetsのROUNDと同じ四捨五入に補正する。
  const applicationWatts = Math.floor(totalWatts * (1 + ELECTRICAL_BUFFER_RATE) + 0.5 + Number.EPSILON * Math.max(1, totalWatts));
  const applicationKw = Math.ceil(applicationWatts / 1000);
  const requiredOutlets = Math.ceil(applicationWatts / 1000);
  const booth = ElectricalCalc_parseBoothSize(opts.boothSize);
  const highLoadOutletCount = Number(opts.highLoadOutletCount);
  const highLoadKnown = Number.isFinite(highLoadOutletCount) && highLoadOutletCount >= 0;
  return {
    equipment: equipment, unknownEquipment: unknownEquipment, totalWatts: totalWatts,
    bufferRate: ELECTRICAL_BUFFER_RATE, applicationWatts: applicationWatts, applicationKw: applicationKw,
    requiredOutlets: requiredOutlets, needsDistributionBoard: applicationKw >= 3,
    needsElectricianDispatch: applicationKw >= 3 || booth.exceeds6x6,
    needsPrimaryTrunkWork: highLoadKnown && highLoadOutletCount >= 10,
    needsPrimaryTrunkWorkUncertain: !highLoadKnown && applicationWatts > 0,
    primaryTrunkWorkReason: highLoadKnown
      ? '1500W以上を要するコンセント口数が' + highLoadOutletCount + '口（10口以上で一次幹線工事）'
      : 'コンセント口ごとの負荷配分が未確定のため、1500W以上の口が10口以上か判定できない',
    has200V: equipment.some(function (item) { return item.voltage === 200; })
  };
}

function ElectricalCalc_parseBoothSize(value) {
  const nums = String(value || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
  let w = Number(nums[0]) || 0, h = Number(nums[1]) || 0;
  if (w > 100) w /= 1000;
  if (h > 100) h /= 1000;
  // 「6m×6m まで自社スタッフ」(p5423)。片辺だけ長い小間(9m×3m 等)も超過扱いにするため
  // 辺・面積のいずれかが 6m×6m=36㎡ を超えたら true。
  return { widthM: w, depthM: h, exceeds6x6: w > 6 || h > 6 || w * h > 36 };
}

if (typeof module !== 'undefined') module.exports = { ELECTRICAL_BUFFER_RATE, ElectricalCalc_calculate, ElectricalCalc_parseBoothSize };
