// 自動で動く Claude（スケジュール実行・巡回・ヘッドレス claude -p・自動セッション）のモデル。
// 2026-11-17 kim 指示: 自動実行は Opus、基本軽い定型作業だけ Sonnet/Haiku、fable は自動化では Opus に倒す。
// ORGIAST_AUTOMATION_MODEL で haiku 等へ下げることはできるが、opus/fable へは上げられない。
const SUPERVISOR = /opus|fable/i;
export function automationModel(requested, env = process.env) {
  const configured = String(env.ORGIAST_AUTOMATION_MODEL || '').trim();
  const fallback = configured && !SUPERVISOR.test(configured) ? configured : 'opus';
  const value = String(requested || '').trim();
  return !value || SUPERVISOR.test(value) ? fallback : value;
}
