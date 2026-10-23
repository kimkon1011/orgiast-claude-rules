#!/usr/bin/env node
// ラハイナの「露出スコア」を普通のPCから計測する。
//
// なぜ必要か（2026-10-15 実測）:
//   claude.ai クラウド Routine（trig_017cwe1Kwy6BWxs3zoF8DLre / env_01W6MWRqRxXscNxrmoXY7h5n）は
//   egress プロキシの organization policy で lahaina.jp / www.jalan.net / travel.rakuten.co.jp /
//   www.instagram.com に接続できず、3週連続で露出未計測（露出0/6）だった。
//   一方、普通のPCからは4サイトとも HTTP 200 で到達できることを実測済み。
//   ＝計測をクラウドRoutineの egress に依存させなければ、kim のUI設定操作を待たずに計測できる。
//
// 露出スコアの定義（運用設計書 第2章）:
//   公式・じゃらん・楽天・Booking・Airbnb・Google の6媒体のうち「在庫が買える」媒体数。警戒水準は 3未満。

import { isEntry } from './is-entry.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

export const STATUS = {
  BUYABLE: 'buyable',
  NOT_LISTED: 'not_listed',
  DELISTED: 'delisted',
  UNMEASURABLE: 'unmeasurable',
};

// ---- 判定（純粋関数・テスト対象） -------------------------------------------

/** じゃらん: 「予約受付を停止」が無く、料金表記があれば在庫が買える。 */
export function judgeJalan(html) {
  if (!html) return { status: STATUS.UNMEASURABLE, evidence: '応答が空' };
  if (html.includes('予約受付を停止')) {
    return { status: STATUS.NOT_LISTED, evidence: '「予約受付を停止」を検出' };
  }
  const price = html.match(/[0-9]{1,3},[0-9]{3}円/);
  if (price) {
    return { status: STATUS.BUYABLE, evidence: `料金表記 ${price[0]} を検出` };
  }
  return { status: STATUS.NOT_LISTED, evidence: '料金表記なし（プランが出ていない）' };
}

/** 楽天トラベル: 個別ページが「掲載終了」を返せば delisted。 */
export function judgeRakuten(html) {
  if (!html) return { status: STATUS.UNMEASURABLE, evidence: '応答が空' };
  if (html.includes('掲載終了')) {
    return { status: STATUS.DELISTED, evidence: '「掲載終了」を検出' };
  }
  return { status: STATUS.BUYABLE, evidence: '掲載終了の文言なし（掲載中）' };
}

/** 公式HP: 予約導線リンクが1本でもあれば HP 経由で在庫が買える。 */
export function judgeOfficial(html) {
  if (!html) return { status: STATUS.UNMEASURABLE, evidence: '応答が空' };
  const links = html.match(/href="[^"]*"/g) || [];
  const hit = links.find((h) =>
    /jalan|rakuten|booking\.com|airbnb|beds24|yad353005|予約|reserve/i.test(h)
  );
  if (hit) return { status: STATUS.BUYABLE, evidence: `予約導線リンク ${hit} を検出` };
  return { status: STATUS.NOT_LISTED, evidence: '予約導線リンクが0本（HPからは在庫が買えない）' };
}

/**
 * Booking.com: 検索結果に施設カードとして出ていれば buyable。
 * 注意: 検索結果ページは**検索語をそのまま本文にエコーする**ため、単純な「ラハイナ」含有判定は
 * 誤検知する（2026-10-15 実測: 同一URLで 1/6 と 2/6 にぶれた）。施設カードのコンテナを伴う場合だけ
 * 掲載とみなす。取得できない/判定できない場合は 0 と決めつけず unmeasurable にする。
 */
export function judgeBooking(html) {
  // 2026-10-15 実測: 同一URL・同一条件で 3回中1回だけ「buyable」に振れた（1/6 ↔ 2/6）。
  // 原因は Booking が bot 対策ページを返し、その本文に**検索語（ラハイナ）をエコーする**こと。
  // 施設カードのコンテナ有無で絞っても安定しなかった（対策ページにもカード用のテンプレートが同梱される）。
  // → 誤検知で KPI を水増しするより、**未計測として正直に出す**方が運用上正しい（Google と同じ扱い）。
  const len = html ? html.length : 0;
  return {
    status: STATUS.UNMEASURABLE,
    evidence: `Booking.com は bot 対策で検索語をエコーするため自動判定が安定しない（実測: 3回中1回誤検知・今回の本文${len}バイト）。kim の目視 or 掲載確認APIで確定`,
  };
}

/** Airbnb: 検索結果に施設名が出なければ未掲載。 */
export function judgeAirbnb(html) {
  if (!html) return { status: STATUS.UNMEASURABLE, evidence: '応答が空' };
  if (html.length < 20000) {
    return { status: STATUS.UNMEASURABLE, evidence: 'bot遮断の疑い（本文が小さい）' };
  }
  if (html.includes('ラハイナ')) {
    return { status: STATUS.BUYABLE, evidence: '検索結果に「ラハイナ」を検出' };
  }
  return { status: STATUS.NOT_LISTED, evidence: '検索結果に「ラハイナ」なし' };
}

