"use client";

import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import type { ConversationAudio } from "@/app/types";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
type Props = {
  initialText?: string;
  audio: ConversationAudio | null;
  active: boolean;
  onAudioChange: (audio: ConversationAudio | null) => void;
  onTranscription: (text: string) => void;
};

export function AudioRecorder({ initialText = "", audio, active, onAudioChange, onTranscription }: Props) {
  const [status, setStatus] = useState<"idle" | "starting" | "recording" | "stopping">("idle");
  const [audioUrl, setAudioUrl] = useState("");
  const [text, setText] = useState(initialText);
  const [transcribing, setTranscribing] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const recognized = useRef("");
  const mounted = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const pendingStart = useRef(false);
  const abortRequest = useRef<AbortController | null>(null);
  const audioCallback = useRef(onAudioChange);
  audioCallback.current = onAudioChange;
  const latestBlob = useRef<Blob | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRequest.current?.abort();
      if (recognition.current) {
        recognition.current.onend = null;
        recognition.current.onresult = null;
        recognition.current.onerror = null;
        recognition.current.abort();
      }
      const current = recorder.current;
      if (current) {
        current.onstop = null;
        current.ondataavailable = null;
        current.onerror = null;
        if (current.state !== "inactive") current.stop();
        current.stream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (!audio) { setAudioUrl(""); return; }
    const url = URL.createObjectURL(audio.blob);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audio]);

  function stopRecording() {
    if (recorder.current?.state === "recording") {
      setStatus("stopping");
      recorder.current.stop();
      recognition.current?.stop();
    }
  }

  useEffect(() => {
    if (!active) stopRecording();
  }, [active]);

  async function startRecording() {
    if (pendingStart.current || recorder.current?.state === "recording") return;
    pendingStart.current = true;
    setStatus("starting");
    setError("");
    let stream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("この環境は録音に対応していません。HTTPSまたはlocalhostで開くか、会話メモを入力してください。");
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || !activeRef.current) {
        stream.getTracks().forEach(track => track.stop());
        if (mounted.current) setStatus("idle");
        return;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      const current = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.current = current;
      const chunks: Blob[] = [];
      recognized.current = "";
      latestBlob.current = null;
      current.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      current.onstop = () => {
        current.stream.getTracks().forEach(track => track.stop());
        recognition.current?.stop();
        if (!mounted.current) return;
        const blob = new Blob(chunks, { type: current.mimeType || chunks[0]?.type || "audio/webm" });
        latestBlob.current = blob;
        audioCallback.current({ blob, recognizedText: recognized.current });
        setStatus("idle");
      };
      current.onerror = () => {
        current.stream.getTracks().forEach(track => track.stop());
        recognition.current?.abort();
        setStatus("idle");
        setError("録音に失敗しました。会話メモを入力してください。");
      };
      current.start(1000);
      setStatus("recording");
      audioCallback.current(null);

      const speechWindow = window as SpeechWindow;
      const Speech = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
      if (!Speech) {
        setError("音声認識はこのブラウザでは使えません。録音を再生して会話メモを入力してください。");
        return;
      }
      try {
        const speech = new Speech();
        recognition.current = speech;
        speech.lang = "ja-JP";
        speech.continuous = true;
        speech.interimResults = false;
        speech.onresult = event => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) recognized.current += event.results[i][0].transcript;
          }
          if (latestBlob.current) audioCallback.current({ blob: latestBlob.current, recognizedText: recognized.current });
        };
        speech.onerror = () => {
          setError("音声認識に失敗しました。録音は継続できます。会話メモを入力してください。");
        };
        speech.onend = () => { if (mounted.current) setRecognizing(false); };
        speech.start();
        setRecognizing(true);
      } catch {
        setRecognizing(false);
        setError("音声認識を開始できませんでした。会話メモを入力してください。");
      }
    } catch (caught) {
      stream?.getTracks().forEach(track => track.stop());
      if (mounted.current) {
        setStatus("idle");
        setError(caught instanceof Error && caught.name !== "NotAllowedError" ? caught.message : "マイクの使用を許可するか、会話メモを入力してください。");
      }
    } finally { pendingStart.current = false; }
  }

  async function transcribe() {
    if (!audio) return;
    setTranscribing(true);
    setError("");
    const controller = new AbortController();
    abortRequest.current = controller;
    try {
      const data = new FormData();
      data.append("audio", audio.blob, "recording");
      data.append("transcript", audio.recognizedText);
      const response = await fetch("/api/transcribe", { method: "POST", body: data, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "文字起こしに失敗しました。");
      if (!mounted.current) return;
      setText(result.transcript);
      onTranscription(result.transcript);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "文字起こしに失敗しました。");
    } finally { if (mounted.current) setTranscribing(false); }
  }

  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2"><Mic className="h-5 w-5 text-emerald-600" />会話記録</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-slate-500">録音中にブラウザの日本語音声認識を使用します。音声認識はブラウザ提供のサービスへ音声を送る場合があります。認識できない場合は手入力できます。</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={status === "recording" ? stopRecording : startRecording} disabled={status === "starting" || status === "stopping" || transcribing || (status === "idle" && recognizing)}>
          {status === "recording" ? "録音停止" : status === "starting" ? "マイクを準備中…" : status === "stopping" ? "録音を保存中…" : "録音開始"}
        </Button>
        <span role="status" className={status === "recording" ? "text-red-600" : "text-slate-500"}>{status === "recording" ? "録音中" : "停止"}</span>
      </div>
      {audioUrl && <div className="space-y-3">
        <audio controls src={audioUrl} aria-label="録音の再生" className="w-full" />
        <Button onClick={transcribe} disabled={transcribing || recognizing || status !== "idle"}>{transcribing ? "文字起こし中…" : recognizing ? "音声認識の完了待ち…" : "文字起こし"}</Button>
        <Button variant="outline" className="ml-2" onClick={() => audioCallback.current(null)} disabled={transcribing || recognizing}>録音をクリア</Button>
      </div>}
      <div>
        <label htmlFor="conversation-notes" className="text-sm font-medium">会話メモ（手入力・文字起こしの修正）</label>
        <textarea id="conversation-notes" value={text} maxLength={20000} onChange={event => { setText(event.target.value); onTranscription(event.target.value); }} rows={6} disabled={transcribing} placeholder="来場者との会話内容を入力してください…" className="mt-2 w-full rounded-lg border p-3 text-sm focus:ring-2 focus:ring-emerald-300" />
        <p className="text-xs text-slate-500">入力内容はリード評価に反映されます。録音・会話・評価・メール案はページを再読み込みすると消えるため、最後にCRMへ保存してください。</p>
      </div>
      {text && <div className="rounded-xl bg-emerald-50 p-4"><p className="text-sm font-medium">文字起こし / 会話内容</p><p className="mt-2 whitespace-pre-wrap text-sm">{text}</p></div>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>}
    </CardContent>
  </Card>;
}
