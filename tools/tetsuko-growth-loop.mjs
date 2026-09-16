#!/usr/bin/env node
// TETSUKO成長ループ(v3再構築版)。無人実行(Windowsタスクスケジューラ)前提で対話入力は一切行わない。
//
// 1回の実行で:
//   1. tetsuko-unified/data/growth-loop-log.md を読み、次サイクル番号をログ本文から算出(決め打ちカウンタ不使用)
//   2. まだ最近使っていない切り口をローテーションで選ぶ
//   3. tetsuko-unified/web/src を実際に grep して「実装済みか未実装か」を確認(推測で断定しない)
//   4. llm-ask.mjs 経由で外部調査(gemini)・下書き(deepseek)に委譲(全provider失敗時は正直にログへ記載)
//   5. growth-loop-log.md に追記、TETSUKO_DAILY_BRIEFING.md を上書き
//   6. tetsuko-unified 側で git add/commit/push(失敗しても後続は継続)
//   7. 実行ログ・履歴(jsonl)を書く
//
// 書き込みは全て一時ファイル→rename方式で、失敗時に既存ファイルを破損させない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TETSUKO_DIR_DEFAULT = 'C:\\Users\\user\\Documents\\tetsuko-unified';

export function resolveTetsukoDir(env = process.env) {
  return env.TETSUKO_UNIFIED_DIR || TETSUKO_DIR_DEFAULT;
}

export function resolveHome(env = process.env) {
  return env.ORGIAST_HOME || os.homedir();
}

// ---- ファイルI/O(安全書き込み) ----

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function atomicAppend(file, addition) {
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch {}
  const needsNewline = current.length > 0 && !current.endsWith('\n');
  atomicWrite(file, current + (needsNewline ? '\n' : '') + addition);
}

// ---- サイクル番号の算出(ログ本文から都度計算。重複採番防止) ----

