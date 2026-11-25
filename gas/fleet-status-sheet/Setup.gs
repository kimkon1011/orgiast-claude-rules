const FLEET_SHEET_ID_ = '14B_vaAr-WrHMsVTpR4hzN62__JhfbylJvcfEhtfukn4';

// 初回の準備はこの関数だけを実行する。
function setupOnce() {
  const props = PropertiesService.getScriptProperties();
  // 統合後に旧 ID へ戻すと全 PC の夜間報告が旧シートへ逆流するため、設定済みの ID は維持する。
  if (!props.getProperty('SHEET_ID')) {
    props.setProperty('SHEET_ID', props.getProperty('CLOUD_LEDGER_SHEET_ID') || FLEET_SHEET_ID_);
  }
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
