#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.resolve(toolsDir, '..', 'outputs', 'X-0008');
export const PROVIDERS = ['gemini', 'deepseek', 'groq'];
export const DEFAULT_SERVICE_PAGES = [
  { title: '展示会ブース制作 サービス一覧', url: 'https://www.orgiast.jp/booth/', description: 'ブース制作サービスの全体像を確認できます。' },
  { title: 'ブース制作の料金プラン', url: 'https://www.orgiast.jp/booth/pricing/', description: '規模や予算に応じた料金プランを紹介します。' },
  { title: '施工事例一覧', url: 'https://www.orgiast.jp/case-studies/', description: '展示会ブースの施工事例を掲載しています。' },
  { title: 'お問い合わせ', url: 'https://www.orgiast.jp/contact/', description: 'ブース制作について無料で相談できます。' },
  { title: '小規模ブース制作のポイント', url: 'https://www.orgiast.jp/booth/small-booth/', description: '1小間など小規模ブースの設計ポイントを解説します。' },
  { title: 'ブースデザインの考え方', url: 'https://www.orgiast.jp/booth/design/', description: '集客につながるデザインの考え方を紹介します。' },
];
export const SYSTEM_PROMPT = `あなたは展示会ブース制作のSEO専門家です。
以下のキーワードに対して、読者が知りたいこと・検索意図を満たす高品質なSEOガイドを1本書いてください。

【ガイドの構成】
1. タイトル（キーワードを含み、クリックしたくなるもの）
2. 導入文（100-150字。読者の課題に共感し、この記事がその解決になることを示す）
3. 見出し（H2）で区切られた本文（合計800-1200字）
4. 箇条書き・表を適宜使って読みやすく
5. まとめ（30-50字の結論＋次のアクション提示）

【SEO要件】
- タイトル・H2・導入文にキーワードを自然に含める
- 関連する共起語（類義語・周辺語）も使う
- 具体例・数字を入れる（信頼性向上）
- 専門用語を使う場合は簡単な説明を添える

【絶対禁止】
- 「まずは」「この記事では〜していきます」「最後までお読みいただき」などのブログ定型句
- AIらしい抽象的な表現（「多岐にわたる」「重要なポイント」などの中身のない言い回し）
- 長すぎる文章（1文60字以内を推奨）
- 事実と異なる数字・データの捏造`;

const number = (value, fallback = 0) => { const n = Number(String(value ?? '').replace(/[,%\s]/g, '')); return Number.isFinite(n) ? n : fallback; };
export function parseCsvRows(text) {
  const rows = []; let row = []; let field = ''; let quoted = false; const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) { const ch = source[i];
    if (quoted) { if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch; }
    else if (ch === '"') quoted = true; else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; } else field += ch;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}
export function parseGscCsv(text) {
  const rows = parseCsvRows(text); if (!rows.length) return [];
  const aliases = { query: ['query', 'クエリ'], impressions: ['impressions', '表示回数'], clicks: ['clicks', 'クリック数'], ctr: ['ctr'], position: ['position', '掲載順位'] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const index = Object.fromEntries(Object.entries(aliases).map(([k, names]) => [k, headers.findIndex((h) => names.includes(h))]));
  if (index.query < 0) throw new Error('CSVに query（またはクエリ）ヘッダーがありません');
  return rows.slice(1).map((v) => { const impressions = number(v[index.impressions]); const clicks = number(v[index.clicks]); const raw = index.ctr >= 0 ? String(v[index.ctr] ?? '') : ''; return { query: String(v[index.query] ?? '').trim(), impressions, clicks, ctr: raw ? number(raw) / (raw.includes('%') ? 100 : 1) : (impressions ? clicks / impressions : 0), position: number(v[index.position]) }; }).filter((v) => v.query);
}
export function parseGscJson(value) {
  const data = typeof value === 'string' ? JSON.parse(value) : value; const rows = Array.isArray(data) ? data : data?.candidates ?? data?.keywords ?? data?.rows ?? data?.results;
  if (!Array.isArray(rows)) throw new Error('GSC JSONに候補配列（candidates等）がありません');
  return rows.map((v) => { const impressions = number(v.impressions); const clicks = number(v.clicks); let ctr = number(v.ctr); if (String(v.ctr ?? '').includes('%') || ctr > 1) ctr /= 100; if (v.ctr == null && impressions) ctr = clicks / impressions; return { query: String(v.query ?? v.keyword ?? v.keys?.[0] ?? '').trim(), impressions, clicks, ctr, position: number(v.position) }; }).filter((v) => v.query);
}
export const emptyLedger = (now = new Date()) => ({ version: 1, lastUpdated: now.toISOString(), guides: [], coveredKeywords: [] });
export function loadLedger(file, { warn = console.warn } = {}) { if (!fs.existsSync(file)) return emptyLedger(); try { const text = fs.readFileSync(file, 'utf8').trim(); if (!text) throw Error(); const v = JSON.parse(text); return { version: 1, ...v, guides: Array.isArray(v.guides) ? v.guides : [], coveredKeywords: Array.isArray(v.coveredKeywords) ? v.coveredKeywords : [] }; } catch { warn(`警告: レジャーが空または破損しているため新規初期化します: ${file}`); return emptyLedger(); } }
export function saveLedger(file, data) { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); data.lastUpdated = new Date().toISOString(); fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }
const normalize = (v) => String(v ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function isKeywordCovered(ledger, keyword) { const target = normalize(keyword); return (ledger.coveredKeywords ?? []).some((v) => { const current = normalize(v); return current && (current.includes(target) || target.includes(current)); }); }
export function addGuideEntry(ledger, entry) { ledger.guides ??= []; ledger.coveredKeywords ??= []; ledger.guides.push(entry); if (!ledger.coveredKeywords.some((v) => normalize(v) === normalize(entry.keyword))) ledger.coveredKeywords.push(entry.keyword); ledger.lastUpdated = new Date().toISOString(); return ledger; }
export function selectKeyword(candidates, ledger, { force = false, random = Math.random } = {}) { const available = force ? candidates : candidates.filter((v) => !isKeywordCovered(ledger, v.query)); if (!available.length) return null; const relevant = available.filter((v) => /展示会|ブース|イベント|出展|小間|装飾|設営|施工/.test(v.query)); const pool = (relevant.length ? relevant : available).map((v) => ({ ...v, score: v.impressions * (1 - Math.max(0, Math.min(1, v.ctr))) * (Math.max(30, 100 - v.position) / 100) })).sort((a, b) => b.score - a.score).slice(0, 3); return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]; }

