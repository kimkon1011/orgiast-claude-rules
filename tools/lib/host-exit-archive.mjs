// API のイベントは新しい順。最新アーカイブの直前2分以内（時計差 +1秒を許容）の host_exit を判定する。
export function hostExitArchive(events) {
  const archivedAt = Date.parse(events.find(e => e.payload?.request?.subtype === 'end_session' && e.payload.request.reason === 'archived')?.created_at);
  if (!Number.isFinite(archivedAt)) return events.some(e => e.event_type === 'system' && e.payload?.reason === 'host_exit');
  return events.some(e => e.event_type === 'system' && e.payload?.reason === 'host_exit'
    && Date.parse(e.created_at) <= archivedAt + 1_000 && archivedAt - Date.parse(e.created_at) <= 120_000);
}
