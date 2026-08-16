// cost-work-loop.mjs — 「作業量に対するコスト」を継続監視し、委譲(安いAIへ逃がす)が実際に効いているかを判定して
// 自己修正の"指示書"を出す閉ループ。放置するとClaude主体に戻り高コスト化するのを防ぐ(kim 2026-08-16)。
//
// 何を測るか(このPCのみ・会話内容は読まない):
//   1) Claude Code のトークン/概算$(直近7日) … ~/.claude/projects/**/*.jsonl の usage だけ
//   2) 安いAI実行者の使用実績 … ~/.claude/executor-usage.jsonl (llm-ask等が追記)
//   3) 作業量プロキシ … 直近7日のgitコミット数(作業ディレクトリ)。無ければ稼働日数。
// 何を判定するか(kimが挙げた2大失敗):
//   A) Claude$高い かつ 委譲率低い → 「委譲できていない(Claude主体)」🚨
//   B) 総額が前回比↑ なのに 作業量↑でない → 「逃がしたのに高コスト(誤ルーティング/やり直し/呼びすぎ)」🚨
// 出力: ~/.claude/cost-directive.md (SessionStartで毎回私が読む=修正が行動に反映) + 任意でDiscord。
//   実行: node cost-work-loop.mjs [--post] [--days 7]
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { execSync } from 'node:child_process';
const HOME = os.homedir();
const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1] || '7', 10) || 7;
const POST = process.argv.includes('--post');
const since = Date.now() - DAYS * 864e5;
// 概算単価($/1M tok) — 傾向把握用の粗い値
const PRICE = { opus: [5, 25], sonnet: [3, 15], haiku: [0.8, 4], default: [3, 15] };
function tier(m) { m = (m || '').toLowerCase(); if (m.includes('opus')) return 'opus'; if (m.includes('haiku')) return 'haiku'; if (m.includes('sonnet')) return 'sonnet'; return 'default'; }

// ---- 1) Claude Code トークン/$ ----
function walk(dir, out) { let e = []; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const d of e) { const p = path.join(dir, d.name); if (d.isDirectory()) walk(p, out); else if (d.name.endsWith('.jsonl')) out.push(p); } }
let claudeOut = 0, claudeUSD = 0, claudeByModel = {};
{
  const files = []; walk(path.join(HOME, '.claude', 'projects'), files);
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; } if (st.mtimeMs < since) continue;
    let lines = []; try { lines = fs.readFileSync(f, 'utf-8').split('\n'); } catch { continue; }
    for (const ln of lines) {
      if (!ln.includes('"usage"')) continue;
      let j; try { j = JSON.parse(ln); } catch { continue; }
      // 行ごとのtimestampで期間を絞る(ファイルmtimeだと長寿命セッションの全履歴を誤集計する)
      const ts = j?.timestamp ? new Date(j.timestamp).getTime() : 0; if (ts && ts < since) continue;
      const u = j?.message?.usage; const model = j?.message?.model; if (!u) continue;
      // 正しいキャッシュ単価: 通常入力=1x / キャッシュ書込=1.25x / キャッシュ読取=0.1x / 出力=出力単価
      const baseIn = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
      const outT = u.output_tokens || 0; const t = tier(model);
      const [pi, po] = PRICE[t]; claudeUSD += (baseIn * pi + cc * pi * 1.25 + cr * pi * 0.1 + outT * po) / 1e6; claudeOut += outT;
      claudeByModel[t] = (claudeByModel[t] || 0) + outT;
    }
  }
}
// ---- 2) 安いAI実行者 台帳 ----
let execOut = 0, execUSD = 0, execByProv = {};
{
  const led = path.join(HOME, '.claude', 'executor-usage.jsonl');
  let lines = []; try { lines = fs.readFileSync(led, 'utf-8').split('\n'); } catch { }
  const EP = { groq: [0.6, 0.8], openrouter: [0.3, 0.6], gemini: [0.1, 0.4], kimi: [3, 15], mistral: [2, 6], deepseek: [0.27, 1.1], grok: [3, 15], ollama: [0, 0] };
  for (const ln of lines) { if (!ln.trim()) continue; let r; try { r = JSON.parse(ln); } catch { continue; } if (new Date(r.t).getTime() < since) continue; const [pi, po] = EP[r.provider] || [1, 3]; execUSD += ((r.in || 0) * pi + (r.out || 0) * po) / 1e6; execOut += (r.out || 0); execByProv[r.provider] = (execByProv[r.provider] || 0) + 1; }
}
// ---- 3) 作業量プロキシ(gitコミット) ----
let work = 0, workKind = 'commits';
try {
  const dirs = (process.env.COST_WORK_REPOS || '').split(path.delimiter).filter(Boolean);
  const scan = dirs.length ? dirs : [process.cwd()];
  for (const d of scan) { try { const n = execSync(`git -C "${d}" log --since="${DAYS} days ago" --oneline`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); work += n ? n.split('\n').length : 0; } catch { } }
} catch { }
if (work === 0) { workKind = 'sessions(代替)'; try { const files = []; walk(path.join(HOME, '.claude', 'projects'), files); const days = new Set(); for (const f of files) { const st = fs.statSync(f); if (st.mtimeMs >= since) days.add(new Date(st.mtimeMs).toDateString()); } work = days.size; } catch { } }