const SLUG_WORDS = new Map([['おすすめ', 'recommended'], ['展示会', 'exhibition'], ['デザイン', 'design'], ['ブース', 'booth'], ['小間', 'koma'], ['制作', 'production'], ['施工', 'construction'], ['予算', 'budget'], ['費用', 'cost'], ['事例', 'case'], ['業界', 'industry']]);
export function generateSlug(keyword) { let value = String(keyword).normalize('NFKC').toLowerCase(); for (const [jp, en] of SLUG_WORDS) value = value.replaceAll(jp, `-${en}-`); return value.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-+$/g, '') || 'seo-guide'; }
function scorePage(page, keyword) { const rules = [['デザイン', 'design'], ['予算', 'pricing'], ['費用', 'pricing'], ['料金', 'pricing'], ['価格', 'pricing'], ['事例', 'case-studies'], ['実績', 'case-studies'], ['施工', 'case-studies'], ['小間', 'small-booth'], ['小規模', 'small-booth']]; return rules.reduce((s, [word, fragment]) => s + (keyword.includes(word) && page.url.includes(fragment) ? 10 : 0), page.url.includes('/booth/') ? 1 : 0); }
export function appendInternalLinks(content, servicePages, keyword, siteName = '株式会社オージャスト') { const contact = servicePages.find((v) => /contact/.test(v.url)) ?? DEFAULT_SERVICE_PAGES[3]; const pages = servicePages.filter((v) => v !== contact).map((page, index) => ({ page, index, score: scorePage(page, keyword) })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3).map((v) => v.page); const links = pages.map((v) => `- [${v.title}](${v.url}) — ${v.description || '詳しい情報をご覧いただけます。'}`).join('\n'); return `${String(content).trim()}\n\n---\n\n## 関連サービス\n\n${links}\n\n---\n\n### この記事を書いた人\n\n${siteName}は、展示会ブースの設計・制作・施工を一貫して手がける専門企業です。金属加工の技術を活かしたオリジナルブースから、リユース可能なシステムブースまで、予算や規模に合わせた最適な提案をいたします。\n\n**まずは無料相談から** — お気軽にお問い合わせください。\n\n[→ お問い合わせはこちら](${contact.url})\n`; }

