#!/usr/bin/env node
// Claude Code セッションの「モデル」と「kim の返事待ちで停止」を機械的に点検する軽いチェック（2026-11-15 kim 指示）。
// 背景: 既定を Sonnet にすると決めても Opus のまま動き、取り消せる対策を並べて「一言返して」と止まる事故が繰り返された。
// 使い方: node tools/session-model-audit.mjs [--hours 6] [--idle-min 15] [--json]
// 出力1行目: SESSION-AUDIT host=<PC> status=OK|NG settings_model=<値> target=<既定> scanned=<件> opus=<件> waiting=<件>
// 2行目以降: NG SETTINGS / NG OPUS / NG WAITING / INFO WAIT_HUMAN（人にしかできない待ちは異常にしない）
// 終了コード: 0=正常 1=異常あり 2=点検自体の失敗。読むのは ~/.claude/settings.json と ~/.claude/projects/*/*.jsonl だけで、何も書き換えない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const SUPERVISOR = /opus|fable/i;
const HANDOFF_EMPTY = /^(?:なし|ありません|特に(?:なし|ありません)|不要)/;
// 人にしかできない操作（社外送信・支払い・削除・権限/課金・サインイン等）の待ちは正当な待ちとして INFO に留める。
const HUMAN_ONLY = /トークン|再発行|再認証|OAuth|認可|送信|送って|支払|決済|購入|削除|権限|課金|契約|ログイン|サインイン|再ログイン|2FA|OTP|パスワード|同意|ダブルクリック|押して|押す|スマホ|電話/;
// 取り消せる作業を kim に選ばせて止まる言い回し。
const ASKS_REVERSIBLE = /どの対策を進める|どれを進め|どれを選|進めてよい(?:か|です)|進めますか|一言(?:返|くだ|ください)|と一言|「対策を進めて」|「進めて」と|(?:すべて|全部)元に戻せます/;

export function targetModel(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'model-default.json'), 'utf8'));
    if (raw && typeof raw.model === 'string' && raw.model.trim()) return raw.model.trim();
  } catch {}
  return 'sonnet';
}

export function settingsModelProblem(model, target) {
  const value = String(model ?? '').trim();
  if (SUPERVISOR.test(target)) return null; // PC 単位で上位モデルを明示した場合は点検しない
  if (!value) return '未設定（Claude Code の既定=Opus）';
  if (SUPERVISOR.test(value)) return value;
  return null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
}

function isHookFeedback(text) {
  return /^(?:Stop hook feedback|<command-|Caveat:|\[Request interrupted)/.test(String(text).trim());
}

export function analyzeSession(lines) {
  const out = { title: '', entrypoint: '', lastModel: '', lastActivity: '', models: {}, lastAssistantText: '', lastAssistantAt: '', endsWithAssistantText: false };
  let last = null;
  for (const line of lines) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && o.customTitle) out.title = o.customTitle;
    else if (o.type === 'ai-title' && o.aiTitle && !out.title) out.title = o.aiTitle;
    else if (o.type === 'summary' && o.summary && !out.title) out.title = o.summary;
    if (o.entrypoint) out.entrypoint = o.entrypoint;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.timestamp) out.lastActivity = o.timestamp;
    const content = o.message?.content;
    if (o.type === 'assistant') {
      const model = o.message?.model;
      if (model && model !== '<synthetic>') { out.lastModel = model; out.models[model] = (out.models[model] || 0) + 1; }
      const text = textOf(content);
      const hasTool = Array.isArray(content) && content.some((p) => p?.type === 'tool_use');
      if (text.trim()) { out.lastAssistantText = text; out.lastAssistantAt = o.timestamp || ''; }
      last = { kind: hasTool ? 'tool' : (text.trim() ? 'assistant-text' : 'assistant-other') };
    } else {
      const text = textOf(content);
      const toolResult = Array.isArray(content) && content.some((p) => p?.type === 'tool_result');
      if (toolResult) last = { kind: 'tool-result' };
      else if (text.trim() && !isHookFeedback(text)) { last = { kind: 'user' }; out.lastAssistantText = ''; }
      else last = { kind: 'hook' };
    }
  }
  out.endsWithAssistantText = last?.kind === 'assistant-text';
  return out;
}

