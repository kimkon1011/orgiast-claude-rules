/** 電気申請用の確定機器マスタ。値は社内「電力計算シート」から転記し、推測で変更しない。 */
const ELECTRICAL_EQUIPMENT_MASTER = Object.freeze({
  'ノートPC': 60, '22インチモニター': 25, '27インチモニター': 45, '42インチモニター': 118,
  '55インチモニター': 190, '65インチモニター': 230, '85インチモニター': 500, '17インチモニター': 20,
  'PAスピーカー YAMAHA DBR10': 60, 'スピーカー': 60, 'ミキサー': 30,
  'YAMAHA MG10XUF ミキシングコンソール': 22.9, 'ワイヤレスマイク受信機': 10, 'HDMI分配器': 20,
  'BIGLED UP（W1000 x H2000〜2980mm）': 120, 'BIGLED UP（W1500 x H2000〜2980mm）': 170,
  'BIGLED UP（W2000 x H2000〜2980mm）': 230, 'BIGLED UP（W2500 x H2000〜2980mm）': 280,
  'BIGLED UP（W3000 x H2000〜2980mm）': 340, 'BIGLED UP（W4000 x H2000〜2980mm）': 460,
  'BIGLED UP（W5000 x H2000〜2980mm）': 600, 'LED UP': 150, 'LED照明': 150,
  '（備品コード1038）LED投光器': 150, '（備品コード2437）LED投光器': 300, 'LEDチューブ 90m': 180,
  'テープライト': 75, 'A1 LEDポスターパネル': 16, 'クリップライト': 3, 'チャンネルサイン': 200,
  'ロゴボックス': 20, 'Motion MARU': 600, 'スイッチングハブ': 10, 'Wi-Fiルーター': 15,
  'POSレジ': 40, 'タブレット': 10, '釣り銭機': 100, '放射性薬剤投与装置': 150,
  'デリバリーPET用分注装置': 45, '放射線防護用移動式バリア': 100,
  'レマコム R4-G-63SLW 卓上4面ガラス冷蔵ショーケース': 210,
  'JCM 4面ガラス冷蔵ショーケース（両面扉）JCMS-83W': 120,
  'JCMS-63W 4面ガラス冷蔵ショーケース 前後扉仕様': 130, '携帯充電器': 33
});

const ELECTRICAL_EQUIPMENT_ALIASES = Object.freeze({
  '55インチモニタ': '55インチモニター', '55型モニター': '55インチモニター', '55インチTV': '55インチモニター',
  'LED投光器': '（備品コード1038）LED投光器', 'LEDUP': 'LED UP', 'LED UP': 'LED UP'
});

function ElectricalEquipmentMaster_resolve(name) {
  const raw = String(name || '').trim();
  const canonical = ELECTRICAL_EQUIPMENT_ALIASES[raw] || raw;
  return Object.prototype.hasOwnProperty.call(ELECTRICAL_EQUIPMENT_MASTER, canonical)
    ? { found: true, name: canonical, watts: ELECTRICAL_EQUIPMENT_MASTER[canonical] }
    : { found: false, name: raw, watts: null };
}

if (typeof module !== 'undefined') module.exports = { ELECTRICAL_EQUIPMENT_MASTER, ELECTRICAL_EQUIPMENT_ALIASES, ElectricalEquipmentMaster_resolve };
