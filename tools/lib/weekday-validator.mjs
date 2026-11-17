/**
 * 日本語日付表記「YYYY年M月D日（曜日）」の曜日を検証する
 * 社外文面の曜日誤りを送信前に検出するためのバリデータ。
 *
 * @param {string} text - 検証対象のテキスト
 * @returns {{ valid: boolean, mismatches: Array<{ matched: string, date: string, expected: string, actual: string, index: number }> }}
 */
export function validateWeekdays(text) {
  const mismatches = [];

  // 「YYYY年M月D日（曜日）」の正規表現
  const pattern = /(\d{4})年(\d{1,2})月(\d{1,2})日（([日月火水木金土])）/g;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const matched = match[0];
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const declaredWeekday = match[4];

    // 日付文字列を作成（JST 固定）
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const date = new Date(`${dateStr}T00:00:00+09:00`);

    // 無効な日付の場合はスキップ
    if (isNaN(date.getTime())) {
      continue;
    }

    // 実際の曜日を計算
    const actualWeekday = new Intl.DateTimeFormat('ja-JP', {
      weekday: 'short',
      timeZone: 'Asia/Tokyo'
    }).format(date);

    // 不一致をチェック
    if (declaredWeekday !== actualWeekday) {
      mismatches.push({
        matched,
        date: dateStr,
        expected: actualWeekday,
        actual: declaredWeekday,
        index: match.index
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches
  };
}