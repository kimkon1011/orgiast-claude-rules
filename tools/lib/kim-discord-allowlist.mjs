// kim 宛 Bot DM の例外は notify-kim 内の autoreply-decision / autoreply-sent のみ（2026-11-12）。
// この汎用許可リストや MCP 直接送信ゲートは緩めない。
// このファイルは後方互換のために残すが、discordAllowed は常に false を返す。

export function loadAllowlist(_options = {}) {
  return [];
}

export function discordAllowed(_text, _options = {}) {
  return { allowed: false, category: null };
}