// ---- 判定 ----
const totalUSD = claudeUSD + execUSD;
const delegRatio = (execOut + claudeOut) > 0 ? execOut / (execOut + claudeOut) : 0;
const costPerWork = totalUSD / Math.max(work, 1);
// 前回スナップショットで傾向
const stateF = path.join(HOME, '.claude', 'cost-loop-state.json');
let prev = null; try { prev = JSON.parse(fs.readFileSync(stateF, 'utf-8')); } catch { }
const flags = [];
const TARGET_DELEG = 0.30;
if (claudeUSD >= 30 && delegRatio < TARGET_DELEG) flags.push(`🚨 委譲不足: Claude$${claudeUSD.toFixed(0)}なのに委譲率${(delegRatio * 100).toFixed(0)}%(目標${TARGET_DELEG * 100}%↑)。実装→Codex/量産→Groq/汎用安→OpenRouter へ回す`);
if (prev && totalUSD > prev.totalUSD * 1.15 && work <= prev.work) flags.push(`🚨 コスト効率悪化: 総額 $${prev.totalUSD.toFixed(0)}→$${totalUSD.toFixed(0)} 増だが作業量(${workKind}) ${prev.work}→${work} 増えず。誤ルーティング/やり直し/呼びすぎを点検`);
if (claudeByModel.opus && claudeOut && (claudeByModel.opus / claudeOut) > 0.5) flags.push(`⚠️ Opus比率高(${((claudeByModel.opus / claudeOut) * 100).toFixed(0)}%)。監督は最小限に、実装/生成は委譲(§1.18)`);
if (!flags.length) flags.push('✅ 委譲・コスト効率は許容範囲。この調子で。');

const arrow = prev ? (totalUSD > prev.totalUSD ? '↑' : totalUSD < prev.totalUSD ? '↓' : '→') : '';
const execLine = Object.keys(execByProv).length ? Object.entries(execByProv).map(([k, v]) => `${k}:${v}回`).join(' / ') : '(なし=安いAI未使用)';
const md = `<!-- COST-DIRECTIVE-START -->
## 💰 コスト×作業量 ループ (直近${DAYS}日 / このPC)
- Claude概算: **$${claudeUSD.toFixed(1)}** (out ${(claudeOut / 1000).toFixed(0)}k tok, ${Object.entries(claudeByModel).map(([k, v]) => k + ' ' + (v / 1000).toFixed(0) + 'k').join('/')})
- 安いAI実行者: **$${execUSD.toFixed(2)}** — ${execLine}
- 総額: **$${totalUSD.toFixed(1)}** ${arrow} / 作業量(${workKind}): ${work} / **作業あたり $${costPerWork.toFixed(2)}**
- 委譲率(安いAIへ逃がせた割合): **${(delegRatio * 100).toFixed(0)}%**
### 指示
${flags.map(f => '- ' + f).join('\n')}
<!-- COST-DIRECTIVE-END -->
`;
fs.writeFileSync(path.join(HOME, '.claude', 'cost-directive.md'), md);
fs.writeFileSync(stateF, JSON.stringify({ t: new Date().toISOString(), totalUSD, claudeUSD, execUSD, work, delegRatio }));
console.log(md);

if (POST) {
  const wh = (() => { try { for (const l of fs.readFileSync(path.join(HOME, '.claude', 'cost-reporter.env'), 'utf-8').split(/\r?\n/)) if (l.startsWith('COST_WEBHOOK=') || l.startsWith('DISCORD_COST_WEBHOOK=')) return l.split('=').slice(1).join('=').trim(); } catch { } return process.env.COST_WEBHOOK || ''; })();
  if (wh) { const label = process.env.REPORTER_LABEL || os.hostname(); try { await fetch(wh, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${label}** コスト×作業量ループ\n${md.replace(/<!--.*?-->/g, '').trim()}` }) }); console.error('Discord送信OK'); } catch (e) { console.error('Discord送信失敗:', e.message); } }
  else console.error('COST_WEBHOOK未設定=送信スキップ');
}
