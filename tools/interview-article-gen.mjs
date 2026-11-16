#!/usr/bin/env node
/**
 * tools/interview-article-gen.mjs — X-0033: 質問抽出で一次情報コンテンツ作成
 *
 * NYSEO式 専門家質問法に基づき、20〜25問の構造化インタビュー質問を生成し、
 * 回答からSEO/LLMO向け記事を生成するツール。
 *
 * 2つのモード:
 *   1. --mode questions   — インタビュー質問セットを生成（20〜25問、6カテゴリ）
 *   2. --mode article     — 回答ファイル→ SEO記事を生成
 *   3. --sample           — サンプル実行（QA→記事）
 *
 * 使い方:
 *   node tools/interview-article-gen.mjs --mode questions --topic "展示会ブース制作" --persona "施工スタッフ"
 *   node tools/interview-article-gen.mjs --mode article --answers answers.json --output article.md
 *   node tools/interview-article-gen.mjs --sample
 *
 * 環境変数:
 *   LLM_PROVIDER   LLMプロバイダ (既定: deepseek)
 *
 * X-0045: docs/ai-news-x0045-expert-question-article.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLlmClient } from './line-digest.mjs';
import { isEntry } from './is-entry.mjs';

// ============================================================
// 定数
// ============================================================

const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'deepseek';

/** X-0045 の6カテゴリ定義 */
export const QUESTION_CATEGORIES = [
  { key: 'experience', label: '経験・実績', count: 5, purpose: '実体験の具体化（いつ・どこで・誰と）' },
  { key: 'challenges', label: '課題・失敗', count: 5, purpose: '独自の困難と克服エピソード' },
  { key: 'numbers', label: '数字・データ', count: 4, purpose: '検証可能な定量情報' },
  { key: 'comparison', label: '比較・対比', count: 4, purpose: '差別化ポイントの明確化' },
  { key: 'trends', label: 'トレンド・変化', count: 4, purpose: '業界知見・将来予測' },
  { key: 'advice', label: 'アドバイス', count: 2, purpose: '読者への実用的示唆' },
];

export const TOTAL_QUESTIONS = QUESTION_CATEGORIES.reduce((sum, c) => sum + c.count, 0); // 24

// ============================================================
//  質問生成プロンプト
// ============================================================

function buildQuestionsPrompt({ topic, persona }) {
  const catDefs = QUESTION_CATEGORIES.map((c, i) =>
    `【カテゴリ${i + 1}: ${c.label}（${c.count}問）】${c.purpose}`
  ).join('\n');

  return [
    { role: 'system', content: `あなたは構造化インタビューの設計者です。展示会ブース制作の専門家（施工スタッフ・ディレクター）から、公開情報では得られない一次情報・独自データを引き出すための質問セットを設計してください。` },
    { role: 'user', content: [
      `以下の条件で、合計${TOTAL_QUESTIONS}問のインタビュー質問を生成してください。`,
      '',
      `■ テーマ: ${topic || '展示会ブース制作'}`,
      `■ 対象ペルソナ: ${persona || '施工スタッフ・ディレクター'}`,
      '',
      `■ 質問設計の原則（NYSEO）:`,
      `1. AIが答えられない質問だけを聞く — 公開情報で調べられることは聞かない`,
      `2. 具体的事例を要求する — 「どう思うか」ではなく「どうだったか」`,
      `3. 数量・日付・固有名詞を引き出す — 「多い」ではなく具体的な数字を`,
      `4. 失敗・苦労を掘る — 成功談より失敗談の方が独自性が高い`,
      `5. 対比を促す — 「AとBの違いは？」「導入前と導入後でどう変わった？」`,
      '',
      `■ カテゴリ配分（全${QUESTION_CATEGORIES.length}カテゴリ・${TOTAL_QUESTIONS}問）:`,
      catDefs,
      '',
      `■ 出力形式: 以下のJSON配列で出力してください。`,
      `[{ "category": "経験・実績", "number": 1, "question": "..." }]`,
    ].join('\n') },
  ];
}

