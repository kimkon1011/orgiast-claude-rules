import { CHECKLIST } from './checklist-data.mjs';

function findItem(itemId) {
  return Object.values(CHECKLIST)
    .flatMap((section) => section.items)
    .find((item) => item.id === itemId);
}

function sectionFor(part) {
  const section = CHECKLIST[part];
  if (!section) throw new RangeError(`不明なチェックリストです: ${part}`);
  return section;
}

function itemState(state, itemId) {
  return state.items?.[itemId] ?? { checked: false, photo: null };
}

// UI とテストが共有する初期状態を作る。
export function createInitialState() {
  const items = {};
  for (const item of Object.values(CHECKLIST).flatMap((section) => section.items)) {
    items[item.id] = { checked: false, photo: null };
  }
  return { items };
}

// 元の state を変更せず、写真だけを差し替える。
export function attachPhoto(state, itemId, dataUrl) {
  if (!findItem(itemId)) throw new RangeError(`不明な項目です: ${itemId}`);
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw new TypeError('写真は空でない dataURL 文字列で指定してください');
  }

  return {
    ...state,
    items: {
      ...state.items,
      [itemId]: { ...itemState(state, itemId), photo: dataUrl },
    },
  };
}

// 写真必須項目は、添付済みになるまでチェックを拒否する。
export function toggleItem(state, itemId, checked, dataUrl) {
  const item = findItem(itemId);
  if (!item) throw new RangeError(`不明な項目です: ${itemId}`);

  let nextState = state;
  if (typeof dataUrl === 'string' && dataUrl.length > 0) {
    nextState = attachPhoto(state, itemId, dataUrl);
  }

  const current = itemState(nextState, itemId);
  if (checked && item.photoRequired && !current.photo) {
    return { ok: false, reason: 'photo-required', state };
  }

  return {
    ok: true,
    state: {
      ...nextState,
      items: {
        ...nextState.items,
        [itemId]: { ...current, checked: Boolean(checked) },
      },
    },
  };
}

export function canSubmit(state, part) {
  return sectionFor(part).items.every((item) => itemState(state, item.id).checked);
}

export function buildSubmission(state, part, now) {
  const section = sectionFor(part);
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const items = section.items.map((item) => {
    const current = itemState(state, item.id);
    return {
      id: item.id,
      label: item.label,
      checked: current.checked,
      photo: current.photo,
    };
  });

  return {
    part,
    at,
    items,
    photos: items.filter((item) => Boolean(item.photo)).length,
  };
}
