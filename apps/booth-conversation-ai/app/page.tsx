"use client";

import { useEffect, useState } from "react";
import {
  Download,
  Mail,
  Menu,
  MessageSquareText,
  Mic,
  Plus,
  Target,
  Users,
  X,
} from "lucide-react";
import type { ConversationAudio, CrmExportResult, EmailDraft, LeadScore, Visitor } from "@/app/types";
import { AudioRecorder } from "./components/audio-recorder";
import { EmailPreview } from "./components/email-preview";
import { LeadScore as LeadScoreComponent } from "./components/lead-score";
import { VisitorDetail } from "./components/visitor-detail";
import { VisitorForm } from "./components/visitor-form";
import { VisitorList } from "./components/visitor-list";
import { Button } from "./components/ui/button";

type TabKey = "detail" | "conversation" | "score" | "email" | "crm";

const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "detail", label: "来場者登録", icon: <Users className="h-4 w-4" /> },
  { key: "conversation", label: "会話記録", icon: <Mic className="h-4 w-4" /> },
  { key: "score", label: "リード評価", icon: <Target className="h-4 w-4" /> },
  { key: "email", label: "メール生成", icon: <Mail className="h-4 w-4" /> },
  { key: "crm", label: "CRM連携", icon: <Download className="h-4 w-4" /> },
];