export function waitingVerdict(text) {
  const body = String(text || '');
  const m = body.match(/次に\s*kim\s*が(?:すること|やること)\s*[:：]\s*([^\n]*)/);
  const kimLine = m ? m[1].trim() : '';
  const handoff = kimLine && !HANDOFF_EMPTY.test(kimLine);
  const asks = ASKS_REVERSIBLE.test(body);
  if (!handoff && !asks) return null;
  const subject = kimLine || (body.match(ASKS_REVERSIBLE) || [''])[0];
  if (handoff && HUMAN_ONLY.test(kimLine) && !ASKS_REVERSIBLE.test(kimLine)) return { kind: 'WAIT_HUMAN', kimLine: subject };
  return { kind: 'WAITING', kimLine: subject };
}

function jst(iso) {
  if (!iso) return '-';
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} JST`;
}

export function audit({ home = process.env.ORGIAST_HOME || os.homedir(), hours = 6, idleMin = 15, now = Date.now() } = {}) {
  const claude = path.join(home, '.claude');
  let settingsModel = '';
  try { settingsModel = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')).model || ''; } catch {}
  const target = targetModel(home);
  const findings = [];
  const settingsProblem = settingsModelProblem(settingsModel, target);
  if (settingsProblem) findings.push({ level: 'NG', kind: 'SETTINGS', detail: `model=${settingsProblem} (既定 ${target} にする)` });
  const since = now - hours * 3600e3;
  const projects = path.join(claude, 'projects');
  let scanned = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(projects, dir.name), { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(projects, dir.name, f.name);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      scanned += 1;
      let info;
      try { info = analyzeSession(fs.readFileSync(file, 'utf8').split('\n')); } catch { continue; }
      const id = f.name.replace(/\.jsonl$/, '').slice(0, 8);
      const base = { session: id, title: info.title.slice(0, 40), entrypoint: info.entrypoint || '-', model: info.lastModel || '-', last: jst(info.lastActivity) };
      if (info.title.includes('【閉じて可】')) continue;
      const activeInWindow = info.lastActivity && Date.parse(info.lastActivity) >= since;
      if (activeInWindow && info.lastModel && SUPERVISOR.test(info.lastModel) && !SUPERVISOR.test(target)) findings.push({ level: 'NG', kind: 'OPUS', ...base });
      if (info.endsWithAssistantText && info.lastAssistantAt) {
        const idle = Math.round((now - Date.parse(info.lastAssistantAt)) / 60000);
        const verdict = idle >= idleMin ? waitingVerdict(info.lastAssistantText) : null;
        if (verdict) findings.push({ level: verdict.kind === 'WAITING' ? 'NG' : 'INFO', kind: verdict.kind, ...base, idleMin: idle, kimLine: verdict.kimLine.slice(0, 80) });
      }
    }
  }
  const ng = findings.filter((x) => x.level === 'NG');
  return {
    host: os.hostname(), status: ng.length ? 'NG' : 'OK', settingsModel: settingsModel || '未設定', target, scanned,
    opus: findings.filter((x) => x.kind === 'OPUS').length, waiting: findings.filter((x) => x.kind === 'WAITING').length, findings,
  };
}

export function format(r) {
  const lines = [`SESSION-AUDIT host=${r.host} status=${r.status} settings_model=${r.settingsModel} target=${r.target} scanned=${r.scanned} opus=${r.opus} waiting=${r.waiting}`];
  for (const f of r.findings) {
    if (f.kind === 'SETTINGS') { lines.push(`${f.level} SETTINGS ${f.detail}`); continue; }
    const extra = f.kind === 'OPUS' ? `model=${f.model}` : `idle=${f.idleMin}m kim="${f.kimLine}"`;
    lines.push(`${f.level} ${f.kind} ${f.session} 「${f.title}」 ${extra} last=${f.last} entry=${f.entrypoint}`);
  }
  return lines.join('\n');
}

if (isEntry(import.meta.url)) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) : dflt; };
  try {
    const r = audit({ hours: arg('--hours', 6), idleMin: arg('--idle-min', 15) });
    console.log(process.argv.includes('--json') ? JSON.stringify(r) : format(r));
    process.exitCode = r.status === 'OK' ? 0 : 1;
  } catch (e) {
    console.log(`SESSION-AUDIT host=${os.hostname()} status=ERROR ${e.message}`);
    process.exitCode = 2;
  }
}
