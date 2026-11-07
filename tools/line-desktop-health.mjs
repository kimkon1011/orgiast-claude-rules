import fs from 'node:fs';
export const DESKTOP_CHATS = ['生成AI', 'AI研究所', '仕事効率化', 'レンスペ民の集い'];
export function readJsonLines(file) {
  if (!file) return [];
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return text.split(/\r?\n/u).flatMap(line => { try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; } catch { return []; } });
}
export function desktopProblems({ runs, attempts = [], events = [], now = Date.now() }) {
  const validRuns = runs.filter(r => Date.parse(r.finishedAt || r.startedAt) <= now);
  const latest = Math.max(0, ...validRuns.filter(r => ['completed', 'success'].includes(r.status) &&
    DESKTOP_CHATS.every(name => r.chats?.some(c => c.chat === name && c.status === 'imported')))
    .map(r => Date.parse(r.finishedAt || r.startedAt)));
  const problems = [];
  if (!latest || now - latest > 36 * 3600_000) {
    const since = Math.max(latest, now - 36 * 3600_000), reasons = new Map();
    const add = reason => { if (reason) { const key = reason.replace(/^skip:/u, ''); reasons.set(key, (reasons.get(key) || 0) + 1); } };
    for (const r of validRuns.filter(r => Date.parse(r.finishedAt || r.startedAt) >= since)) {
      add(r.reason);
      for (const c of r.chats || []) {
        if (c.status === 'imported' || !c.reason) continue;
        // Attempts are more precise; only fall back to run details when absent.
        if (!attempts.some(a => a.chat === c.chat && Date.parse(a.at) >= Date.parse(r.startedAt) && Date.parse(a.at) <= Date.parse(r.finishedAt || r.startedAt))) add(c.reason);
      }
    }
    for (const a of attempts.filter(a => Date.parse(a.at) >= since && Date.parse(a.at) <= now)) add(a.reason);
    problems.push({ key: 'desktop-stale', detail: `PC経路: ${latest ? `全チャット成功から${Math.floor((now-latest)/3600_000)}時間` : '全チャット成功の記録なし'}。直近36時間: ${[...reasons].map(([k,v]) => `${k} ${v}回`).join(' / ') || '失敗理由の記録なし'}` });
  }
  const byChat = new Map();
  for (const event of events.filter(e => e.source === 'desktop' && ['export-stored','export-empty'].includes(e.kind) && Number(e.ts) <= now).sort((a,b) => a.ts-b.ts)) {
    const group = byChat.get(event.chat || '(unknown)') || [];
    group.push(event); byChat.set(event.chat || '(unknown)', group);
  }
  const metrics = e => {
    const unresolved = Number(e.unresolvedSender ?? e.stats?.unresolvedSender ?? 0);
    const messages = Number(e.messages ?? e.stats?.parsed ?? (Number(e.stored || 0) + Number(e.duplicates || 0) + Number(e.outOfRange || 0)));
    return { messages, ratio: unresolved / Math.max(1, messages + unresolved) };
  };
  for (const [chat, group] of byChat) {
    for (let index = 0; index < group.length; index++) {
    const e = group[index];
    if (now - e.ts > 36 * 3600_000) continue;
    const m = metrics(e), previous = group.slice(Math.max(0, index - 7), index);
    const average = previous.reduce((sum, p) => sum + metrics(p).ratio, 0) / previous.length;
    const empty = Number(e.dateLinesFound ?? e.stats?.dateLinesFound) > 0 && m.messages === 0;
    const spike = previous.length === 7 && m.ratio > .3 && m.ratio > 2 * average;
    if (empty || spike) problems.push({ key: `desktop-format:${chat}`, detail: `PC形式異常 ${chat}: ${empty ? '日付行あり・messages=0' : `unresolvedSender ${Math.round(m.ratio*100)}%（直近7回平均${Math.round(average*100)}%）`}。検体: ${e.specimenPath || '旧ログにパスなし（inbox/rejected・processedを参照）'}` });
    }
  }
  return [...new Map(problems.map(p => [p.key, p])).values()];
}

export function desktopStartupProblems({ runs, task = {}, now = Date.now() }) {
  const date = new Date(now);
  if (date.getHours() * 60 + date.getMinutes() < 150) return [];
  const latest = Math.max(0, ...[task.lastRunTime, ...runs.map(r => r.startedAt)]
    .map(t => Date.parse(t)).filter(t => Number.isFinite(t) && t <= now));
  if (latest && now - latest < 3 * 3600_000) return [];
  return [{ key: 'desktop-not-starting', detail: `ClaudeMobile-LineDesktopExport: ${latest ? `最終起動 ${new Date(latest).toISOString()}` : '起動記録なし'} / RunOnlyIfIdle=${task.runOnlyIfIdle ?? 'unknown'} / Enabled=${task.enabled ?? 'unknown'} / 状態=${task.state ?? 'unknown'}` }];
}
export function localDate(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function desktopDailyReport({ runs, events = [], now = Date.now(), problems = [] }) {
  const today = localDate(now), counts = { completed: 0, partial: 0, skipped: 0, failed: 0 }, reasons = new Map();
  const addReason = reason => { if (reason) reasons.set(reason, (reasons.get(reason) || 0) + 1); };
  for (const r of runs.filter(r => Date.parse(r.startedAt) <= now && localDate(Date.parse(r.startedAt)) === today)) {
    const status = r.status === 'success' ? 'completed' : r.status;
    if (status in counts) counts[status]++;
    if (status === 'skipped') addReason(r.reason || 'unknown');
    for (const c of r.chats || []) if (c.status === 'skipped') addReason(`${c.chat}: ${c.reason || 'unknown'}`);
  }
  const chats = new Map(DESKTOP_CHATS.map(c => [c, { stored: 0, duplicates: 0, unresolvedSender: 0 }]));
  for (const e of events.filter(e => e.source === 'desktop' && ['export-stored','export-empty'].includes(e.kind) && Number(e.ts) <= now && localDate(Number(e.ts)) === today)) {
    const total = chats.get(e.chat) || { stored: 0, duplicates: 0, unresolvedSender: 0 };
    for (const k of Object.keys(total)) total[k] += Number(e[k] ?? e.stats?.[k] ?? 0) || 0;
    chats.set(e.chat || '(unknown)', total);
  }
  const latest = Math.max(0, ...runs.filter(r => ['completed','success'].includes(r.status) && DESKTOP_CHATS.every(chat => r.chats?.some(c => c.chat === chat && c.status === 'imported'))).map(r => Date.parse(r.finishedAt || r.startedAt)).filter(t => t <= now));
  const stored = [...chats.values()].reduce((n,c) => n+c.stored,0);
  return `${stored ? '' : '⚠️ '}LINE日次進捗 ${today}\n実行: ${Object.entries(counts).map(([k,v]) => `${k} ${v}`).join(' / ')}\nskip理由: ${[...reasons].map(([k,v]) => `${k} ${v}回`).join(' / ') || 'なし'}\n${[...chats].map(([chat,c]) => `${chat}: 新規${c.stored} / 重複${c.duplicates} / 未確定${c.unresolvedSender}`).join('\n')}\n最終成功: ${latest ? new Date(latest).toLocaleString('ja-JP', { hour12: false }) : '記録なし'}\n毎時監視: ${problems.length ? `異常あり（${problems.map(p => p.key).join(', ')}）` : '異常なし'}`;
}
