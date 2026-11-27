/**
 * Claude ペース作業キュー（純関数）。社外送信を含む作業は選ばない。
 */
export const COMMON_HOSTS = Object.freeze(['000', '015', '999']);

/** 社外送信を含むと判断する語（否定文の定型「送信は〜」には当たらないよう動詞形を使う） */
export const EXTERNAL_SEND_PATTERNS = Object.freeze([
  /送信する/,
  /メールを送る/,
  /フォームから送信/,
  /LINE\s*で送る/,
  /ラインで送る/,
]);

const STATES_SKIP = new Set(['完了', '実行中']);

function cloneQueue(queue) {
  return structuredClone(queue ?? { tasks: [], newOfferings: [] });
}

function hostMatches(taskHost, host) {
  const h = String(host);
  const th = String(taskHost || '');
  if (th === h) return true;
  if (COMMON_HOSTS.includes(h) && th === 'common') return true;
  return false;
}

/**
 * @param {{ title?: string, prompt?: string }} task
 * @returns {string|null} 弾く理由。問題なければ null
 */
export function externalSendReason(task) {
  const text = `${task?.title || ''}\n${task?.prompt || ''}`;
  for (const re of EXTERNAL_SEND_PATTERNS) {
    if (re.test(text)) return `社外送信語に該当: ${re.source}`;
  }
  return null;
}

function pendingForHost(tasks, host) {
  return (tasks || []).filter((t) => hostMatches(t.host, host) && t.state === '未着手');
}

/**
 * host に合う未着手を priority → id 昇順で count 件取り、queue 側を実行中にする。
 * 入力 queue は変更しない。社外送信語を含むものは rejected に入れる。
 * @returns {{ tasks: object[], queue: object, rejected: {id:string, reason:string}[] }}
 */
export function pickTasks({ queue, host, account: _account, count = 1, now = Date.now() } = {}) {
  const next = cloneQueue(queue);
  const nowIso = typeof now === 'number' ? new Date(now).toISOString() : String(now);
  const rejected = [];
  const eligible = [];
  for (const t of next.tasks || []) {
    if (!hostMatches(t.host, host)) continue;
    if (STATES_SKIP.has(t.state)) continue;
    if (t.state !== '未着手' && t.state !== '失敗') continue;
    const reason = externalSendReason(t);
    if (reason) {
      rejected.push({ id: t.id, reason });
      continue;
    }
    eligible.push(t);
  }
  eligible.sort((a, b) => {
    const pa = Number(a.priority) || 99;
    const pb = Number(b.priority) || 99;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
  const n = Math.max(0, Number(count) || 0);
  const pickedIds = new Set(eligible.slice(0, n).map((t) => t.id));
  next.tasks = (next.tasks || []).map((t) => {
    if (!pickedIds.has(t.id)) return t;
    return { ...t, state: '実行中', lastRunAt: nowIso };
  });
  // 返す tasks は priority→id 順（キュー配列の元順ではない）
  const byId = new Map((next.tasks || []).map((t) => [t.id, t]));
  const tasks = eligible.slice(0, n).map((t) => byId.get(t.id)).filter(Boolean);
  return { tasks, queue: next, rejected };
}

/**
 * その host の未着手が 0 なら newOfferings から rank 順に 1 件を tasks へ足す。
 * @returns {{ queue: object, added: object|null }}
 */
export function refillFromNewOfferings({ queue, host, now = Date.now() } = {}) {
  const next = cloneQueue(queue);
  const nowIso = typeof now === 'number' ? new Date(now).toISOString() : String(now);
  if (pendingForHost(next.tasks, host).length > 0) {
    return { queue: next, added: null };
  }
  const pool = [...(next.newOfferings || [])]
    .filter((o) => o.state === '未着手' && hostMatches(o.host, host))
    .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));
  const offer = pool[0];
  if (!offer) return { queue: next, added: null };

  const existingNew = (next.tasks || []).filter((t) => String(t.id).startsWith('Q-NEW-'));
  const seq = existingNew.length + 1;
  const id = `Q-NEW-${String(seq).padStart(2, '0')}`;
  const added = {
    id,
    host: offer.host,
    priority: 2,
    weight: 'medium',
    title: offer.title,
    prompt: offer.prompt,
    output: offer.output,
    done: `新サービス「${offer.title}」の成果が ${offer.output || 'output'} にあり、承認待ちとして記録されている`,
    state: '未着手',
    lastRunAt: null,
    source: `newOffering:${offer.id}`,
    offeringId: offer.id,
  };
  next.tasks = [...(next.tasks || []), added];
  next.newOfferings = (next.newOfferings || []).map((o) => (
    o.id === offer.id ? { ...o, state: '着手', startedAt: nowIso, taskId: id } : o
  ));
  next.updatedAt = nowIso;
  return { queue: next, added };
}

/**
 * @returns {object} 更新後 queue（入力は変更しない）
 */
export function markTaskDone({ queue, id, ok, now = Date.now() } = {}) {
  const next = cloneQueue(queue);
  const nowIso = typeof now === 'number' ? new Date(now).toISOString() : String(now);
  next.tasks = (next.tasks || []).map((t) => {
    if (t.id !== id) return t;
    return {
      ...t,
      state: ok ? '完了' : '失敗',
      lastFinishedAt: nowIso,
    };
  });
  next.updatedAt = nowIso;
  return next;
}

/**
 * @returns {{ byHost: Record<string, {未着手:number,実行中:number,完了:number,失敗:number}>, newOfferingsStarted: object[] }}
 */
export function summarizeQueue(queue) {
  const byHost = {};
  const bump = (host, state) => {
    const h = String(host || 'unknown');
    if (!byHost[h]) byHost[h] = { 未着手: 0, 実行中: 0, 完了: 0, 失敗: 0 };
    if (state in byHost[h]) byHost[h][state] += 1;
  };
  for (const t of queue?.tasks || []) bump(t.host, t.state);
  const newOfferingsStarted = (queue?.newOfferings || []).filter((o) => o.state && o.state !== '未着手');
  return { byHost, newOfferingsStarted };
}