// ============================================================
//  記事生成プロンプト
// ============================================================

function buildArticlePrompt({ qaPairs, topic, articleType = 'success' }) {
  const qaText = qaPairs.map((qa, i) =>
    `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`
  ).join('\n\n');

  const typeGuide = {
    success: '成功事例 — 実体験に基づく成功の要因・工夫を中心に',
    knowhow: 'ノウハウ記事 — 数字・比較・トレンドを中心に実用的知見を',
    failure: '失敗から学ぶ — 課題・失敗エピソードと克服方法を中心に',
    trend: '業界トレンド — 変化・将来予測を中心に',
    interview: 'インタビュー — 全カテゴリからバランスよく',
  };

  return [
    { role: 'system', content: 'あなたは展示会ブース制作の専門家インタビューからSEO記事を生成するライターです。与えられたインタビュー回答のみを情報源とし、公開情報や一般知識で補完しないでください。' },
    { role: 'user', content: [
      `# 指示`,
      `以下のインタビュー回答のみを情報源として、SEO/LLMO向けの記事を1本生成してください。`,
      `公開情報や一般知識で補完しないでください。`,
      '',
      `# 記事タイプ: ${typeGuide[articleType] || typeGuide.success}`,
      `# テーマ: ${topic || '展示会ブース制作'}`,
      '',
      `# インタビュー回答（${qaPairs.length}問）:`,
      qaText,
      '',
      `# 出力要件`,
      `以下のJSON形式で出力してください。`,
      `{`,
      `  "title": "タイトル（SEOキーワードを含む、60字以内）",`,
      `  "lead": "リード文（150字以内、検索結果のdescriptionとしても使えるもの）",`,
      `  "sections": [`,
      `    { "heading": "h2見出し", "body": "本文段落（200〜600字）" }`,
      `  ],`,
      `  "faq": [`,
      `    { "question": "FAQ質問", "answer": "FAQ回答" }`,
      `  ],`,
      `  "metadata": {`,
      `    "description": "メタdescription 120字以内",`,
      `    "keywords": ["キーワード1", "キーワード2", "キーワード3", "キーワード4", "キーワード5"]`,
      `  }`,
      `}`,
      '',
      `# 品質ルール`,
      `- 「多くの企業が」「一般的に」などの一般論を書かない`,
      `- 具体的な数字・固有名詞・事例はインタビュー回答から引用し「」で囲む`,
      `- 意見と事実を明確に区別する`,
      `- 誇張表現をしない`,
      `- E-E-A-Tを高めるため、経験に基づく記述を優先する`,
      `- 本文は合計2,000〜4,000字程度、h2見出しで3〜5セクションに区切る`,
      `- FAQは3〜5問、インタビュー回答から生成されたもののみ`,
    ].join('\n') },
  ];
}

// ============================================================
//  JSON 抽出ユーティリティ
// ============================================================

function extractJson(text) {
  const clean = String(text ?? '')
    .replace(/```(?:json)?/giu, '')
    .replace(/```/gu, '');
  for (let start = clean.indexOf('{'); start >= 0; start = clean.indexOf('{', start + 1)) {
    for (let end = clean.length; end > start; end--) {
      try { return JSON.parse(clean.slice(start, end)); } catch { /* continue */ }
    }
  }
  for (let start = clean.indexOf('['); start >= 0; start = clean.indexOf('[', start + 1)) {
    for (let end = clean.length; end > start; end--) {
      try { return JSON.parse(clean.slice(start, end)); } catch { /* continue */ }
    }
  }
  throw new Error('応答からJSONを抽出できませんでした');
}

// ============================================================
//  コア機能
// ============================================================

/**
 * インタビュー質問を生成する
 * @param {object} opts
 * @param {string} opts.topic — テーマ
 * @param {string} opts.persona — 対象ペルソナ
 * @param {object} llm — createLlmClient の戻り値
 * @returns {Promise<object[]>} 質問配列 [{ category, number, question }]
 */