export default function Home() {
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [selected, setSelected] = useState<Visitor | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("detail");

  // Visitor ごとの会話テキスト・スコア・メール
  const [conversations, setConversations] = useState<Record<string, string>>({});
  const [scores, setScores] = useState<Record<string, LeadScore>>({});
  const [emails, setEmails] = useState<Record<string, EmailDraft>>({});
  const [audios, setAudios] = useState<Record<string, ConversationAudio | null>>({});
  const [loadError, setLoadError] = useState("");

  const [crmExporting, setCrmExporting] = useState(false);
  const [exports, setExports] = useState<Record<string, { signature: string; result: CrmExportResult }>>({});
  const [crmErrors, setCrmErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/visitors", { signal: controller.signal })
      .then((res) => { if (!res.ok) throw new Error("来場者一覧を読み込めませんでした。"); return res.json(); })
      .then(data => { if (!controller.signal.aborted) setVisitors(data); })
      .catch(() => { if (!controller.signal.aborted) setLoadError("来場者一覧を読み込めませんでした。ページを再読み込みしてください。"); });
    return () => controller.abort();
  }, []);

  function register(visitor: Visitor) {
    setVisitors((current) => [visitor, ...current]);
    setSelected(visitor);
    setSidebarOpen(false);
    setActiveTab("detail");
  }

  function selectVisitor(visitor: Visitor) {
    setSelected(visitor);
    setSidebarOpen(false);
    setActiveTab("detail");
  }

  function handleTranscription(text: string) {
    if (!selected) return;
    setConversations((prev) => ({ ...prev, [selected.id]: text }));
    setScores(prev => { const next = { ...prev }; delete next[selected.id]; return next; });
    setEmails(prev => { const next = { ...prev }; delete next[selected.id]; return next; });
    setExports(prev => { const next = { ...prev }; delete next[selected.id]; return next; });
    setCrmErrors(prev => ({ ...prev, [selected.id]: "" }));
  }

  function handleScore(score: LeadScore) {
    if (!selected) return;
    setScores((prev) => ({ ...prev, [selected.id]: score }));
    setEmails(prev => { const next = { ...prev }; delete next[selected.id]; return next; });
    setExports(prev => { const next = { ...prev }; delete next[selected.id]; return next; });
  }

  function handleEmailGenerated(email: EmailDraft) {
    if (!selected) return;
    setEmails((prev) => ({ ...prev, [selected.id]: email }));
  }

  async function handleCrmExport() {
    if (!selected || !currentConversation.trim() || !currentScore || !currentEmail || crmExporting) return;
    const visitorId = selected.id;
    const signature = currentSignature;
    setCrmExporting(true);
    setCrmErrors(prev => ({ ...prev, [visitorId]: "" }));
    try {
      const res = await fetch("/api/crm-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visitor: selected,
          conversationText: conversations[selected.id] ?? "",
          scores: scores[selected.id] ?? null,
          emailDraft: emails[selected.id] ?? null,
        }),
      });
      if (!res.ok) throw new Error("CRM連携に失敗しました");
      const result = await res.json() as CrmExportResult;
      setExports(prev => ({ ...prev, [visitorId]: { signature, result } }));
    } catch (e) {
      setCrmErrors(prev => ({ ...prev, [visitorId]: e instanceof Error ? e.message : "CRM連携に失敗しました" }));
    } finally {
      setCrmExporting(false);
    }
  }

  const currentConversation = selected ? conversations[selected.id] ?? "" : "";
  const currentScore = selected ? scores[selected.id] ?? null : null;
  const currentEmail = selected ? emails[selected.id] ?? null : null;
  const currentSignature = JSON.stringify([currentConversation, currentScore, currentEmail]);
  const currentExport = selected ? exports[selected.id] : undefined;
  const crmExported = currentExport?.signature === currentSignature;
  const crmError = selected ? crmErrors[selected.id] : "";

  return (
    <div className="min-h-screen bg-slate-50">
      {/* モバイルヘッダー */}
      <header className="sticky top-0 z-30 flex h-16 items-center border-b bg-white px-4 lg:hidden">
        <button aria-label="メニューを開く" onClick={() => setSidebarOpen(true)}>
          <Menu />
        </button>
        <span className="ml-3 font-bold">ブース来場者受付</span>
      </header>

      {/* サイドバーオーバーレイ */}
      {sidebarOpen && (
        <button
          aria-label="メニューを閉じる"
          className="fixed inset-0 z-40 bg-slate-950/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* サイドバー */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r bg-white transition-transform lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-20 items-center gap-3 border-b px-5">
          <div className="rounded-xl bg-emerald-600 p-2 text-white">
            <MessageSquareText className="h-6 w-6" />
          </div>
          <div>
            <p className="font-bold">ブース来場者管理</p>
            <p className="text-xs text-slate-400">来場者コンシェルジュ</p>
          </div>
          <button
            className="ml-auto lg:hidden"
            aria-label="メニューを閉じる"
            onClick={() => setSidebarOpen(false)}
          >
            <X />
          </button>
        </div>

        <nav className="border-b p-4">
          <Button
            className="w-full justify-start"
            onClick={() => {
              setSelected(null);
              setActiveTab("detail");
              setSidebarOpen(false);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            新規来場者を登録
          </Button>
        </nav>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Users className="h-4 w-4" />
              登録済み来場者
            </p>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
              {visitors.length}
            </span>
          </div>
          <VisitorList
            visitors={visitors}
            selectedId={selected?.id}
            onSelect={selectVisitor}
          />
        </div>
      </aside>

      {/* メインエリア */}
      <main className="lg:pl-72">
        <div className="mx-auto max-w-5xl p-4 py-8 sm:p-8 lg:py-12">
          {/* ヘッダー */}
          <div className="mb-8">
            <p className="text-sm font-semibold text-emerald-700">
              展示会ブース受付
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
              {selected ? selected.name + " 様" : "新規来場者登録"}
            </h1>
          </div>

          {loadError && <p role="alert" className="mb-4 text-sm text-red-600">{loadError}</p>}
              {/* タブナビゲーション */}
              <nav aria-label="来場者対応の手順" className="mb-6 flex flex-wrap gap-1 rounded-xl border bg-white p-1 shadow-sm">
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    aria-current={activeTab === tab.key ? "page" : undefined}
                    disabled={!selected && tab.key !== "detail"}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-40 ${
                      activeTab === tab.key
                        ? "bg-emerald-600 text-white shadow-sm"
                        : "text-slate-500 hover:bg-slate-100"
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </nav>

          {selected ? (
            <>
              {/* タブコンテンツ */}
              <div className="mt-4">
                {activeTab === "detail" && <VisitorDetail visitor={selected} />}

                <div hidden={activeTab !== "conversation"}>
                  <AudioRecorder
                    key={selected.id}
                    initialText={currentConversation}
                    active={activeTab === "conversation"}
                    audio={audios[selected.id] ?? null}
                    onAudioChange={audio => setAudios(prev => ({ ...prev, [selected.id]: audio }))}
                    onTranscription={handleTranscription}
                  />
                </div>

                {activeTab === "score" && (
                  <LeadScoreComponent
                    key={selected.id}
                    visitorId={selected.id}
                    conversationText={currentConversation}
                    initialScore={currentScore}
                    onScore={handleScore}
                  />
                )}

                {activeTab === "email" && (
                  <EmailPreview
                    key={selected.id}
                    visitor={selected}
                    conversationText={currentConversation}
                    scores={currentScore}
                    initialEmail={currentEmail}
                    onEmailGenerated={handleEmailGenerated}
                  />
                )}

                {activeTab === "crm" && (
                  <div className="rounded-2xl border bg-white p-6 shadow-sm">
                    <h2 className="text-lg font-bold">CRM連携</h2>
                    <p className="mt-2 text-sm text-slate-500">
                      会話内容・リードスコア・メール文面を模擬CRMへ保存します。すべての項目を準備してください。
                    </p>

                    <div className="mt-6 space-y-3">
                      {/* エクスポート対象サマリー */}
                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm font-medium text-slate-600">
                          エクスポート内容
                        </p>
                        <ul className="mt-2 space-y-1 text-sm text-slate-500">
                          <li>
                            ✅ 来場者情報:
                            {selected.name}（{selected.company}）
                          </li>
                          <li>
                            会話テキスト:{" "}
                            {currentConversation
                              ? `✅ ${currentConversation.length}文字`
                              : "⚠️ 未入力"}
                          </li>
                          <li>
                            リードスコア:{" "}
                            {currentScore
                              ? `✅ ${currentScore.overallScore}/10`
                              : "⚠️ 未評価"}
                          </li>
                          <li>
                            メール文面:{" "}
                            {currentEmail ? "✅ 生成済み" : "⚠️ 未生成"}
                          </li>
                        </ul>
                      </div>

                      <Button
                        onClick={handleCrmExport}
                        disabled={crmExporting || crmExported || !currentConversation.trim() || !currentScore || !currentEmail}
                        className="w-full"
                      >
                        {crmExporting
                          ? "エクスポート中…"
                          : crmExported
                          ? "✓ CRMにエクスポート済み"
                          : "CRMにエクスポート"}
                      </Button>

                      {crmError && (
                        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
                          {crmError}
                        </p>
                      )}

                      {crmExported && (
                        <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
                          模擬CRMへの保存が完了しました。
                          保存日時：{currentExport && new Date(currentExport.result.exportedAt).toLocaleString("ja-JP")}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <VisitorForm onRegistered={register} />
          )}
        </div>
      </main>
    </div>
  );
}