export function parseArgs(argv) { const o = { outputDir: DEFAULT_OUTPUT_DIR, ledger: null, siteName: '株式会社オージャスト', servicePages: null, dryRun: false, force: false, initLedger: false }; const valued = new Set(['--gsc-json', '--gsc-csv', '--keyword', '--output-dir', '--ledger', '--site-name', '--service-pages']); const keys = { '--gsc-json': 'gscJson', '--gsc-csv': 'gscCsv', '--keyword': 'keyword', '--output-dir': 'outputDir', '--ledger': 'ledger', '--site-name': 'siteName', '--service-pages': 'servicePages' }; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (valued.has(arg)) { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} には値が必要です`); o[keys[arg]] = argv[++i]; } else if (arg === '--dry-run') o.dryRun = true; else if (arg === '--force') o.force = true; else if (arg === '--init-ledger') o.initLedger = true; else throw new Error(`不明なオプション: ${arg}`); } o.outputDir = path.resolve(o.outputDir); o.ledger = path.resolve(o.ledger || path.join(o.outputDir, 'ledger.json')); if (o.gscJson && o.gscCsv) throw new Error('--gsc-json と --gsc-csv は同時に指定できません'); if (!o.initLedger && !o.gscJson && !o.gscCsv && !o.keyword) throw new Error('--gsc-json、--gsc-csv、--keyword のいずれかを指定してください'); return o; }
export const buildUserPrompt = (keyword) => `キーワード: "${keyword}"\nターゲット読者: 展示会への出展を検討している企業の担当者\n目的: このキーワードで検索している人の疑問・課題を解消し、具体的で役立つ情報を提供する\n\n以下の形式でガイドを生成してください：\n\n# {タイトル}\n\n{導入文（100-150字）}\n\n## {H2見出し1}\n{本文}\n\n## {H2見出し2}\n{本文}\n\n...\n\n## まとめ\n{結論＋次のアクション}`;
export function generateContent(provider, system, prompt) { const output = execFileSync(process.execPath, [path.join(toolsDir, 'llm-ask.mjs'), '--provider', provider, '--prefer-provider', '--no-fallback', '--system', system, '--max', '2200', prompt], { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim(); if (!output || output === '(出力なし)') throw new Error(`${provider} returned empty content`); return output; }
export function generateWithFallback(system, prompt, generator = generateContent) { const errors = []; for (const provider of PROVIDERS) { try { return { content: generator(provider, system, prompt), provider }; } catch (e) { errors.push(`${provider}: ${e.message}`); } } throw new Error(`すべてのプロバイダで生成に失敗しました: ${errors.join(' / ')}`); }
const frontmatter = (item, date, provider) => `---\ndate: ${date}\nkeyword: ${JSON.stringify(item.query)}\nimpressions: ${item.impressions}\nposition: ${item.position}\nctr: ${(item.ctr * 100).toFixed(1)}%\ngenerated_by: daily-seo-guide (provider: ${provider})\ntopic_category: 展示会ブース\n---\n\n`;
export async function run(argv = process.argv.slice(2), deps = {}) { const o = parseArgs(argv); if (o.initLedger) { const ledger = emptyLedger(); saveLedger(o.ledger, ledger); console.log(`レジャーを初期化しました: ${o.ledger}`); return { ledger }; } const ledger = loadLedger(o.ledger); let candidates; if (o.keyword) candidates = [{ query: o.keyword, impressions: 0, clicks: 0, ctr: 0, position: 0 }]; else if (o.gscCsv) candidates = parseGscCsv(fs.readFileSync(path.resolve(o.gscCsv), 'utf8')); else candidates = parseGscJson(fs.readFileSync(path.resolve(o.gscJson), 'utf8')); const selected = selectKeyword(candidates, ledger, { force: o.force, random: deps.random ?? Math.random }); if (!selected) { console.log('すべての候補をカバー済みです。--force で強制生成できます。'); return { covered: true }; } console.log(`選択キーワード: ${selected.query}`); if (o.dryRun) { console.log(`優先度スコア: ${selected.score.toFixed(2)}`); return { selected, dryRun: true }; } const pages = o.servicePages ? JSON.parse(fs.readFileSync(path.resolve(o.servicePages), 'utf8')) : DEFAULT_SERVICE_PAGES; if (!Array.isArray(pages)) throw new Error('--service-pages はJSON配列で指定してください'); const generated = (deps.generateWithFallback ?? generateWithFallback)(SYSTEM_PROMPT, buildUserPrompt(selected.query)); const date = (deps.now ?? new Date()).toISOString().slice(0, 10); const slug = generateSlug(selected.query); const guideDir = path.join(o.outputDir, 'guides'); const outputPath = path.join(guideDir, `${date}-${slug}.md`); fs.mkdirSync(guideDir, { recursive: true }); fs.writeFileSync(outputPath, frontmatter(selected, date, generated.provider) + appendInternalLinks(generated.content, pages, selected.query, o.siteName), 'utf8'); addGuideEntry(ledger, { date, keyword: selected.query, slug, file: path.relative(process.cwd(), outputPath).replaceAll('\\', '/'), impressions: selected.impressions, position: selected.position, ctr: selected.ctr, provider: generated.provider }); saveLedger(o.ledger, ledger); console.log(`ガイドを生成しました: ${outputPath}`); return { selected, outputPath, provider: generated.provider }; }
if (isEntry(import.meta.url)) run().catch((e) => { console.error(`エラー: ${e.message}`); process.exitCode = 1; });