export async function generateQuestions({ topic = '展示会ブース制作', persona = '施工スタッフ' }, llm) {
  const messages = buildQuestionsPrompt({ topic, persona });
  const res = await llm({ provider: DEFAULT_PROVIDER, messages, maxTokens: 4000 });
  const parsed = extractJson(res.text);
  const questions = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed.questions) ? parsed.questions
    : Array.isArray(parsed.interview_questions) ? parsed.interview_questions
    : Array.isArray(parsed.questions_list) ? parsed.questions_list
    : [];
  if (!questions.length) throw new Error('質問の抽出に失敗しました');
  return questions;
}

/**
 * インタビュー回答から記事を生成する
 * @param {object} opts
 * @param {object[]} opts.qaPairs — [{ question, answer }]
 * @param {string} opts.topic — テーマ
 * @param {string} opts.articleType — success|knowhow|failure|trend|interview
 * @param {object} llm — createLlmClient の戻り値
 * @returns {Promise<object>} 記事オブジェクト { title, lead, sections, faq, metadata }
 */
export async function generateArticle({ qaPairs, topic = '展示会ブース制作', articleType = 'success' }, llm) {
  const messages = buildArticlePrompt({ qaPairs, topic, articleType });
  const res = await llm({ provider: DEFAULT_PROVIDER, messages, maxTokens: 6000 });
  const parsed = extractJson(res.text);
  if (!parsed.title) throw new Error('記事の抽出に失敗しました');
  return parsed;
}

/**
 * サンプルデータ（ブース制作スタッフ想定の模擬QA）
 * @returns {object[]}
 */