export function nextCycleNumber(logText) {
  const text = String(logText || '');
  const nums = [];
  for (const m of text.matchAll(/サイクル#(\d+)/g)) nums.push(Number(m[1]));
  for (const m of text.matchAll(/累計提案サイクル数:\s*(\d+)/g)) nums.push(Number(m[1]));
  const max = nums.reduce((a, b) => (Number.isFinite(b) && b > a ? b : a), 0);
  return max + 1;
}

// ---- 過去に使われた切り口タグの抽出(重複回避のため) ----

export function extractPastTags(logText) {
  const text = String(logText || '');
  const tags = [];
  for (const m of text.matchAll(/【([^】]+)】/g)) tags.push(m[1]);
  return [...new Set(tags)];
}

export function extractPastCategoryLabels(logText, maxCycles = 3) {
  const text = String(logText || '');
  const lines = [...text.matchAll(/^対象:.*$/gm)].map((m) => m[0]);
  return lines.slice(-maxCycles);
}

// ---- カテゴリ・ローテーション ----

export const CATEGORIES = Object.freeze([
  { key: 'amazon', label: 'Amazon施策' },
  { key: 'cvr_trust', label: '自社サイトCVR・信頼構築' },
  { key: 'tech_measurement', label: '技術基盤・計測' },
  { key: 'repeat', label: 'リピート施策' },
  { key: 'customer_understanding', label: '顧客理解' },
]);

// cycleNumber(1始まり)からローテーションで主軸カテゴリを選ぶ。直前サイクルと同じ場合のみ1つ進める
// (「担当区分」節に書いた通り、決め打ちカウンタではなくログ本文由来のcycleNumberを使う)。
export function chooseCategory(cycleNumber, recentCategoryLabels = []) {
  const n = CATEGORIES.length;
  let index = ((cycleNumber - 1) % n + n) % n;
  const recentText = recentCategoryLabels.join('\n');
  for (let tries = 0; tries < n; tries += 1) {
    const candidate = CATEGORIES[index];
    if (!recentText.includes(candidate.label) || tries === n - 1) return candidate;
    index = (index + 1) % n;
  }
  return CATEGORIES[index];
}

// ---- コード確認(推測ではなく実ファイルscan) ----

function walkFiles(dir, exts) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
      out.push(...walkFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

export function scanForPattern(regex, { root, exts = ['.ts', '.tsx'], exclude = [] }) {
  const files = walkFiles(root, exts).filter((file) => !exclude.some((part) => file.replace(/\\/g, '/').includes(part)));
  const matches = [];
  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (regex.test(content)) matches.push(file);
  }
  return matches;
}

function relTetsuko(tetsukoDir, file) {
  return path.relative(tetsukoDir, file).replace(/\\/g, '/');
}

// カテゴリごとの「未実装候補」チェック一覧。present=true は実装済みを確認できた(=候補から外す)。
export function buildFeatureChecks(tetsukoDir) {
  const webSrc = path.join(tetsukoDir, 'web', 'src');
  return {
    tech_measurement: [
      {
        id: 'ogp', label: 'OGP/Twitter Card メタタグ',
        run: () => {
          const layoutFile = path.join(webSrc, 'app', 'layout.tsx');
          let content = '';
          try { content = fs.readFileSync(layoutFile, 'utf8'); } catch {}
          return { present: /openGraph\s*:|twitter\s*:/i.test(content), evidence: [relTetsuko(tetsukoDir, layoutFile)] };
        },
      },
      {
        id: 'next_image', label: 'next/imageへの移行(素の<img>タグの残存)',
        run: () => {
          const imgHits = scanForPattern(/<img\b/i, { root: webSrc });
          const nextImageHits = scanForPattern(/from ['"]next\/image['"]/i, { root: webSrc });
          return {
            present: imgHits.length === 0,
            evidence: imgHits.slice(0, 5).map((f) => relTetsuko(tetsukoDir, f)),
            detail: `<img>使用 ${imgHits.length}ファイル / next/image使用 ${nextImageHits.length}ファイル`,
          };
        },
      },
    ],
    cvr_trust: [
      {
        id: 'coupon', label: '初回訪問者向けクーポン・割引コード',
        run: () => { const hits = scanForPattern(/coupon|クーポン|discount[_-]?code/i, { root: webSrc }); return { present: hits.length > 0, evidence: hits.slice(0, 5).map((f) => relTetsuko(tetsukoDir, f)) }; },
      },
      {
        id: 'compare', label: '複数材質を並べて比較できる比較表機能',
        run: () => { const hits = scanForPattern(/比較表|compareList|材質を比較/i, { root: path.join(webSrc, 'app', 'catalog') }); return { present: hits.length > 0, evidence: hits.slice(0, 5).map((f) => relTetsuko(tetsukoDir, f)) }; },
      },
    ],
    repeat: [
      {
        id: 'newsletter', label: 'メールマガジン登録フォーム',
        run: () => { const hits = scanForPattern(/newsletter|メルマガ|mail[_-]?magazine/i, { root: webSrc }); return { present: hits.length > 0, evidence: hits.slice(0, 5).map((f) => relTetsuko(tetsukoDir, f)) }; },
      },
      {
        id: 'referral', label: '紹介プログラム・リピート特典の仕組み',
        run: () => { const hits = scanForPattern(/referral|紹介プログラム|紹介コード/i, { root: webSrc }); return { present: hits.length > 0, evidence: hits.slice(0, 5).map((f) => relTetsuko(tetsukoDir, f)) }; },
      },
    ],
    customer_understanding: [
      {
        id: 'survey', label: '購入後アンケート・NPS計測フォーム',
        run: () => { const hits = scanForPattern(/survey|\bnps\b|満足度アンケート/i, { root: webSrc, exclude: ['legal/privacy'] }); return { present: hits.length > 0, evidence: hits.slice(0, 5).map((f) => relTetsuko(tetsukoDir, f)) }; },
      },
      {
        id: 'onsite_chat', label: '有人オンサイトチャット導線',
        run: () => { const hits = scanForPattern(/(?<!ボット)チャット|live[_-]?chat/i, { root: path.join(webSrc, 'app') }); return { present: hits.length > 0, evidence: hits.slice(0, 5).map((f) => relTetsuko(tetsukoDir, f)) }; },
      },
    ],
    amazon: [],
  };
}

// カテゴリの未実装候補チェックから、コード確認済みの事実ベース項目を組み立てる(最大2件)。
export function buildCodeCheckItems(category, tetsukoDir) {
  const checks = buildFeatureChecks(tetsukoDir)[category.key] || [];
  const items = [];
  for (const check of checks) {
    let result;
    try { result = check.run(); } catch (error) { continue; }
    if (result.present) continue; // 既に実装済みと確認できたものは候補から外す
    items.push({
      label: check.label,
      confirmedAbsent: true,
      evidenceNote: result.evidence?.length
        ? `${result.evidence.slice(0, 3).join('、')} 等を確認したが該当実装が見つからなかった`
        : '該当ディレクトリを確認したが該当実装が見つからなかった',
      detail: result.detail || '',
    });
    if (items.length >= 2) break;
  }
  return items;
}

function formatCodeItem(category, item, index) {
  return [
    `${index}. **【${category.label}】${item.label}を追加する(現状${item.evidenceNote}ことをコード確認済み${item.detail ? `。${item.detail}` : ''})**`,
    '   - 根拠: 実際に該当ディレクトリを確認したところ、この機能に相当する実装が見当たらなかった。過去ログのローテーション方針(Amazon施策/自社サイトCVR・信頼構築/技術基盤・計測/リピート施策/顧客理解)に沿って今回この切り口を扱う。',
    '   - 期待効果(定量目安・仮): 定量化は困難だが、他社EC・過去サイクルの一般論に沿えば導入により該当指標(CVR/回遊/リピート等)の改善が見込まれる(東邦鋼業実データでの検証は未実施)。',
    '   - 実行難易度: 低〜中(既存ページ・DBの流用が可能な範囲)。',
    '   - 担当区分: Codex実装(tetsuko-unified側)。このループでは実装せず、次セッションかCodex委譲とする。',
  ].join('\n');
}

// ---- llm-ask.mjs 経由のLLM呼び出し(providerが失敗すると llm-ask.mjs 自身のfallback連鎖が動く) ----

const LLM_ASK_PATH = path.join(__dirname, 'llm-ask.mjs');

export function callLlmAsk({
  provider, prompt, system, maxTokens = 1200,
  llmAskPath = LLM_ASK_PATH, spawn = spawnSync, env = process.env, timeoutMs = 100_000,
} = {}) {
  const args = [llmAskPath, '--provider', provider, prompt, '--max', String(maxTokens)];
  if (system) args.push('--system', system);
  const result = spawn(process.execPath, args, { encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true });
  if (result.error) return { ok: false, reason: `spawn失敗: ${result.error.message}`, providerUsed: null };
  if (result.status !== 0) {
    const reason = String(result.stderr || '').trim() || `exit code ${result.status}`;
    return { ok: false, reason, providerUsed: null };
  }
  const text = String(result.stdout || '').trim();
  const usedMatch = String(result.stderr || '').match(/\[([a-z0-9_-]+):([^\]]+)\]\s+in=/i);
  return { ok: true, text, providerUsed: usedMatch ? usedMatch[1] : provider, modelUsed: usedMatch ? usedMatch[2] : null };
}

// ---- deepseek下書きの分割・検証 ----

export function splitDraftItems(draftText) {
  const text = String(draftText || '').trim();
  if (!text) return [];
  const blocks = text.split(/\n(?=\*\*【)/g).map((b) => b.trim()).filter(Boolean);
  return blocks.filter((block) => (
    /^\*\*【[^】]+】.+\*\*/.test(block)
    && /根拠:/.test(block)
    && /期待効果/.test(block)
    && /実行難易度:/.test(block)
    && /担当区分:/.test(block)
  ));
}

function buildResearchPrompt(categoryLabel, pastTags) {
  return `あなたはTETSUKO(東邦鋼業運営、法人向け鋼材通販サイト。3年で売上2億円・5年で売上10億円、Amazon月商1000万円が目標)の成長施策アドバイザーです。\n`
    + `今回のテーマ領域は「${categoryLabel}」です。\n`
    + `過去に既に提案済みの切り口(内容が重複しないこと): ${pastTags.slice(-80).join('、') || '(記録なし)'}\n`
    + `上記と重複しない、具体的な施策アイデアを1つ提案し、その実務上のメリット・デメリットを250字程度の日本語で述べてください。`
    + `Amazonセラーセントラル等の実データにはアクセスできない前提のため、断定を避け「〜とされる」「〜の可能性がある」等の表現を使ってください。`;
}

function buildDraftPrompt({ categoryLabel, itemCount, codeContextText, researchText, pastTags }) {
  return `東邦鋼業の鋼材EC「TETSUKO」の成長施策ログに追記する1サイクル分の提案を${itemCount}件、日本語Markdownで書いてください。\n\n`
    + `出力フォーマット(1件につき必ずこの構造で、前後に余計な文章や番号付けを書かない。**から書き始める):\n`
    + `**【切り口タグ・テーマ】施策タイトル(現状〜であることを踏まえた具体的な内容)**\n`
    + `   - 根拠: (100〜200字。実データが無い前提を明示し断定を避ける)\n`
    + `   - 期待効果(定量目安・仮): (50字程度)\n`
    + `   - 実行難易度: 低/中/高のいずれかと簡単な理由\n`
    + `   - 担当区分: (Codex実装 / kim承認要 / 東邦鋼業側確認要 のいずれか1つ以上)\n\n`
    + `今回のテーマ領域: ${categoryLabel}\n`
    + `参考にしてよいコード確認済みの事実:\n${codeContextText || '(今回は該当なし)'}\n\n`
    + `外部調査結果(参考にしてよいが鵜呑みにせず「〜とされる」等でぼかすこと):\n${researchText || '(今回は外部調査なし)'}\n\n`
    + `過去に提案済みの切り口(内容が重複しないよう新しい角度にすること): ${pastTags.slice(-80).join('、') || '(記録なし)'}\n\n`
    + `${itemCount}件のみ出力してください。`;
}

// ---- ブリーフィング ----

export function extractBriefBullet(itemBlock) {
  // 実際の項目テキストは "1. **【タグ】タイトル**" のように番号付きで渡されるため、先頭の "N. " は許容する。
  const title = itemBlock.match(/^(?:\d+\.\s*)?\*\*【([^】]+)】(.+?)\*\*/m);
  const role = itemBlock.match(/担当区分:\s*(.+)/);
  const tag = title ? title[1] : '';
  let body = title ? title[2] : itemBlock.split('\n')[0];
  if (body.length > 42) body = `${body.slice(0, 42)}…`;
  const roleText = role ? role[1].replace(/。.*$/, '').trim() : '';
  return `**【${tag}】** ${body}${roleText ? `（${roleText}）` : ''}`;
}

export function buildBriefing({ previousBriefing, date, cycleNumber, itemBlocks }) {
  const bullets = itemBlocks.map((block, i) => `${i + 1}. ${extractBriefBullet(block)}`).join('\n');
  // 「目標に対する現在地」表は実データの伴わない書き換えを避けるため、直前ブリーフィングの表をそのまま引き継ぐ。
  const prevTable = String(previousBriefing || '').match(/\|\s*目標[\s\S]*?\n\n/);
  const table = prevTable ? prevTable[0].trim() : (
    '| 目標 | 状況 |\n|---|---|\n'
    + '| 3年で売上2億円 | 進行中。詳細は過去サイクルを参照。 |\n'
    + '| 5年で売上10億円 | 進行中。詳細は過去サイクルを参照。 |\n'
    + '| Amazon月商1000万円 | 進行中。詳細は過去サイクルを参照。 |'
  );
  return `# TETSUKO 成長ループ 日次ブリーフィング\n\n`
    + `更新日時: ${date}（サイクル#${cycleNumber}）\n\n`
    + `## 今日の新規提案（${itemBlocks.length}件）\n\n${bullets}\n\n`
    + `詳細な根拠・期待効果・実行難易度は \`data/growth-loop-log.md\` の「サイクル#${cycleNumber}」を参照。\n\n`
    + `## 目標に対する現在地\n\n${table}\n\n`
    + `## 累計\n\n- 提案サイクル数: ${cycleNumber}\n- 詳細ログ: \`data/growth-loop-log.md\`\n`;
}

// ---- 日付 ----

export function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---- git ----

function runGit(args, cwd, spawn = spawnSync) {
  const result = spawn('git', args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { ok: !result.error && result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error };
}

export function commitAndPush(tetsukoDir, cycleNumber, spawn = spawnSync) {
  const steps = [];
  const add = runGit(['add', 'data/growth-loop-log.md', 'TETSUKO_DAILY_BRIEFING.md'], tetsukoDir, spawn);
  steps.push({ step: 'add', ...add });
  if (!add.ok) return { ok: false, steps };
  const commit = runGit(['commit', '-m', `TETSUKO成長ループ サイクル#${cycleNumber}: 施策ログ追記 + 日次ブリーフィング更新`], tetsukoDir, spawn);
  steps.push({ step: 'commit', ...commit });
  if (!commit.ok) return { ok: false, steps };
  const push = runGit(['push'], tetsukoDir, spawn);
  steps.push({ step: 'push', ...push });
  return { ok: push.ok, steps };
}

// ---- メイン処理 ----

export async function runCycle({
  tetsukoDir = resolveTetsukoDir(),
  home = resolveHome(),
  now = new Date(),
  spawn = spawnSync,
  skipGit = false,
} = {}) {
  const logFile = path.join(tetsukoDir, 'data', 'growth-loop-log.md');
  const briefingFile = path.join(tetsukoDir, 'TETSUKO_DAILY_BRIEFING.md');

  let logText = '';
  try { logText = fs.readFileSync(logFile, 'utf8'); } catch (error) {
    throw new Error(`ログファイルを読めません: ${logFile} (${error.message})`);
  }
  let previousBriefing = '';
  try { previousBriefing = fs.readFileSync(briefingFile, 'utf8'); } catch {}

  const cycleNumber = nextCycleNumber(logText);
  const pastTags = extractPastTags(logText);
  const recentCategoryLabels = extractPastCategoryLabels(logText, 3);
  const category = chooseCategory(cycleNumber, recentCategoryLabels);
  const date = localDate(now);

  const providersTried = [];
  const codeItems = category.key === 'amazon' ? [] : buildCodeCheckItems(category, tetsukoDir);
  const codeContextText = codeItems.map((item, i) => `${i + 1}. ${item.label}: ${item.evidenceNote}`).join('\n');

  const itemsNeededFromLlm = Math.max(1, 3 - codeItems.length);

  // 4. 外部調査(gemini) → 下書き(deepseek)。llm-ask.mjs 自体が全provider連鎖でfallbackする。
  let researchResult = { ok: false, reason: '未実行' };
  try {
    researchResult = callLlmAsk({ provider: 'gemini', prompt: buildResearchPrompt(category.label, pastTags), maxTokens: 500 });
  } catch (error) { researchResult = { ok: false, reason: error?.message || String(error) }; }
  if (researchResult.ok) providersTried.push(researchResult.providerUsed);

  let draftResult = { ok: false, reason: '未実行' };
  try {
    draftResult = callLlmAsk({
      provider: 'deepseek',
      prompt: buildDraftPrompt({
        categoryLabel: category.label,
        itemCount: itemsNeededFromLlm,
        codeContextText,
        researchText: researchResult.ok ? researchResult.text : '',
        pastTags,
      }),
      maxTokens: 1500,
    });
  } catch (error) { draftResult = { ok: false, reason: error?.message || String(error) }; }
  if (draftResult.ok) providersTried.push(draftResult.providerUsed);

  let llmItemBlocks = [];
  let honestyNote = '';
  if (draftResult.ok) {
    llmItemBlocks = splitDraftItems(draftResult.text).slice(0, itemsNeededFromLlm);
    if (llmItemBlocks.length < itemsNeededFromLlm) {
      honestyNote = `LLM下書き(${draftResult.providerUsed})から期待した${itemsNeededFromLlm}件のうち${llmItemBlocks.length}件のみ規定フォーマットで得られたため、今回はその件数のみ掲載する。`;
    }
  } else {
    honestyNote = `外部調査・下書きの委譲先(gemini/deepseek含む全provider)が本日は失敗したため正直に記載する: ${draftResult.reason}。今回はコード確認済みの事実ベースの提案のみ掲載する。`;
  }

  const codeItemTexts = codeItems.map((item, i) => formatCodeItem(category, item, i + 1));
  const llmItemTexts = llmItemBlocks.map((block, i) => {
    const renumbered = block.replace(/^\*\*/, `${codeItems.length + i + 1}. **`);
    const withSource = researchResult.ok && !/調査元:/.test(renumbered)
      ? `${renumbered}\n   - 調査元: ${researchResult.providerUsed}(外部調査) + ${draftResult.providerUsed}(下書き)への委譲。`
      : renumbered;
    return withSource;
  });

  const allItemTexts = [...codeItemTexts, ...llmItemTexts];
  if (allItemTexts.length === 0) {
    allItemTexts.push([
      '1. **【生成失敗】今回は施策提案を生成できなかった**',
      `   - 根拠: ${draftResult.reason || '不明な理由'}`,
      '   - 期待効果(定量目安・仮): 該当なし。',
      '   - 実行難易度: 該当なし。',
      '   - 担当区分: 次回実行時に再試行する。',
    ].join('\n'));
  }

  const targetLine = [
    '対象: 東邦鋼業(鋼材EC)を3年で売上2億円・5年で10億円に近づける施策。今回は無人実行(tetsuko-growth-loop.mjs)による自動生成サイクル。',
    `今回は主に「${category.label}」の切り口でローテーションする。`,
    codeItems.length ? `着手前に web/src を実際に確認したところ、${codeItems.map((i) => i.label).join('・')}が未実装であることをコード確認済み。` : '',
    honestyNote,
    'Amazon等の実データには直接アクセスできないため、外部データを要する項目はいずれも戦略提案。',
  ].filter(Boolean).join(' ');

  const cycleBody = [
    `## ${date} サイクル#${cycleNumber}`,
    '',
    targetLine,
    '',
    allItemTexts.join('\n\n'),
    '',
    `(累計提案サイクル数: ${cycleNumber})`,
    '',
  ].join('\n');

  atomicAppend(logFile, `\n${cycleBody}`);
  const briefingText = buildBriefing({ previousBriefing, date, cycleNumber, itemBlocks: allItemTexts });
  atomicWrite(briefingFile, briefingText);

  let gitResult = { ok: true, steps: [], skipped: true };
  if (!skipGit) {
    try { gitResult = commitAndPush(tetsukoDir, cycleNumber, spawn); }
    catch (error) { gitResult = { ok: false, steps: [], error: error?.message || String(error) }; }
  }

  return {
    cycleNumber,
    category: category.key,
    date,
    researchResult,
    draftResult,
    providersTried: [...new Set(providersTried.filter(Boolean))],
    itemCount: allItemTexts.length,
    codeItemCount: codeItems.length,
    llmItemCount: llmItemTexts.length,
    honestyNote,
    gitResult,
    logFile,
    briefingFile,
  };
}

// ---- 実行ログ・履歴 ----

export function writeRunLog(home, cycleNumber, resultOrError, extra = {}) {
  const runsDir = path.join(home, '.claude', 'tetsuko-growth', 'runs');
  const historyFile = path.join(home, '.claude', 'tetsuko-growth', 'history.jsonl');
  const startedAt = extra.startedAt || new Date().toISOString();
  const finishedAt = new Date().toISOString();
  const ok = !(resultOrError instanceof Error);
  const logLines = [
    `[${finishedAt}] tetsuko-growth-loop 実行`,
    `cycle: ${cycleNumber ?? '不明'}`,
    `ok: ${ok}`,
    ok ? `providersTried: ${JSON.stringify(resultOrError.providersTried)}` : `error: ${resultOrError.stack || resultOrError.message || String(resultOrError)}`,
    ok ? `gitResult.ok: ${resultOrError.gitResult?.ok}` : '',
  ].filter(Boolean);
  const runFile = path.join(runsDir, `${finishedAt.replace(/[:.]/g, '-')}.log`);
  try { atomicWrite(runFile, `${logLines.join('\n')}\n`); } catch {}

  const historyRow = {
    t: finishedAt,
    startedAt,
    cycle: cycleNumber ?? null,
    ok,
    providers: ok ? resultOrError.providersTried : [],
    gitOk: ok ? Boolean(resultOrError.gitResult?.ok) : null,
    error: ok ? null : (resultOrError.message || String(resultOrError)),
  };
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.appendFileSync(historyFile, `${JSON.stringify(historyRow)}\n`, 'utf8');
  } catch {}
  return { runFile, historyFile };
}

async function main() {
  const startedAt = new Date().toISOString();
  const tetsukoDir = resolveTetsukoDir();
  const home = resolveHome();
  let result;
  try {
    result = await runCycle({ tetsukoDir, home });
  } catch (error) {
    console.error(`tetsuko-growth-loop: 失敗しました: ${error?.stack || error}`);
    try { writeRunLog(home, null, error, { startedAt }); } catch {}
    process.exitCode = 1;
    return;
  }
  writeRunLog(home, result.cycleNumber, result, { startedAt });
  console.log(`tetsuko-growth-loop: サイクル#${result.cycleNumber} を追記しました(${result.codeItemCount}件コード確認 + ${result.llmItemCount}件LLM下書き)`);
  if (!result.gitResult.ok && !result.gitResult.skipped) {
    console.error(`tetsuko-growth-loop: git commit/push に失敗しました(処理は続行済み): ${JSON.stringify(result.gitResult.steps?.at(-1) || result.gitResult.error)}`);
  }
}

if (isEntry(import.meta.url)) await main();
