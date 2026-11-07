// 各PCの AI レーン健全性を kim-PC に集めるための純関数群（送信側 fleet-mail.mjs と集計側 fleet-lane-health-report.mjs が共有）。
// 2026-10-15 事故: nishi@/cr@ のPCで Codex が使えず deepseek へ無言退避し続け、誰も気づかなかった。
import { createHash } from 'node:crypto';

export const LANE_HEALTH_TAG = '[lane-health]';
export const LANE_HEALTH_KIM_PC = 'kim-PC';
const SKIP_REASONS = /^(?:missing_key|cli_missing)$/;

// 1行の JSON（lane-doctor --json の出力）から最後の JSON を取り出す。
export function parseLaneDoctorOutput(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { const value = JSON.parse(lines[i]); if (value && typeof value === 'object' && value.lanes) return value; } catch {}
  }
  return null;
}

// dead 判定。codex は常に対象、他レーンは未設定(missing_key)/CLI無し以外の停止だけを対象にする。
export function deadLanes(health) {
  const out = [];
  for (const [lane, state] of Object.entries(health?.lanes ?? {})) {
    if (lane === 'gemini-cli' || state?.alive !== false) continue;
    if (lane !== 'codex' && SKIP_REASONS.test(String(state.reason ?? ''))) continue;
    out.push({ lane, reason: String(state.reason || 'unknown'), ...(state.error ? { error: String(state.error).slice(-300) } : {}) });
  }
  return out;
}

// 推奨対処。fixNow=true は fleet-fix-now.ps1 -NoLogin で受信側PC自身が直せる試行、human は人の操作が要る理由。
export function repairAdvice(lane, reason) {
  const r = String(reason ?? '');
  if (/payment_required/.test(r)) return { fixNow: false, auto: false, human: '請求設定を開き支払い方法を確認しオートチャージ ON を保存する（Claude からは決済できない）' };
  if (/physical_operation/.test(r)) return { fixNow: false, auto: false, human: '管理者 PowerShell で wsl.exe --install --no-distribution を実行して Windows を再起動する（管理者権限が必要）' };
  if (/^cooldown|demoted/.test(r)) return { fixNow: false, auto: true, human: null, note: '利用上限のクールダウン中。期限が来れば自動復帰する' };
  if (lane === 'codex') {
    if (/oauth_consent|login|not_logged|unauthorized|auth/i.test(r)) return { fixNow: true, auto: false, human: 'Codex の OAuth 同意が必要。そのPCで担当アカウントの ChatGPT にブラウザーでログインして許可する' };
    if (/plan.?free|free/i.test(r)) return { fixNow: true, auto: false, human: 'ChatGPT が free プラン。有料プラン契約のアカウントでログインし直す' };
    if (/wsl|native|read_only|probe_failed|stale/i.test(r)) return { fixNow: true, auto: true, human: null, note: 'WSL 不在・probe 失敗は fleet-fix-now（native 切替・再 probe）で自動修復を試行' };
    return { fixNow: true, auto: false, human: '原因未分類。fleet-fix-now を試行したうえで lane-doctor --probe の結果を確認する' };
  }
  if (/auth_invalid/.test(r)) return { fixNow: false, auto: false, human: `${lane} の API キーが無効。キーを更新する` };
  // 2026-10-23: 回線の一時断で HTTP レーン4本が同時に probe_failed:stale となり、人の操作として DM された。次回 probe で自動再判定する。
  if (/^probe_failed(?::stale)?$/.test(r)) return { fixNow: false, auto: true, silent: true, human: null, note: '一時的な probe 失敗。次回 lane-doctor --probe で自動再判定する' };
  return { fixNow: false, auto: false, human: '原因未分類。lane-doctor --probe の結果を確認する' };
}

export function laneHealthSignature(pc, dead) {
  return createHash('sha256').update(`${pc}\n${dead.map(d => `${d.lane}:${d.reason}`).sort().join('|')}`).digest('hex').slice(0, 16);
}

// 送信本文は機械可読の JSON 1個。why は人が一覧で読む1行。
export function buildLaneHealthMail({ pc, dead, autoFix = 'none', recovered = false, at }) {
  const why = recovered
    ? `${LANE_HEALTH_TAG} ${pc} recovered: 全レーン復旧`
    : `${LANE_HEALTH_TAG} ${pc} ${dead.map(d => `${d.lane} dead: ${d.reason}`).join(' / ')}`.slice(0, 200);
  const body = JSON.stringify({ kind: 'lane-health', pc, recovered, at, autoFix, dead });
  return { why, body };
}

export function parseLaneHealthMail(mail) {
  if (!String(mail?.why ?? '').startsWith(LANE_HEALTH_TAG)) return null;
  try {
    const data = JSON.parse(String(mail.body ?? '').replace(/^<!--[\s\S]*?-->\s*/g, '').trim());
    if (data?.kind !== 'lane-health' || typeof data.pc !== 'string') return null;
    return { pc: data.pc, recovered: !!data.recovered, at: data.at || mail.createdAt, autoFix: data.autoFix || 'none', dead: Array.isArray(data.dead) ? data.dead : [], mailId: mail.id };
  } catch { return null; }
}

// 各PCの最新報告だけを採る。recovered は dead 無し扱い。
export function latestByPc(reports) {
  const map = new Map();
  for (const report of reports) {
    const prev = map.get(report.pc);
    if (!prev || String(report.at) >= String(prev.at)) map.set(report.pc, report);
  }
  return [...map.values()];
}

export function laneHealthRows(reports, { account = () => '' } = {}) {
  const rows = [];
  for (const report of latestByPc(reports)) {
    for (const d of report.dead) {
      const advice = repairAdvice(d.lane, d.reason);
      const fixed = advice.auto ? `自動修復${report.autoFix === 'launched' ? '済み（fix-now 起動）' : 'を試行'}: ${advice.note}（人の操作は不要）` : null;
      rows.push({
        pc: report.pc, lane: d.lane, state: 'dead', reason: d.reason, at: report.at,
        action: fixed || `人の操作が要る: ${advice.human}`,
        auto: !!advice.auto, silent: !!advice.silent, human: advice.human, fixNow: advice.fixNow, account: account(report.pc),
        key: `${report.pc}|${d.lane}|${d.reason}`,
      });
    }
  }
  return rows;
}

export function renderLaneHealthTable(rows) {
  if (!rows.length) return '全PCのAIレーンは正常です（dead 報告なし）';
  const esc = s => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
  const head = '| PC | レーン | 状態 | 理由 | 推奨対処 |\n|---|---|---|---|---|';
  return [head, ...rows.map(r => `| ${esc(r.pc)} | ${esc(r.lane)} | ${esc(r.state)} | ${esc(r.reason)} | ${esc(r.action)} |`)].join('\n');
}

// kim への DM 文。どのPCで・どのアカウントで・何をするかを書く（人の操作が要る行だけ）。
export function laneHealthDm(row) {
  if (row.auto) return `${row.pc} の ${row.lane} が停止（${row.reason}）。自動修復を試行中で、あなたの操作は不要です。`;
  const who = row.account ? `${row.account} のアカウントで` : '担当アカウントで';
  return `${row.pc} の ${row.lane} が停止しています（${row.reason}）。${row.pc} に接続し、${who}次を行ってください: ${row.human}`;
}