export function sampleQaPairs() {
  return [
    { question: 'あなたが携わった展示会ブース制作の中で、最も反響が大きかった案件は何ですか？', answer: '2025年秋の「メディカルエキスポ東京」でのブースです。6小間（約36㎡）で、予算は800万円。来場者アンケートで「最も印象に残ったブース」に選ばれ、その場で3件の商談が成立しました。' },
    { question: 'そのブースで特にこだわったポイントは何ですか？ なぜそれが重要だったのですか？', answer: 'LED照明のグラデーション制御です。医療業界向けなので清潔感と先進性が求められ、天井に間接照明のグラデーションを施すことで、白を基調としつつも無機質にならない空間を作りました。来場者の滞在時間が平均2.3倍に伸びたのがデータで確認できました。' },
    { question: '初めてブース制作を担当したときのクライアントの要望と実際に提供したものを教えてください。', answer: '初担当は2022年の「フードテックジャパン」、クライアントは植物性代替食品のスタートアップでした。要望は「予算300万円で存在感を出したい」。予算の範囲内で壁面全面にプロジェクションマッピングを提案し、小規模ながら来場者が列を作るブースになりました。' },
    { question: 'これまでで最も短期間で制作した案件とそのスケジュールを教えてください。', answer: '2024年の「ビューティーウィーク大阪」で、着手から搬入までなんと2週間。通常は2〜3ヵ月かかるところ、既存のモジュール什器を組み合わせるハイブリッド手法で乗り切りました。残業は増えましたが、クライアントの緊急ニーズに応えられて以降リピート契約につながりました。' },
    { question: '予算が限られていた案件で最大の効果を出した工夫は？', answer: '2023年の「地方建設EXPO」で予算150万円。全面印刷パネルを諦めて、塗装済み合板にスポットライトを当てる「素材見せ」スタイルに。かえって建設業界の「素材感」にマッチし、周辺の華美なブースより目立ったと好評でした。' },
    { question: 'ブース設営中または設営後に想定外のトラブルが発生した事例を教えてください。', answer: '2024年の「ITソリューションフェア」で、搬入前日にクライアントから「社名が変わるので全ロゴを差し替えてほしい」と連絡がありました。印刷会社と翌朝6時からの特急対応で合意し、設営開始前の8時には全パネルを貼り替えました。通常の2.5倍のコストはかかりましたが、本番に間に合いました。' },
    { question: 'クライアントとの認識齟齬で苦労した経験はありますか？', answer: 'デザインの「シンプルに」の解釈の違いです。こちらはミニマルな和風デザインを提案したら、クライアントは「シンプル＝白い壁だけ」を想定していて初回プレゼンで不合格に。その後、参考写真を10枚以上共有してもらうプロセスを組み込み、以降は解消しました。' },
    { question: '搬入・搬出で最も大変だったケースを教えてください。', answer: '2023年の「国際物流EXPO」で、会場の搬入口が幅2.2mしかなく、設計した3.6mの大型オブジェが通らず、現地で解体→搬入→再組み立てを3時間で行いました。この経験から、設計段階で会場の搬入制約を必ず確認するルールができました。' },
    { question: 'ブースのデザインと施工性の間で妥協せざるを得なかったポイントは？', answer: '天井からの吊り下げ構造です。デザイン的には天井全体に照明付きのグリッドを吊りたかったが、会場の吊り上限重量の制限で実現できず、代わりに自立型のアルミフレーム構造に変更しました。結果的に設営時間が半減し、コストも15%削減できました。' },
    { question: '過去に「これは失敗だった」と振り返る案件はありますか？', answer: '2022年最初期の案件で、デザインを優先しすぎて搬入3日前に施工性の問題が発覚し、徹夜で修正した案件です。デザインと施工のすり合わせを設計段階で行う重要性を痛感し、以降は必ず施工担当者がデザインレビューに参加するルールを設けました。このルールは今も続いています。' },
    { question: '担当した案件の平均的な工期は何日くらいですか？', answer: '平均工期は設計着手から搬入まで約65日です。最短は前述の2週間、最長は国際展示場の大型案件で約4ヵ月でした。規模にもよりますが、標準的な3小間ブースで45〜60日が目安です。' },
    { question: 'ブース1小間あたりの平均的な予算帯と、予算によって変わる要素を教えてください。', answer: '1小間（2.7m×2.7m）あたりの予算帯は80〜200万円が標準です。100万円以下はパネル＋照明の基本構成、100〜150万円で簡易什器＋グラフィック充実、150万円以上で映像演出や特殊素材が可能になります。予算が倍になると単なる規模拡大ではなく演出の幅が質的に変わります。' },
    { question: 'リピート率など営業的な数字で意識している指標はありますか？', answer: 'リピート率は約60%です。展示会出展企業の約30%は翌年出展しないと言われる中で、高い水準だと思います。特に初回案件の満足度がリピートに直結するため、初回は採算度外視で品質にこだわる方針です。' },
    { question: '年間で何件のブースを担当していますか？', answer: '担当者1人あたり年間15〜20件です。そのうち新規が約40%、リピートが約60%です。繁忙期は9月〜11月と2月〜3月の年2回で、この時期は同時に3〜4件を並行して進めることもあります。' },
    { question: '東京ビッグサイトとインテックス大阪で、設営のしやすさ・制約・費用の違いを教えてください。', answer: 'ビッグサイトは天井高が高く（最大15m）大型演出が可能な反面、搬入車両の規制が厳しく時間制限があります。インテックス大阪は搬入が比較的スムーズで、地方開催のため施工スタッフの宿泊費が別途かかります。トータルコストでは首都圏の方が搬出入の人件費は高い傾向です。' },
    { question: '10年前のブースと最近のブースで、最も変わったと感じる点は？', answer: 'LED性能の向上とコスト低下が最大の変化です。10年前はLEDパネル自体が高額で一部の大規模ブースだけのものでしたが、今は3小間クラスでも有機ELモニターやインタラクティブなLED演出が標準的になっています。サステナブル素材への関心も5年前と比べて格段に高まりました。' },
    { question: '国内展示会と海外展示会のブース制作で、最も異なる点は何ですか？', answer: '海外、特に欧州の展示会はモジュール型の再利用システムが標準化されており、毎回スクラッチで設計する国内とは考え方が根本的に異なります。向こうは「次も使い回す」を前提に設計するため初期コストは高くても長期で見ると経済的です。日本でもこの考え方が徐々に広がっています。' },
    { question: '小規模ブースと大規模ブースで、設計・施工の考え方の違いは？', answer: '小規模ブース（1〜2小間）は「いかに限られた面積で目立つか」が全てで、視線誘導と縦方向の演出が重要です。大規模ブース（6小間以上）は「動線設計」と「ゾーニング」が主軸で、来場者が自然に回遊したくなる導線を設計する必要があります。まったく別のスキルセットと言っていいでしょう。' },
    { question: '最近よく使われるようになった素材や技術はありますか？', answer: '軽量ハニカムパネルの普及です。従来のアルミ複合板の約半分の重量で、大型演出が可能になりました。デジタルサイネージとインタラクティブ技術の組み合わせも増えており、タッチパネルで製品情報を表示するケースが一般的になっています。' },
    { question: '展示会業界全体のトレンドとして、この1〜2年で大きく変わったことは？', answer: 'サステナビリティへの意識の高まりが最大です。ワンウェイ（使い捨て）のブースから、リユース可能なモジュール型への移行が加速しています。カーボンフットプリントの開示を求めるクライアントも増え、2025年からは当社でも標準でCO2削減試算を提案に含めるようになりました。' },
    { question: 'AIやデジタルツールでブース制作の仕事がどう変わった／変わると予想しますか？', answer: 'AIによるブースレイアウトの自動生成が現場にも入ってきています。まだ最終判断は人間ですが、初期案の作成時間が3分の1に短縮されました。将来的には来場者の属性データに基づくリアルタイム演出最適化（混雑状況に応じたコンテンツ切替等）が標準になると思います。' },
    { question: 'これから展示会に出展を考えている企業に最初に伝えたいアドバイスは何ですか？', answer: '「ブースはゴールではなくスタート」という認識を持ってほしいです。ブースで集めたリードをどうフォローアップするか、展示会後のプロセスまで設計しておかないと、どれだけ良いブースを作っても成果につながりません。具体的には、ブース設計と同時にアフターフォローのシナリオも決めておくことをお勧めします。' },
    { question: '展示会ブース制作会社を選ぶときに見るべきポイントを3つ挙げてください。', answer: '1つ目は「施工実績の写真と詳細」— 事例集があるかどうかではなく、その制作プロセスまで説明できるかを確認すべきです。2つ目は「デザインと施工の両方に対応しているか」— デザインだけ外注している会社はトラブル時の対応が遅れます。3つ目は「展示会後のサポート」— 撤去や保管、次回への活用提案まで含めて提案してくれる会社が信頼できます。' },
  ];
}

