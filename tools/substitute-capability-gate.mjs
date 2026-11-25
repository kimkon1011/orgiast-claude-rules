export const GATE_CONTRACT = {"name":"substitute-capability-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"substitute-capability-gate"}]};
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catalog, providerAliases } from './provider-catalog.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { isEntry } from './is-entry.mjs';

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function history(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
}
function mentions(text, service) {
  return providerAliases(service).some(alias => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(text);
  });
}
export function judgeSubstituteCapability(text, { home = process.env.ORGIAST_HOME || os.homedir(), services = catalog, now = Date.now() } = {}) {
  const prose = String(text || '').replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g, '').replace(/^[ \t]*>.*$/gm, '');
  if (prose.includes('[SUBSTITUTE-OK]')) return { decision: 'pass' };
  const requests = prose.split(/[。！？\r\n]+/).filter(sentence =>
    /(?:入金|チャージ|クレジット\s*を追加|課金|残高\s*を足す|ログイン|OAuth\s*の?\s*許可)/i.test(sentence)
    && /ください|下さい|お願い|必要|してほしい|頼み|しましょう|すること[:：]/.test(sentence));
  const providers = services.filter(service => requests.some(sentence => mentions(sentence, service)));
  if (!providers.length) return { decision: 'pass' };
  const cap = /画像|image|写真|イラスト/i.test(prose) ? 'image'
    : /実装|コード|codex|\bPR\b|テスト/i.test(prose) ? 'code'
    : /調査|検索|research/i.test(prose) ? 'research' : 'chat';
  const dir = path.join(home, '.claude');
  const lanes = readJson(path.join(dir, 'lane-health.json'), {}).lanes || {};
  const limits = history(path.join(dir, 'provider-limit-history.jsonl'));
  const alive = service => {
    const aliases = providerAliases(service).map(value => value.toLowerCase());
    if (Object.entries(lanes).some(([id, lane]) => aliases.includes(id.toLowerCase()) && lane?.alive === true)) return true;
    const latest = limits.filter(row => aliases.includes(String(row.provider).toLowerCase())).at(-1);
    if (Number(latest?.until) > now) return false;
    return (service.keyFiles || []).some(file => fs.existsSync(file.startsWith('~/') ? path.join(home, file.slice(2)) : path.join(dir, file)));
  };
  for (const provider of providers) {
    const alternatives = services.filter(service => service.id !== provider.id && service.capabilities?.includes(cap) && alive(service)).map(service => service.id);
    if (alternatives.length) return { decision: 'block', code: 'SUBSTITUTE', reason: `[SUBSTITUTE] ${provider.id} への入金/ログイン依頼の前に、同じ能力(${cap})を持つ生存レーン ${alternatives.join(',')} で実行して結果を示してください（§1.18.5）。user が ${provider.id} を名指しで要求した場合だけ、本文に [SUBSTITUTE-OK] <user の文言の引用> を書いて通してください。` };
  }
  return { decision: 'pass' };
}
if (isEntry(import.meta.url)) {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      const result = data.stop_hook_active ? { decision: 'pass' } : judgeSubstituteCapability(data.assistant_text ?? latestAssistantText(data.transcript_path));
      console.log(JSON.stringify(result));
    } catch { console.log(JSON.stringify({ decision: 'pass' })); }
  });
}
