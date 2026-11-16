#!/usr/bin/env node
/**
 * Gemini Decision 1 デモスクリプト
 *
 * 3 つのユースケースで Gemini Decisions API を試す：
 * 1. 問い合わせ分類（noul + choice）
 * 2. ブース仕様確認（noul 複数）
 * 3. 顧客要件合致チェック（noul + score）
 *
 * 使い方:
 *   export GEMINI_API_KEY="your-key-here"
 *   node apps/decisions-demo/decisions-demo.mjs
 *
 * 必要な依存:
 *   npm install @google/genai
 */

import { GoogleGenAI } from "@google/genai";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("エラー: GEMINI_API_KEY 環境変数が設定されていません。");
  console.error("  export GEMINI_API_KEY=\"your-key-here\"");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiVersion: "v1beta" });

/**
 * Gemini Decisions API を呼び出す
 */
async function runDecisions({ input, questions, label }) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`【${label}】`);
  console.log(`入力: "${input.slice(0, 80)}..."`);
  console.log(`質問: ${Object.keys(questions).join(", ")}`);
  console.log("-".repeat(60));

  try {
    const result = await ai.decisions.create({
      model: "gemini-decision-1",
      input,
      questions,
    });

    const answers = result.answers || {};
    for (const [key, answer] of Object.entries(answers)) {
      console.log(`\n  ▼ ${key}:`);
      switch (answer.type) {
        case "noul":
          console.log(`    Yes/No: ${(answer.noul * 100).toFixed(1)}%`);
          console.log(`    確信度: ${(answer.confidence * 100).toFixed(1)}%`);
          break;
        case "choice":
          console.log(`    選択: ${answer.choice}`);
          console.log(`    確信度: ${(answer.confidence * 100).toFixed(1)}%`);
          if (answer.probabilities) {
            for (const [opt, prob] of Object.entries(answer.probabilities)) {
              console.log(`      ${opt}: ${(prob * 100).toFixed(1)}%`);
            }
          }
          break;
        case "score":
          console.log(`    スコア: ${answer.score}`);
          console.log(`    確信度: ${(answer.confidence * 100).toFixed(1)}%`);
          if (answer.probabilities) {
            for (const [level, prob] of Object.entries(answer.probabilities)) {
              console.log(`      ${level}: ${(prob * 100).toFixed(1)}%`);
            }
          }
          break;
      }
    }

    console.log(`\n  使用トークン: ${result.usage?.total_tokens || "N/A"} (出力: ${result.usage?.total_output_tokens || 0})`);
    return answers;
  } catch (error) {
    console.error(`  ✗ エラー: ${error.message}`);
    if (error.status === 403) {
      console.error("  API キーが無効か、Decision API へのアクセス権限がありません。");
    }
    return null;
  }
}

/**
 * ユースケース 1: 問い合わせ自動分類
 */
async function demonstrateInquiryClassification() {
  const inquiries = [
    {
      label: "ケースA: 見積依依頼（緊急）",
      text: "展示会のブースを予約したいのですが、3m×3mの小間で11月20日からの展示会に参加可能でしょうか。予算は30万円以内で考えています。なるべく早く見積もりをお願いします。",
    },
    {
      label: "ケースB: キャンセル連絡",
      text: "先日申し込んだ12月の展示会ですが、都合によりキャンセルさせていただきたく存じます。キャンセル料が発生する場合はお知らせください。",
    },
    {
      label: "ケースC: ブース仕様に関する質問",
      text: "来年の大阪展示会に出展予定です。ブースの背面壁に大型モニターを設置したいのですが、設置可能な重量制限と電源容量を教えてください。また、吊り下げ看板の高さ制限も併せてお願いします。",
    },
  ];

  const questions = {
    is_estimate_request: {
      type: "noul",
      instructions: "この問い合わせは見積依頼を含んでいますか？",
    },
    is_cancellation: {
      type: "noul",
      instructions: "この問い合わせはキャンセル連絡ですか？",
    },
    is_urgent: {
      type: "noul",
      instructions: "この問い合わせは緊急対応が必要ですか？（開催日が2週間以内、または「早急」「なるべく早く」などの表現がある）",
    },
    inquiry_category: {
      type: "choice",
      choices: ["見積依頼", "在庫確認", "キャンセル", "ブース仕様", "その他"],
      instructions: "この問い合わせの種別を選んでください。",
    },
  };

  for (const inquiry of inquiries) {
    await runDecisions({
      input: inquiry.text,
      questions,
      label: `問い合わせ分類: ${inquiry.label}`,
    });
  }
}

/**
 * ユースケース 2: ブース仕様 PDF 確認（テキスト代替）
 */