// ============================================================
//  CLI処理
// ============================================================

function printHelp() {
  console.log([
    'X-0033: 質問抽出で一次情報コンテンツ作成 — 専門家インタビュー質問生成＆記事生成ツール',
    '',
    '使い方:',
    '  node tools/interview-article-gen.mjs --mode questions --topic <テーマ> [--persona <対象>]',
    '  node tools/interview-article-gen.mjs --mode article --answers <file.json> [--output <file.md>]',
    '  node tools/interview-article-gen.mjs --sample',
    '',
    'オプション:',
    '  --mode questions   インタビュー質問を生成（既定）',
    '  --mode article     回答からSEO記事を生成',
    '  --topic <テーマ>   テーマ（例: 展示会ブース制作）',
    '  --persona <対象>   対象ペルソナ（例: 施工スタッフ）',
    '  --answers <file>   回答JSONファイルのパス',
    '  --type <type>      記事タイプ: success|knowhow|failure|trend|interview',
    '  --output <file>    出力先ファイル',
    '  --sample           サンプル実行',
    '  --help             このヘルプを表示',
    '',
    '環境変数:',
    '  LLM_PROVIDER       LLMプロバイダ (既定: deepseek)',
    '',
    'X-0045: docs/ai-news-x0045-expert-question-article.md',
  ].join('\n'));
}

