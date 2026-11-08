import fs from 'node:fs';
import path from 'node:path';

export function affirmativeMarker(prompt, marker) {
  return String(prompt || '').split(/[\r\n。！？]/).some(sentence =>
    sentence.includes(marker) && !/使うな|使わない|使わず|使わなく|使用しない|利用しない|禁止|使用中止|不可|許可しない|承認しない|発行しない|書かない|付けない|don't|do not|never|not allowed/i.test(sentence));
}
function approved(home, sessionId, now, file, markers) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  try {
    const allow = JSON.parse(fs.readFileSync(path.join(home, '.claude', file), 'utf8'));
    const until = Date.parse(allow.until);
    return allow.sessionId === sessionId && markers.includes(allow.marker) && until > now && until <= now + 3600000 ? allow : null;
  } catch { return null; }
}
export function implApproved(home, sessionId, now = Date.now()) {
  return approved(home, sessionId, now, 'claude-impl-allow.json', ['[CLAUDE-IMPL-OK]', '[LANE-OK]']);
}
export function billingApproved(home, sessionId, now = Date.now()) {
  return approved(home, sessionId, now, 'claude-billing-allow.json', ['[API-BILLING-OK]']);
}
export const IMPLEMENTATION_DENIAL = 'Codex が上限中でも node tools/codex-do.mjs は deepseek/glm/gemini へ内蔵フォールバックする。全滅なら実装を止め、kim に費用見込みを提示し、kim がプロンプトに [CLAUDE-IMPL-OK] と書いたときだけ60分許可(§1.18、2026-10-17 kim 厳命)。';
