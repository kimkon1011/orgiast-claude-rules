// 2026-10-09 kim 指摘「英語でよくわからない。日本語で」: 最終応答が英語主体になった事故の再発防止。
// コードブロック・インラインコード・URL・リンク先・表の区切りを除いた本文で、英字が日本語文字より多ければ block。
export function japaneseRatio(text) {
  const body = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ');
  const ja = (body.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g) || []).length;
  const latinWords = (body.match(/[A-Za-z]{2,}/g) || []).length;
  return { ja, latinWords };
}

export function judgeJapaneseReply(text) {
  const { ja, latinWords } = japaneseRatio(text);
  // 短い応答や英単語数語は対象外。英単語が多く、日本語文字が英単語数の1.5倍未満なら英語主体と判定。
  if (latinWords < 15) return { decision: 'pass' };
  if (ja >= latinWords * 1.5) return { decision: 'pass' };
  return {
    decision: 'block',
    code: 'JAPANESE-REPLY',
    reason: `[JAPANESE-REPLY] 応答が英語主体です（英単語${latinWords}語・日本語${ja}字）。kim への応答・途中経過・完了報告はすべて日本語で書き直してください（kim 2026-10-09 厳命）。コード・コマンド・固有名詞は英語のままでよい。`
  };
}
