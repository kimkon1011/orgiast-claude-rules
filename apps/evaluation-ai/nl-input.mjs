function ruleBasedParse(text) {
  const entries = [];
  const errors = [];
  for (const original of String(text ?? '').split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    const match = line.match(/^(.+?)(?:さん)?\s*[:：]?\s+(.+)$/);
    if (!match) { errors.push({ line: original, reason: 'スタッフ名と評価を判別できません' }); continue; }
    const staffName = match[1].trim().replace(/さん$/, '');
    const chunks = match[2].split(/[,、，]/).map((part) => part.trim()).filter(Boolean);
    const parsed = [];
    let failed = false;
    for (const chunk of chunks) {
      const scoreMatch = chunk.match(/^(.+?)\s*([1-5])(?:点)?$/);
      if (!scoreMatch) { failed = true; break; }
      parsed.push({ staffName, criterionName: scoreMatch[1].trim(), score: Number(scoreMatch[2]) });
    }
    if (!staffName || !parsed.length || failed) errors.push({ line: original, reason: '評価基準と1〜5の点数を判別できません' });
    else entries.push(...parsed);
  }
  return { entries, errors };
}

export async function parse(text, { aiAdapter } = {}) {
  if (aiAdapter !== undefined) {
    if (typeof aiAdapter !== 'function') return { entries: [], errors: [{ line: String(text), reason: 'AIアダプタが関数ではありません' }] };
    try {
      const result = await aiAdapter(text);
      return { entries: Array.isArray(result?.entries) ? result.entries : [], errors: Array.isArray(result?.errors) ? result.errors : [] };
    } catch (error) {
      return { entries: [], errors: [{ line: String(text), reason: `AI解析に失敗しました: ${error?.message ?? error}` }] };
    }
  }
  return ruleBasedParse(text);
}
