import { NextResponse } from "next/server";
import { isText } from "@/lib/validation";

export const runtime = "nodejs";

// SpeechRecognition runs while recording in the browser. No server ASR/LLM is configured.
// Accept audio and its browser transcript together; never invent speech from audio bytes.
export async function POST(request: Request) {
  let data: FormData;
  try { data = await request.formData(); }
  catch { return NextResponse.json({ message: "音声をフォーム形式で送信してください。" }, { status: 400 }); }
  const audio = data.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ message: "録音データが空です。もう一度録音してください。" }, { status: 400 });
  }
  if (audio.size > 20 * 1024 * 1024) {
    return NextResponse.json({ message: "録音は20MB以内にしてください。" }, { status: 413 });
  }
  if (!/^(audio\/(webm|ogg|mp4|wav|mpeg)|video\/webm)(;|$)/i.test(audio.type)) {
    return NextResponse.json({ message: "対応していない音声形式です。" }, { status: 415 });
  }
  const transcript = data.get("transcript");
  if (!isText(transcript)) {
    return NextResponse.json({ message: "音声認識結果がありません。録音を再生し、会話メモを入力してください。" }, { status: 422 });
  }
  return NextResponse.json({ transcript: transcript.trim(), source: "browser", fileSize: audio.size });
}
