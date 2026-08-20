const FLEET_SHEET_ID_ = '14B_vaAr-WrHMsVTpR4hzN62__JhfbylJvcfEhtfukn4';

// 初回の準備はこの関数だけを実行する。
function setupOnce() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', FLEET_SHEET_ID_);
  if (!props.getProperty('FLEET_TOKEN')) {
    props.setProperty('FLEET_TOKEN', Utilities.getUuid() + Utilities.getUuid());
  }
  installCommandQueue();

  // テスト行は作らず、対象シートと必須ヘッダを読み戻して接続だけを確認する。
  const sheet = _fleetSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  fleetResolveColumns(headers);
  console.log('fleet status sheet read-back OK; command queue installed');
}
