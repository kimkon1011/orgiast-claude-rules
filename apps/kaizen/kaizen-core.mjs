export const STATUS_LABELS = Object.freeze({
  open: '未検討', decided: '改善会で決定', reflected: '実施計画書に反映', done: '完了',
});

export function createState() { return { items: [] }; }

function text(value, name, optional = false) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string') throw new TypeError(`${name}は文字列で入力してください。`);
  const result = value.trim();
  if (!optional && !result) throw new TypeError(`${name}は必須です。`);
  return result;
}

function date(value, name, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string') throw new RangeError(`${name}はYYYY-MM-DD形式で入力してください。`);
  const result = value.trim();
  if (optional && !result) return '';
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new RangeError(`${name}は実在する日付をYYYY-MM-DD形式で入力してください。`);
  }
  return result;
}

export function validateItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('改善項目を入力してください。');
  return {
    occurredOn: date(input.occurredOn, '記入日'),
    reporter: text(input.reporter, '記入担当者名'),
    client: text(input.client, 'クライアント+案件名'),
    event: text(input.event, '事象'),
    solution: text(input.solution, '解決策', true),
  };
}

export function addItem(state, input) {
  const item = validateItem(input);
  let sequence = 0n;
  for (const existing of state.items) {
    const match = /^kz-(\d+)$/.exec(existing.id);
    if (match && BigInt(match[1]) > sequence) sequence = BigInt(match[1]);
  }
  return { ...state, items: [...state.items, { ...item, id: `kz-${sequence + 1n}`, status: 'open' }] };
}

function update(state, id, makeChanges) {
  if (!state.items.some(item => item.id === id)) throw new RangeError('指定された改善項目がありません。');
  const changes = makeChanges();
  return { ...state, items: state.items.map(item => item.id === id ? { ...item, ...changes } : item) };
}

export function decideItem(state, id, { countermeasure, owner, due } = {}) {
  return update(state, id, () => ({
    countermeasure: text(countermeasure, '対策'), owner: text(owner, '担当'),
    due: date(due, '期限', true), status: 'decided',
  }));
}

export function reflectItem(state, id, { planUrl } = {}) {
  return update(state, id, () => ({ planUrl: text(planUrl, '反映先', true), status: 'reflected' }));
}

export function completeItem(state, id) {
  return update(state, id, () => ({ status: 'done' }));
}

export function summarize(state) {
  const result = { total: state.items.length, byStatus: { open: 0, decided: 0, reflected: 0, done: 0 }, byClient: {}, byOwner: {} };
  const increment = (counts, key) => Object.defineProperty(counts, key, {
    value: (Object.hasOwn(counts, key) ? counts[key] : 0) + 1, enumerable: true, configurable: true, writable: true,
  });
  for (const item of state.items) {
    increment(result.byStatus, item.status);
    increment(result.byClient, item.client);
    if (item.owner) increment(result.byOwner, item.owner);
  }
  return result;
}

// 入力中の改行や記号でMarkdownのブロック構造が崩れないようにする。
function markdown(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/\r\n|\r|\n/g, '<br>');
}

export function toMarkdown(state) {
  const blocks = state.items.map(item => [
    `## ${markdown(item.client)}｜${markdown(item.event)}`,
    `- 記入日: ${item.occurredOn}`,
    `- 記入担当: ${markdown(item.reporter)}`,
    `- 状態: ${STATUS_LABELS[item.status]}`,
    `- 解決策（提案）: ${markdown(item.solution || '（未記入）')}`,
    `- 対策: ${markdown(item.countermeasure || '（未定）')}`,
    `- 担当: ${markdown(item.owner || '（未定）')}`,
    `- 期限: ${item.due || '（未定）'}`,
    `- 反映先: ${markdown(item.planUrl || '（未記入）')}`,
  ].join('\n'));
  return ['# 改善項目一覧', ...blocks].join('\n\n') + '\n';
}