async function demonstrateBoothSpecCheck() {
  const specs = [
    {
      label: "ケースA: 条件適合",
      text: `ブース仕様書
会場: 東京ビッグサイト 東展示ホール
小間番号: A-12
サイズ: 間口 3.6m × 奥行 3.6m × 高さ 2.5m
重量制限: 床耐荷重 500kg/m²
電源: 単相100V 1.5kVA（ブレーカー付き）
備考: 吊り看板不可、壁面への穴あけ禁止`,
    },
    {
      label: "ケースB: 条件不適合（高さ超過）",
      text: `ブース仕様書
会場: インテックス大阪 4号館
小間番号: B-8
サイズ: 間口 5.4m × 奥行 5.4m × 高さ 4.2m
重量制限: 床耐荷重 300kg/m²
電源: 三相200V 3.0kVA
備考: 2階建てブースの場合は構造計算書提出必須`,
    },
  ];

  const questions = {
    width_within_limit: {
      type: "noul",
      instructions: "間口（横幅）は 3.6m 以内ですか？",
    },
    depth_within_limit: {
      type: "noul",
      instructions: "奥行きは 3.6m 以内ですか？",
    },
    height_within_limit: {
      type: "noul",
      instructions: "高さは 2.5m 以内ですか？",
    },
    weight_within_limit: {
      type: "noul",
      instructions: "床耐荷重は 500kg/m² 以上ですか？",
    },
    power_sufficient: {
      type: "noul",
      instructions: "電源容量は 1.5kVA 以上確保されていますか？",
    },
    all_conditions_met: {
      type: "noul",
      instructions: "上記の全条件を満たしていますか？（幅3.6m以内、奥行3.6m以内、高さ2.5m以内、耐荷重500kg/m²以上、電源1.5kVA以上）",
    },
  };

  for (const spec of specs) {
    await runDecisions({
      input: spec.text,
      questions,
      label: `ブース仕様確認: ${spec.label}`,
    });
  }
}

/**
 * ユースケース 3: 顧客要件合致チェック
 */
async function demonstrateRequirementMatching() {
  const cases = [
    {
      label: "ケースA: 要件合致",
      text: `【顧客要件】
- イベント名: テックイノベーションフェア2027
- 会期: 2027年2月15日〜17日
- 予算: 200万円以内
- 必須要件: 15台のPC展示スペース、商談スペース（6席）、大型モニター85インチ以上×2台、電源15口以上
- 希望: 来場者に配布するノベルティの制作

【自社提案】
- 特設ブース 9小間（9m×5.4m）
- PC展示カウンター × 15台分、商談テーブル6席
- 85インチモニター × 2台、65インチモニター × 1台
- 電源タップ15口＋床下配線
- ノベルティ制作費込み
- 提案金額: 180万円`,
    },
    {
      label: "ケースB: 予算超過・要件一部未達",
      text: `【顧客要件】
- イベント名: 関西食品見本市
- 会期: 2027年3月5日〜6日
- 予算: 100万円以内
- 必須要件: 試食コーナー（冷蔵設備必須）、調理実演スペース、商談スペース4席
- 希望: ブランドイメージに合った木目調の内装

【自社提案】
- 小間ブース 2小間（3.6m×3.6m）
- 試食カウンター、冷蔵ショーケース1台
- 調理実演台、IH調理器2口
- 商談テーブル4席
- 木目調パネル装飾
- 提案金額: 150万円`,
    },
  ];

  const questions = {
    within_budget: {
      type: "noul",
      instructions: "提案金額は顧客の予算範囲内ですか？",
    },
    schedule_matches: {
      type: "noul",
      instructions: "会期（日程）に合致する提案ですか？",
    },
    mandatory_requirements_met: {
      type: "noul",
      instructions: "顧客の必須要件をすべて満たしていますか？",
    },
    priority_level: {
      type: "score",
      legend: ["低", "中", "高"],
      instructions: "この提案の総合適合度を評価してください。",
    },
  };

  for (const c of cases) {
    await runDecisions({
      input: c.text,
      questions,
      label: `顧客要件合致チェック: ${c.label}`,
    });
  }
}

/**
 * メイン
 */
async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Gemini Decision 1 デモスクリプト                    ║");
  console.log("║  出力トークン課金ゼロ × 3ユースケース                ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  await demonstrateInquiryClassification();
  await demonstrateBoothSpecCheck();
  await demonstrateRequirementMatching();

  console.log(`\n${"=".repeat(60)}`);
  console.log("全デモ完了。");
  console.log("注意: 上記は v1beta API の試験的な使用例です。");
  console.log("本番適用は Google の GA リリース後に行ってください。");
}

main().catch((err) => {
  console.error("予期しないエラー:", err);
  process.exit(1);
});
