'use client';
import { useEffect, useState } from 'react';

type Watch = { id: string; label: string; deadline: string | null; status: string; verdict: string; lastCheck: string | null; detail: string };
type Data = { watches: Watch[]; recentCompleted: Watch[]; inboxAsks: { id: string; text: string; createdAt: string; from: string }[]; warnings: string[]; updatedAt: string };
const date = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '未設定';

function WatchRows({ items }: { items: Watch[] }) {
  return <ul className="space-y-3 max-h-64 overflow-y-auto">{items.map(item => <li key={item.id} className="border-b border-zinc-800 pb-2">
    <p className="text-sm font-medium">{item.label}</p>
    <p className="text-xs text-zinc-400">期限: {date(item.deadline)} ／ 判定: {item.verdict}</p>
    <p className="text-xs text-zinc-400">最終確認: {item.lastCheck ? date(item.lastCheck) : '未実行'}</p>
    {item.detail && <p className="text-xs whitespace-pre-wrap break-words mt-1">{item.detail}</p>}
  </li>)}</ul>;
}

export default function WatchesWidget() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    async function refresh() {
      controller?.abort(); controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), 20000);
      try {
        const response = await fetch('/secretary/api/watches', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 ? 'ログインして見張り・確認事項を表示してください。' : '見張り・確認事項を取得できません。再試行します。');
        const next = await response.json();
        if (!Array.isArray(next.watches) || !Array.isArray(next.inboxAsks) || !Array.isArray(next.recentCompleted)) throw new Error('見張りの応答形式を確認できません。');
        if (active) { setData(next); setError(''); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : '読み込みに失敗しました。'); }
      finally { clearTimeout(timer); }
    }
    void refresh();
    const interval = setInterval(refresh, 60000);
    return () => { active = false; controller?.abort(); clearInterval(interval); };
  }, []);
  return <section aria-label="kim-PC の見張り・確認" className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-3">
    <h2 className="text-sm font-semibold">kim-PC の見張り・確認</h2>
    <input aria-label="見張り・確認を検索" value={query} onChange={event => setQuery(event.target.value)} placeholder="見張り・確認を検索" className="w-full rounded bg-zinc-950 border border-zinc-700 p-2 text-sm" />
    {error && <p role="alert" className="text-sm text-amber-300">{error}{data ? ' 表示中の情報は前回取得分です。' : ''}</p>}
    {!data && !error && <p className="text-sm text-zinc-400">読み込み中…</p>}
    {data && <>
      {data.warnings.map(warning => <p role="alert" key={warning} className="text-amber-300 text-xs">{warning}</p>)}
      <h3 className="text-xs text-zinc-400">進行中の見張り（{data.watches.length}）</h3>
      <WatchRows items={data.watches.filter(item => `${item.label} ${item.detail}`.includes(query))} />
      {!data.watches.length && <p className="text-xs">進行中の見張りはありません。</p>}
      {data.recentCompleted.length > 0 && <><h3 className="text-xs text-green-300">最近完了した見張り（7日間）</h3><WatchRows items={data.recentCompleted.filter(item => `${item.label} ${item.detail}`.includes(query))} /></>}
      <h3 className="text-xs text-amber-300">kim への未回答の確認（{data.inboxAsks.length}）</h3>
      <ul className="space-y-3 max-h-64 overflow-y-auto">{data.inboxAsks.filter(ask => ask.text.includes(query)).map(ask => <li key={ask.id} className="text-xs whitespace-pre-wrap break-words"><p>{ask.text}</p><p className="text-zinc-400">{ask.from} ／ {date(ask.createdAt)}</p></li>)}</ul>
      {!data.inboxAsks.length && <p className="text-xs">未回答の確認はありません。</p>}
      <p className="text-[10px] text-zinc-500">取得: {date(data.updatedAt)}（日本時間）</p>
    </>}
  </section>;
}
