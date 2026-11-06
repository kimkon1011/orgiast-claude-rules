// Count each nonempty evidence line once; negative markers take precedence over 完了/達成.
export function checkProgressSummary(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  try {
    const value = JSON.parse(String(text));
    if (typeof value?.summary === 'string' && value.summary.trim()) return value.summary.trim().split(/\r?\n/)[0];
  } catch { /* plain check output */ }
  if (lines[0] && !/^[{\[]|=/.test(lines[0]) && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(lines[0])) return lines[0];
  const unmet = lines.filter(s => /未達|未完|なし|失敗|エラー|停止|不足|未配布|NG|✗|❌|pending|unmet|failed/i.test(s));
  const done = lines.filter(s => !unmet.includes(s) && /達成|完了|済|成功|あり|OK|✅|done|passed/i.test(s));
  const unknown = lines.filter(s => !unmet.includes(s) && !done.includes(s));
  return `達成 ${done.length}件 / 未達 ${unmet.length}件${unknown.length ? ` / 判定不明 ${unknown.length}件` : ''}\n達成: ${done.join(' ／ ').slice(0, 450) || '確認なし'}\n未達: ${unmet.join(' ／ ').slice(0, 650) || '確認なし'}${unknown.length ? `\nその他: ${unknown.join(' ／ ').slice(0, 250)}` : ''}`;
}
