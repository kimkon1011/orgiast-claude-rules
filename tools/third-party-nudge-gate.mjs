export const GATE_CONTRACT = {"name": "third-party-nudge-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "third-party-nudge-gate"}]};

// 他人・他PC・他アカウントの対応待ちで止まる報告に、任意の後押し文を漏らさず入れる。
// 2026-11-02 nishi 指示「毎回入れるようにして・全PC全アカウント」。
// deferral-wait-gate（完了待ち自体を禁止）とは違い、第三者待ちは許容するが、
// 最終まとめに後押し文が無ければ block する。

// 相手語: 他PC、他アカウント、人の名前（さん付け）、先方、業者など
// 「あなた」「user」「ユーザー」「Codex」「エージェント」などは含めない。
const PARTY = '(?:[A-Za-z0-9]+-PC|kim|[一-龠ぁ-んァ-ヶA-Za-z]{1,10}さん|先方|相手|業者|お客様|他PC|別PC|別アカウント)';
// 待機語: 返信/返事/回答/対応/作業/判断/修正/承認/同意/マージ/連絡 が を/が を伴って 待ち/待って/来たら/次第 など
const WAIT = '(?:返信|返事|回答|対応|作業|判断|修正|承認|同意|マージ|連絡)(?:を|が)?(?:待ち|待って|待っています|待つ|来たら|届いたら|済んだら|終わったら|次第|まだ)';
// 依頼済み語: 〜へ/に …依頼/お願い しました/済み/を送り/を出し
const REQUESTED = '(?:へ|に)[^\\n]{0,30}?(?:依頼|お願い)(?:しました|済み|を送り|を出し)';

// 第三者待ち検出: 相手語の後 0〜40 字以内（改行をまたがない）に待機語または依頼済み語がある
const THIRD_PARTY_WAIT = new RegExp(`${PARTY}[^\\n]{0,40}?(?:${WAIT}|${REQUESTED})`, 'g');

// 後押し文検出: 同一行に「急ぐ場合」と、『』で囲まれた 15 字以上の文がある
const NUDGE = /急ぐ場合[^。]*『[^』]{15,}』/;

// 引用行と fenced code block は判定から外す（deferral-wait-gate と同じ処理）
function proseLines(text) {
  let fence;
  return String(text || '').split(/\r?\n/).map(line => {
    if (/^\s*>/.test(line)) return '';
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n');
}

export function enabled() {
  return process.env.ORGIAST_THIRD_PARTY_NUDGE_GATE !== '0';
}

// 相手語と待機語の間に user を指す語があれば user 自身の待ちなので除く
// （2026-11-02 実測: 「kimko-PC の自動進行】… あなたの判断待ち」を誤って拾った）。
const USER_SELF = /あなた|ユーザー|user/i;

// 第三者待ちの箇所を検出する（最初の1件を返す。無ければ null）
export function findThirdPartyWait(prose) {
  for (const match of prose.matchAll(THIRD_PARTY_WAIT)) {
    if (!USER_SELF.test(match[0])) return match[0];
  }
  return null;
}

// 後押し文の有無を判定する
export function hasNudge(prose) {
  return NUDGE.test(prose);
}

export function judge(text) {
  if (!enabled()) return { decision: 'pass' };
  const prose = proseLines(text);
  const wait = findThirdPartyWait(prose);
  if (!wait) return { decision: 'pass' };
  if (hasNudge(prose)) return { decision: 'pass' };
  const snippet = wait.slice(0, 60);
  return {
    decision: 'block',
    code: 'THIRD-PARTY-NUDGE',
    reason: `他の人・他PCの対応待ちで止まる報告です。最終まとめの『user がやること』に、任意の後押し文を入れてください: 急ぐ場合だけ、<相手>に口頭やチャットで『<その1文で分かる用件。何がどこに届いていて何を対応してほしいか>』と一言伝えてもらえると早く進みます。必須作業（なし等）とは分けて書く。検出箇所: ${snippet}`,
  };
}