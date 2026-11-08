import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** 台帳に載せる ID の上限。古いものから捨てる。 */
const MAX_IDS = 500;

function readIds(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch {
    return [];
  }
}

/** closed-sessions.json へ ID を追記し、書けたことを読み戻して確かめる。
 *
 * この台帳は read-modify-write なので、並行セッションが同時に閉じると後勝ちで
 * 先の ID が消える（2026-09-22 実害: /session-close が成功を報告したのに ID が
 * 台帳に残らず、セッションが一覧に残り続けた）。purge 側の drop_closed() は
 * 同じ危険を認識して読み直してから差し引いているが、こちら側だけ無防備だった。
 *
 * 書いた直後に読み戻し、別プロセスの上書きと競り負けていたらやり直す。
 * 戻り値: 最終的に ID が台帳に載っていれば true。
 */
export function recordClosed(id, path, { attempts = 5, onError } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ids = readIds(path);
    if (ids.includes(id)) return true;
    ids.push(id);
    const tmpPath = `${path}.tmp-${process.pid}-${attempt}`;
    try {
      writeFileSync(tmpPath, `${JSON.stringify({ ids: ids.slice(-MAX_IDS) }, null, 2)}\n`, "utf8");
      renameSync(tmpPath, path);
    } catch (e) {
      if (attempt === attempts) {
        onError?.(e);
        return false;
      }
      continue;
    }
    if (readIds(path).includes(id)) return true;
  }
  return false;
}
