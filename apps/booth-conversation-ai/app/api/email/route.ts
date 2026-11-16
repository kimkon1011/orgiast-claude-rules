import { NextResponse } from "next/server";
import { isDimensions, isLeadScore, isObject, isText } from "@/lib/validation";

export const runtime = "nodejs";

function extractKeywords(text: string): string[] {
  const keywords = ["AI", "デモ", "見積もり", "見積", "トライアル", "業務効率", "自動化", "連携", "納期", "予算", "システム", "導入", "事例", "運用"];
  const lower = text.toLowerCase();
  const matches = keywords.filter(keyword => lower.includes(keyword.toLowerCase()));
  if (matches.length) return matches.slice(0, 5);
  // Preserve an actual conversation excerpt for subjects outside the dictionary.
  return [text.trim().split(/[。！？\n]/).find(part => part.trim())?.trim().slice(0, 80) ?? text.trim().slice(0, 80)];
}

export async function POST(request: Request) {
  const input: unknown = await request.json().catch(() => null);
  if (!isObject(input) || !isText(input.visitorId, 500) || !isText(input.visitorName, 500) ||
      !isText(input.company, 500) || !isText(input.conversationText) ||
      (!isLeadScore(input.scores) && !isDimensions(input.scores))) {
    return NextResponse.json({ message: "来場者情報・会話テキスト・リード評価を確認してください。" }, { status: 400 });
  }
  const overall = isLeadScore(input.scores) ? input.scores.overallScore :
    Object.values(input.scores).reduce((sum, value) => sum + value, 0) / 4;
  const keywords = extractKeywords(input.conversationText);
  const nextStep = overall >= 7
    ? "お話しいただいた内容をもとに、具体的なご提案に向けたお打ち合わせができれば幸いです。ご都合のよい日時をお知らせいただけますでしょうか。"
    : overall >= 4
      ? "お話しいただいた内容に関連する情報をご案内できればと存じます。追加で確認されたい点がございましたら、お知らせください。"
      : "今後、情報が必要になりましたら、どうぞお気軽にご連絡ください。";
  const company = input.company.trim().replace(/[\r\n]+/g, " ");
  const name = input.visitorName.trim().replace(/[\r\n]+/g, " ");
  return NextResponse.json({
    subject: `【展示会ご来場のお礼】${company} ${name} 様`,
    body: `${company}\n${name} 様\n\n先日は展示会の弊社ブースにお立ち寄りいただき、誠にありがとうございました。\n\n当日は「${keywords.join("」「")}」についてお話を伺いました。貴重なお時間をいただき、重ねて御礼申し上げます。\n\n${nextStep}\n\n引き続き、どうぞよろしくお願い申し上げます。\n\n［会社名・担当者名・連絡先を記入］`,
  });
}