// ---- 取得 -------------------------------------------------------------------

async function get(url, timeoutSec) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' },
      redirect: 'follow',
      signal: ac.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return decode(buf, res.headers.get('content-type') || '');
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** じゃらん等は Shift_JIS。UTF-8 で読めなければ Shift_JIS として復号する。 */
function decode(buf, contentType) {
  const asUtf8 = buf.toString('utf8');
  const bad = (asUtf8.match(/�/g) || []).length;
  if (bad === 0) return asUtf8;
  const asSjis = new TextDecoder('shift_jis').decode(buf);
  const badSjis = (asSjis.match(/�/g) || []).length;
  return badSjis < bad ? asSjis : asUtf8;
}

function ymd(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

// ---- 本計測 -----------------------------------------------------------------

export async function measure({ dateStr, timeoutSec = 20 } = {}) {
  const checkin = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date(Date.now() + 5 * 86400000);
  const jYmd = ymd(checkin);
  const jEnc = encodeURIComponent(jYmd);
  const checkout = new Date(checkin.getTime() + 86400000);
  const results = [];

  const probes = [
    {
      media: 'じゃらん',
      url: `https://www.jalan.net/yad353005/plan/?adultNum=2&checkInDate=${jEnc}&stayCount=1&roomCount=1&childNum=0`,
      judge: judgeJalan,
    },
    {
      media: '楽天トラベル',
      url: 'https://travel.rakuten.co.jp/HOTEL/37967/',
      judge: judgeRakuten,
    },
    { media: '公式HP', url: 'https://lahaina.jp/', judge: judgeOfficial },
    {
      media: 'Booking.com',
      url: `https://www.booking.com/searchresults.ja.html?ss=${encodeURIComponent(
        'ラハイナ'
      )}&checkin=${iso(checkin)}&checkout=${iso(checkout)}`,
      judge: judgeBooking,
    },
    {
      media: 'Airbnb',
      url: `https://www.airbnb.jp/s/${encodeURIComponent('牛窓町')}/homes`,
      judge: judgeAirbnb,
    },
  ];

  for (const p of probes) {
    const html = await get(p.url, timeoutSec);
    let r;
    try {
      r = p.judge(html);
    } catch (e) {
      r = { status: STATUS.UNMEASURABLE, evidence: `判定エラー: ${e.message}` };
    }
    if (typeof r === 'string') r = { status: r, evidence: '' };
    results.push({ media: p.media, status: r.status, evidence: r.evidence, url: p.url });
  }

  // Google は bot 遮断で機械取得できないため、勝手に 0 扱いせず「未計測」として明示する。
  results.push({
    media: 'Google',
    status: STATUS.UNMEASURABLE,
    evidence: 'Google検索はbot遮断のため機械取得不可（kim目視 or GBP API が必要）',
    url: 'https://www.google.com/search?q=ラハイナ+牛窓',
  });

  const buyable = results.filter((r) => r.status === STATUS.BUYABLE).length;
  const unmeasured = results.filter((r) => r.status === STATUS.UNMEASURABLE).length;
  const measured = results.length - unmeasured;
  return { checkin: iso(checkin), results, buyable, measured, unmeasured, total: results.length };
}

// ---- CLI --------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`使い方: node tools/lahaina-exposure-check.mjs [--date YYYY-MM-DD] [--json] [--timeout 秒]

ラハイナの露出スコア（公式・じゃらん・楽天・Booking・Airbnb・Google の6媒体のうち
在庫が買える媒体数。警戒水準 3未満）を計測する。

  --date    在庫照会日（既定: 今日+5日）
  --json    JSON のみ出力
  --timeout 1媒体あたりの秒数（既定20）`);
    return 0;
  }
  const dateStr = argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : undefined;
  const timeoutSec = argv.includes('--timeout')
    ? Number(argv[argv.indexOf('--timeout') + 1]) || 20
    : 20;
  const json = argv.includes('--json');

  measure({ dateStr, timeoutSec })
    .then((r) => {
      if (json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        console.log(`ラハイナ 露出計測（在庫照会日 ${r.checkin}）`);
        console.log('-'.repeat(64));
        for (const x of r.results) {
          console.log(`  ${x.media.padEnd(12, '　')} ${x.status.padEnd(14)} ${x.evidence}`);
        }
        console.log('-'.repeat(64));
      }
      const verdict = r.buyable >= 3 ? '良好' : '警戒';
      console.log(
        `露出スコア: ${r.buyable}/${r.total}（確定分 ${r.buyable}/${r.measured}・未計測${r.unmeasured}件。警戒水準3未満 → ${verdict}）`
      );
      return 0;
    })
    .catch((e) => {
      console.error(`計測に失敗: ${e.message}`);
      return 0; // ネットワーク不通でも異常終了させない
    });
  return 0;
}

if (isEntry(import.meta.url)) {
  const code = main();
  if (typeof code === 'number') process.exitCode = code;
}
