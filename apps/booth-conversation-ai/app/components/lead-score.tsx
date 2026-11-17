"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { LeadScore as LeadScoreType } from "@/app/types";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type Props = {
  visitorId: string;
  conversationText: string;
  onScore: (score: LeadScoreType) => void;
  initialScore?: LeadScoreType | null;
};

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const barWidth = `${(value / 10) * 100}%`;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="font-bold" style={{ color }}>
          {value}/10
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: barWidth, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function TrendIcon({ value }: { value: number }) {
  if (value >= 7) return <TrendingUp className="h-4 w-4 text-emerald-600" />;
  if (value >= 4) return <Minus className="h-4 w-4 text-amber-500" />;
  return <TrendingDown className="h-4 w-4 text-red-500" />;
}

const scoreColors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#16a34a"];

function getScoreColor(value: number): string {
  if (value >= 9) return scoreColors[4];
  if (value >= 7) return scoreColors[3];
  if (value >= 5) return scoreColors[2];
  if (value >= 3) return scoreColors[1];
  return scoreColors[0];
}

function ScoreGauge({ value, label }: { value: number; label: string }) {
  const color = getScoreColor(value);
  const size = 80;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 10) * circumference;

  return (
    <div className="flex flex-col items-center gap-1">
      <svg aria-hidden="true" width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#e2e8f0"
          strokeWidth={strokeWidth}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <span className="text-2xl font-bold" style={{ color }}>
        {value}
      </span>
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );
}

export function LeadScore({ visitorId, conversationText, onScore, initialScore = null }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [score, setScore] = useState<LeadScoreType | null>(initialScore);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function handleScoring() {
    if (!conversationText.trim()) {
      setError("会話テキストが空です。先に会話を記録してください。");
      return;
    }

    setLoading(true);
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId, conversationText }),
      });
      if (!res.ok) throw new Error("スコアリングに失敗しました");
      const data = (await res.json()) as LeadScoreType;
      if (controller.signal.aborted) return;
      setScore(data);
      onScore(data);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "スコアリングに失敗しました");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-emerald-600" />
          リード評価
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {!score && !loading && (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              会話のキーワードと否定表現から、ルールベースで参考スコアを算出します。先に会話を記録してください。
            </p>
            <Button onClick={handleScoring} disabled={!conversationText.trim()}>
              スコアリングを実行
            </Button>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
            <span className="ml-3 text-sm text-slate-500">分析中…</span>
          </div>
        )}

        {score && (
          <>
            {/* 全体スコアリング（ゲージ） */}
            <div className="rounded-xl bg-slate-50 p-5">
              <p className="mb-4 text-center text-sm font-medium text-slate-500">
                総合スコア
              </p>
              <div className="flex items-center justify-center gap-2">
                <span className="text-5xl font-extrabold" style={{ color: getScoreColor(score.overallScore) }}>
                  {score.overallScore}
                </span>
                <span className="text-lg text-slate-400">/ 10</span>
                <TrendIcon value={score.overallScore} />
              </div>
            </div>

            {/* 個別スコアゲージ */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <ScoreGauge value={score.scores.interest} label="関心度" />
              <ScoreGauge value={score.scores.budget} label="予算感" />
              <ScoreGauge value={score.scores.authority} label="決定権" />
              <ScoreGauge value={score.scores.timeline} label="タイムライン" />
            </div>

            {/* 個別スコアバー */}
            <div className="space-y-3 rounded-xl border p-4">
              <p className="text-xs font-medium text-slate-400">詳細スコア</p>
              <ScoreBar label="関心度" value={score.scores.interest} color={getScoreColor(score.scores.interest)} />
              <ScoreBar label="予算感" value={score.scores.budget} color={getScoreColor(score.scores.budget)} />
              <ScoreBar label="決定権" value={score.scores.authority} color={getScoreColor(score.scores.authority)} />
              <ScoreBar label="タイムライン" value={score.scores.timeline} color={getScoreColor(score.scores.timeline)} />
            </div>

            {/* レコメンデーション */}
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-bold text-emerald-800">おすすめアクション</p>
              <p className="mt-1 text-sm text-emerald-700">{score.recommendation}</p>
            </div>

            {/* サマリー */}
            <div className="rounded-xl border bg-white p-4">
              <p className="text-xs font-medium text-slate-400">サマリー</p>
              <p className="mt-1 text-sm text-slate-700">{score.summary}</p>
            </div>

            <Button variant="outline" onClick={handleScoring} disabled={loading}>
              {loading ? "再分析中…" : "再スコアリング"}
            </Button>
          </>
        )}

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
