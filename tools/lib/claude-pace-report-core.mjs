import { HUB_ID } from '../portable-knowhow-push.mjs';

/** 通知でも省略しない参照先。Drive 未作成時は共有ハブを案内する。 */
export function reportLocations(date, driveUrl = `https://drive.google.com/drive/folders/${HUB_ID}`) {
  const base = 'https://github.com/kimkon1011/orgiast-claude-rules/blob/main/reports/claude-pace';
  return `## 置き場所\n- JSON: ${base}/${date}.json\n- md: ${base}/${date}.md\n- latest.json: ${base}/latest.json\n- raw（ふわ用）: https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/reports/claude-pace/latest.json\n- Drive（AI共通ノウハウ / claude-pace）: ${driveUrl}\n`;
}
