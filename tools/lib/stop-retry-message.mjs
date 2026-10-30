export const STOP_RETRY_INSTRUCTION = '前のメッセージの経緯・ログ・説明は繰り返さない。指摘分を直したうえで、この書き直しが kim の読む最後のメッセージになる前提で書く: 末尾3行の直前に【最終まとめ】を置き、①報告（結論・結果・検証）②kim の確認事項（文面・選択肢・URL は全文）③kim がやること をすべて載せ、前のメッセージを参照させない（「上記」「前述」禁止）。';

export function withStopRetryInstruction(reason) {
  return `${STOP_RETRY_INSTRUCTION}\n\n${reason}`;
}
