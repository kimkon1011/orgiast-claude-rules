import { NextResponse } from "next/server";
import { isObject, isText } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 業界別のキーワード辞書 */
const keywordDict = {
  interest: [
    "興味", "いいですね", "導入", "検討", "欲しい", "見てみたい",
    "試したい", "魅力", "期待", "面白い", "役立ちそう", "具体的に",
    "デモ", "見積もり", "サンプル", "詳細", "事例", "参考",
  ],
  budget: [
    "予算", "コスト", "費用", "価格", "値段", "いくら", "予算感",
    "月額", "イニシャル", "ランニング", "安い", "高い", "予算内",
    "費用対効果", "投資", "ROI", "コストパフォーマンス",
  ],
  authority: [
    "決裁", "決定", "決める", "判断", "上長", "社長", "役員",
    "承認", "権限", "責任者", "担当", "私が決めます", "私が判断",
    "予算権限", "稟議", "決裁権限",
  ],
  timeline: [
    "来月", "今月", "来週", "今週", "早急", "急ぎ", "すぐに",
    "できるだけ早く", "今期中", "年度内", "来年度", "半年以内",
    "スケジュール", "導入時期", "納期", "いつまでに", "タイムライン",
    "リリース", "展開", "来期", "ロードマップ",
  ],
};

function countKeywords(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
}

function scoreFromHits(hits: number): number {
  if (hits === 0) return 2;
  if (hits === 1) return 5;
  if (hits === 2) return 7;
  if (hits === 3) return 9;
  return 10;
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);

    if (!isObject(body) || !isText(body.visitorId, 500) || !isText(body.conversationText)) {
      return NextResponse.json(
        { message: "来場者IDと会話テキスト（20,000文字以内）を入力してください。" },
        { status: 400 }
      );
    }

    const conversationText = body.conversationText.normalize("NFKC");

    const interestHits = countKeywords(conversationText, keywordDict.interest);
    const budgetHits = countKeywords(conversationText, keywordDict.budget);
    const authorityHits = countKeywords(conversationText, keywordDict.authority);
    const timelineHits = countKeywords(conversationText, keywordDict.timeline);

    // Negative/uncertain statements take precedence over simple keyword matches.
    const interest = /興味.{0,3}(ない|ありません)|関心.{0,3}(ない|ありません)|導入.{0,3}(しない|予定なし)/.test(conversationText) ? 1 : scoreFromHits(interestHits);
    const budget = /予算.{0,5}(ない|なし|未定|未確保|ありません)|高すぎ/.test(conversationText) ? 1 :
      /予算.{0,12}(確保済|承認済|確保して)|\d+\s*万円/.test(conversationText) ? 8 : scoreFromHits(budgetHits);
    const authority = /(決裁|決定|権限).{0,5}(ない|なし|ありません)|上長.{0,8}(確認|承認|決裁|相談)/.test(conversationText) ? 2 :
      /私が.{0,4}(決め|決裁|決定)|決裁権.{0,5}(ある|あります|持)/.test(conversationText) ? 9 : scoreFromHits(authorityHits);
    const timeline = /(時期|予定).{0,5}(未定|ない|なし)|情報収集|来年以降/.test(conversationText) ? 2 :
      /(今月|来月|今週|来週|早急|すぐに)/.test(conversationText) ? 9 : scoreFromHits(timelineHits);

    const overallScore = Math.round((interest + budget + authority + timeline) / 4);
    const totalHits = interestHits + budgetHits + authorityHits + timelineHits;

    let recommendation: string;
    let summary: string;

    if (overallScore >= 8) {
      recommendation = "☆☆☆☆☆ 優先フォロー — 今すぐアポイント調整";
      summary = `高い関心と購買意欲が確認されました。${interestHits}個の関心語、${budgetHits}個の予算関連語が検出されました。至急フォローアップが必要です。`;
    } else if (overallScore >= 6) {
      recommendation = "★★★★ フォロー推奨 — 1週間以内に連絡";
      summary = `有望な見込み客です。${totalHits}個のキーワードが検出されました。継続的なフォローアップで成約が期待できます。`;
    } else if (overallScore >= 4) {
      recommendation = "★★★ ウォーム — 資料送付・育成";
      summary = `ある程度の関心が見られます。${totalHits}個のキーワードが検出されました。追加情報の提供で関心を育てましょう。`;
    } else if (overallScore >= 2) {
      recommendation = "★★ コールド — 今後の育成リスト";
      summary = `関心は低めですが、${conversationText.length > 50 ? "一定の会話はありました。定期的な情報配信で関係構築を。" : "会話が短いため判断できません。名刺交換の確認を。"}`;
    } else {
      recommendation = "★ 未評価 — 情報不足";
      summary = "スコアリングに十分な会話データがありません。次回の接触時に詳しくヒアリングしましょう。";
    }

    return NextResponse.json({
      scores: { interest, budget, authority, timeline },
      overallScore,
      recommendation,
      summary: `キーワードによる参考評価です。未言及の項目は低めに評価しています。${summary}`,
    });
  } catch {
    return NextResponse.json(
      { message: "スコアリング中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