/** 記事をMarkdown形式に変換 */
export function articleToMarkdown(article) {
  const { title, lead, sections, faq, metadata } = article;
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> ${lead}`);
  lines.push('');
  if (sections) {
    for (const section of sections) {
      lines.push(`## ${section.heading}`);
      lines.push('');
      lines.push(section.body);
      lines.push('');
    }
  }
  if (faq && faq.length) {
    lines.push('## よくある質問');
    lines.push('');
    for (const item of faq) {
      lines.push(`### ${item.question}`);
      lines.push('');
      lines.push(item.answer);
      lines.push('');
    }
  }
  if (metadata) {
    lines.push('---');
    lines.push('');
    lines.push('**メタデータ**');
    lines.push('');
    lines.push(`- メタdescription: ${metadata.description}`);
    lines.push(`- キーワード: ${metadata.keywords?.join(', ') || ''}`);
  }
  return lines.join('\n');
}

export async function main(args) {
  const llm = createLlmClient();

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.includes('--sample')) {
    console.log('=== X-0033 サンプル実行: インタビュー回答→記事生成 ===\n');
    const qaPairs = sampleQaPairs();
    console.log(`サンプルQA数: ${qaPairs.length}問\n`);
    const article = await generateArticle({ qaPairs, topic: '展示会ブース制作', articleType: 'success' }, llm);
    const md = articleToMarkdown(article);
    console.log(md);
    return;
  }

  const mode = args.includes('--mode')
    ? args[args.indexOf('--mode') + 1]
    : 'questions';
  const topic = args.includes('--topic')
    ? args[args.indexOf('--topic') + 1]
    : '展示会ブース制作';
  const persona = args.includes('--persona')
    ? args[args.indexOf('--persona') + 1]
    : '施工スタッフ';

  if (mode === 'questions') {
    console.log(`「${topic}」のインタビュー質問を生成中...\n`);
    const questions = await generateQuestions({ topic, persona }, llm);
    for (const q of questions) {
      console.log(`【${q.category}】Q${q.number}: ${q.question}\n`);
    }
    console.log(`---\n合計: ${questions.length}問`);
    return;
  }

  if (mode === 'article') {
    const answersFile = args.includes('--answers')
      ? args[args.indexOf('--answers') + 1]
      : null;
    if (!answersFile) throw new Error('--answers <file> が必要です');
    const articleType = args.includes('--type')
      ? args[args.indexOf('--type') + 1]
      : 'success';
    const raw = JSON.parse(fs.readFileSync(answersFile, 'utf-8'));
    const qaPairs = Array.isArray(raw) ? raw
      : Array.isArray(raw.qaPairs) ? raw.qaPairs
      : Array.isArray(raw.interviews) ? raw.interviews
      : Array.isArray(raw.answers) ? raw.answers
      : [];
    if (!qaPairs.length) throw new Error('回答データが空か不正です');
    console.log(`${qaPairs.length}件の回答から記事を生成中...\n`);
    const article = await generateArticle({ qaPairs, topic, articleType }, llm);
    const md = articleToMarkdown(article);
    const outputFile = args.includes('--output')
      ? args[args.indexOf('--output') + 1]
      : null;
    if (outputFile) {
      fs.writeFileSync(outputFile, md, 'utf-8');
      console.log(`✅ 記事を出力しました: ${outputFile}`);
    } else {
      console.log(md);
    }
    return;
  }

  throw new Error(`不明なモード: ${mode}`);
}

// ============================================================
//  エントリポイント
// ============================================================

if (isEntry(import.meta)) {
  main(process.argv.slice(1)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}