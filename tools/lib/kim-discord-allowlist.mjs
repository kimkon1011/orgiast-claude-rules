// kim 宛 Discord DM 全廃（2026-10-27 / 2026-11-10 kim 再指示）。許可リストを復活させない。
// このファイルは後方互換のために残すが、discordAllowed は常に false を返す。

export function loadAllowlist(_options = {}) {
  return [];
}

export function discordAllowed(_text, _options = {}) {
  return { allowed: false, category: null };
}
