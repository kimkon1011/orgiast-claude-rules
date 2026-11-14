"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Mail, RefreshCw } from "lucide-react";
import type { EmailDraft, LeadScore, Visitor } from "@/app/types";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type Props = {
  visitor: Visitor;
  conversationText: string;
  scores: LeadScore | null;
  onEmailGenerated: (email: EmailDraft) => void;
  initialEmail?: EmailDraft | null;
};

export function EmailPreview({ visitor, conversationText, scores, onEmailGenerated, initialEmail = null }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState<EmailDraft | null>(initialEmail);
  const [copied, setCopied] = useState(false);
  const request = useRef<AbortController | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { request.current?.abort(); if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  async function handleGenerate() {
    if (!conversationText.trim() || !scores) {
      setError("先に会話の記録とリード評価を行ってください。");
      return;
    }

    setLoading(true);
    setError("");
    setCopied(false);
    const controller = new AbortController();
    request.current = controller;
    try {
      const res = await fetch("/api/email", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visitorId: visitor.id,
          visitorName: visitor.name,
          company: visitor.company,
          conversationText,
          scores,
        }),
      });
      if (!res.ok) throw new Error("メール文面の生成に失敗しました");
      const data = (await res.json()) as EmailDraft;
      if (controller.signal.aborted) return;
      setEmail(data);
      onEmailGenerated(data);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "メール文面の生成に失敗しました");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function handleCopy() {
    if (!email) return;
    try {
      const text = `件名: ${email.subject}\n\n${email.body}`;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("クリップボードへのコピーに失敗しました");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-emerald-600" />
          フォローアップメール案
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!email && !loading && (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              会話内容とリードスコアをもとに、フォローアップメールの文面を自動生成します。
            </p>
            {!scores && <p className="text-sm text-amber-700">先にリード評価を行ってください。</p>}
            <Button onClick={handleGenerate} disabled={!scores || !conversationText.trim()}>
              メール文面を生成
            </Button>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
            <span className="ml-3 text-sm text-slate-500">メール文面を生成中…</span>
          </div>
        )}

        {email && (
          <>
            {/* 件名 */}
            <div className="rounded-xl border bg-white p-4">
              <p className="mb-2 text-xs font-medium text-slate-400">件名</p>
              <p className="text-sm font-semibold text-slate-800">
                {email.subject}
              </p>
            </div>

            {/* 本文 */}
            <div className="rounded-xl border bg-white p-4">
              <p className="mb-2 text-xs font-medium text-slate-400">本文</p>
              <pre className="whitespace-pre-wrap break-all text-sm leading-relaxed text-slate-700">
                {email.body}
              </pre>
            </div>

            {/* アクションボタン */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={handleCopy}
                className="gap-2"
                disabled={copied}
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-600" />
                    コピーしました
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    クリップボードにコピー
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={handleGenerate}
                disabled={loading}
                className="gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                再生成
              </Button>
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
