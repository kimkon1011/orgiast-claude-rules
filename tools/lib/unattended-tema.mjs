import os from 'node:os';
import { createHash } from 'node:crypto';
import { assertNoHandback, stripHumanOnly } from './handback-guard.mjs';
import { parseTemaRecord } from './tema-check.mjs';

export const TEMA_GENERATION_INSTRUCTION = '回答の answer 末尾には必ず [TEMA-CHECK] 候補:（電子・オンライン・AI代行など2案以上を / で区切る）、選択:、紙理由:、手順数:、読む量:、追加連絡:、前提:（所在・期限・順番の確認結果）、AI代行: を各行に書き [/TEMA-CHECK] で閉じた検証記録を付ける。調査していないことを確認済みと書かない。人にしかできない依頼には [HUMAN-ONLY: 具体的理由] も付ける。サインインの委任時はサインイン: 出どころ=… / 禁止=… / 失敗時=出どころ切替→経路切替→本人の一点 を記録する。記録は送信時に除去される。';

export async function parkTemaBlocked(text, error, options = {}) {
  if (!/^TEMA_|^HANDBACK_/.test(error.code || '')) throw error;
  const home = options.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const addItem = options.addItemImpl ?? (await import('../kim-inbox.mjs')).addItem;
  const key = createHash('sha256').update(`${options.source || ''}\n${options.to || ''}\n${text}`).digest('hex');
  // 外部転送はしない。常設 inbox 見回りがこのローカル項目を回収する。
  const item = await addItem(home, { kind: 'info', forceKind: true, priority: 'high', source: 'tema-blocked-send', dedupeKey: `tema-${key}`,
    text: `手間チェックで止まった送信\n呼び出し元: ${options.source || options.channel || 'send'}\n宛先: ${options.to || '未指定'}\n理由: ${error.message}\n本文全文:\n${text}` }, { localOnly: true, drain: false });
  error.inboxId = item.id;
  return item;
}
export async function prepareTemaSend(text, options = {}) {
  try {
    if (options.requireRecord && !parseTemaRecord(text) && !options.temaRecord) throw Object.assign(new Error('LLM生成文に [TEMA-CHECK] の検証記録がありません'), { code: 'TEMA_NO_RECORD' });
    assertNoHandback(text, options);
    return stripHumanOnly(text);
  } catch (error) {
    if (!options.dryRun) await parkTemaBlocked(text, error, options);
    throw error;
  }
}
