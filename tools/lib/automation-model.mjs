// 自動で動く Claude（スケジュール実行・巡回・ヘッドレス claude -p・自動セッション）のモデル。
// 2026-11-17 kim 指示: 基本は Opus。/session-close・記録の追記だけの締め、定型の確認・一覧化・整形・転記だけ Sonnet。迷ったら Opus。
// 2026-11-15 の「自動実行は Sonnet、Opus/Fable 指定も Sonnet に倒す」は廃止。
// ORGIAST_AUTOMATION_MODEL で上書き可。軽い作業の sonnet/haiku 指定はそのまま使う。fable は自動化では opus に倒す。
const FABLE = /fable/i;
const LIGHT = /sonnet|haiku/i;
export function automationModel(requested, env = process.env) {
  const configured = String(env.ORGIAST_AUTOMATION_MODEL || '').trim();
  const fallback = configured && !FABLE.test(configured) ? configured : 'opus';
  const value = String(requested || '').trim();
  if (value && LIGHT.test(value)) return value;
  if (value && !FABLE.test(value)) return value;
  return fallback;
}
