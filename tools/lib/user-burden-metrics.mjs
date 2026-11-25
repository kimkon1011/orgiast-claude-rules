import fs from 'node:fs';
import path from 'node:path';
import { entryText, isHumanEntry, transcriptEntries } from './human-turn.mjs';
export const REPEAT_COMPLAINT_PATTERN = /(手間|前に(?:も)?試した|前にも|前回も|さっきも|何回も|何度も|また同じ|同じこと|言ったよね|言ったでしょ|繰り返し)/;
export function sessionBurden(transcriptText) {
  let humanTurns = 0, stopBlocks = 0, repeatComplaints = 0;
  for (const entry of transcriptEntries(transcriptText)) {
    const text = entryText(entry);
    if (isHumanEntry(entry)) { humanTurns++; if (REPEAT_COMPLAINT_PATTERN.test(text)) repeatComplaints++; }
    if ((entry.type === 'attachment' && entry.attachment?.type === 'hook_blocking_error' && entry.attachment?.hookEvent === 'Stop') || (entry.type === 'user' && text.trimStart().startsWith('Stop hook feedback:'))) stopBlocks++;
  }
  return { humanTurns, roundTrips: Math.max(0, humanTurns - 1), stopBlocks, repeatComplaints };
}
export function collectUserBurdenMetrics({ home, days = 7, transcriptPath = '' }) {
  const metrics = { sessions: 0, roundTripsPerObjective: 0, maxRoundTrips: 0, maxRoundTripsSession: '', stopBlocks: 0, stopBlocksPerSession: 0, repeatComplaints: 0, current: null };
  let trips = 0;
  const cutoff = Date.now() - days * 86400000;
  function visit(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'subagents' && !entry.name.startsWith('_deleted-backup')) visit(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        if (fs.statSync(file).mtimeMs < cutoff) continue;
        const burden = sessionBurden(fs.readFileSync(file, 'utf8'));
        if (!burden.humanTurns) continue;
        metrics.sessions++; trips += burden.roundTrips;
        metrics.stopBlocks += burden.stopBlocks; metrics.repeatComplaints += burden.repeatComplaints;
        if (!metrics.maxRoundTripsSession || burden.roundTrips > metrics.maxRoundTrips) { metrics.maxRoundTrips = burden.roundTrips; metrics.maxRoundTripsSession = entry.name.slice(0, -6); }
      } catch { /* 一部のログ破損でも残りを計測する。 */ }
    }
  }
  visit(path.join(home, '.claude', 'projects'));
  if (metrics.sessions) { metrics.roundTripsPerObjective = Number((trips / metrics.sessions).toFixed(1)); metrics.stopBlocksPerSession = Number((metrics.stopBlocks / metrics.sessions).toFixed(1)); }
  if (transcriptPath) try { metrics.current = sessionBurden(fs.readFileSync(transcriptPath, 'utf8')); } catch {}
  return metrics;
}
export function formatUserBurdenLines(metrics, days) {
  const lines = [
    `- 👤 目的あたりの user 往復: **平均 ${metrics.roundTripsPerObjective.toFixed(1)}回**（最大 ${metrics.maxRoundTrips}回: ${metrics.maxRoundTripsSession.slice(0, 8) || 'なし'}）／${days}日 ${metrics.sessions}セッション`,
    `- ⛔ Stop gate 差し戻し: **${metrics.stopBlocks}回**（1セッションあたり ${metrics.stopBlocksPerSession.toFixed(1)}回）— 差し戻しで応答が長くなると user の読む量が増える`,
    `- 🔁 user が同じ指摘を繰り返した回数（手間・前に試した・何回も 等）: **${metrics.repeatComplaints}回**`,
  ];
  if (metrics.current) lines.push(`- 今セッション: 往復 ${metrics.current.roundTrips}回 / 差し戻し ${metrics.current.stopBlocks}回 / 繰り返し指摘 ${metrics.current.repeatComplaints}回`);
  return lines;
}
