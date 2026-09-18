#!/usr/bin/env node
// AWS「月3万円」構築の見積もり。価格は AWS 一次情報（Lightsail 公開プライスリスト ap-northeast-1 +
// AWS 公式ドキュメント）から採取し、verified / 未計測 を分離して出す。
//
// 設計方針（2026-09-14 の実害にもとづく）:
//   台帳や推定値の「0円/安い」は支出ゼロの証拠にならない。ここでは usd:null を 0 として扱わず
//   「未計測」として必ず件数を併記し、確定分の合計とは別枠で返す。
import { isEntry } from './is-entry.mjs';

export const PRICE_AS_OF = '2026-09-19';

// 為替は固定値を持たず、必ず出典付きで上書きできるようにする。
// 既定 156 円/USD は 2026-09 東京市場仲値の実測平均 ≈155.8（9/1〜9/15, 日銀公表値ベース）。
export const DEFAULT_USD_JPY = 156;
export const DEFAULT_BUDGET_JPY = 30000;

export const SOURCES = {
  lightsailList:
    'https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html',
  lightsailTokyoPriceList:
    'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonLightsail/current/index.json (regionCode=ap-northeast-1)',
  freeTier: 'https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html',
  fx: '日銀 東京市場 仲値 2026-09-01〜09-15 平均 ≈155.8 JPY/USD',
  ec2Tracker: '第三者トラッカー（Spare Cores / Holori）— AWS 一次情報では未確認',
};

// unit: 'month' = 月額固定 / 'gb-month' = GB 単価 × 数量 / 'hour730' = 時間単価 × 730h
// verified:false は「一次情報で未確認」。usd:null は「未計測」で、合計に加算してはいけない。
export const CATALOG = {
  // --- Lightsail インスタンス（Linux, パブリック IPv4）: 公式ドキュメントの月額、東京リージョンの
  //     時間単価 ×730 と一致することを確認済み（例 0.5GB $0.00672/h → $4.91/mo ≒ $5） ---
  'ls-nano-0.5gb':   { label: 'Lightsail Nano 0.5GB (IPv4)',   usd: 5,   unit: 'month', verified: true, source: SOURCES.lightsailList },
  'ls-micro-1gb':    { label: 'Lightsail Micro 1GB (IPv4)',    usd: 7,   unit: 'month', verified: true, source: SOURCES.lightsailList },
  'ls-small-2gb':    { label: 'Lightsail Small 2GB (IPv4)',    usd: 12,  unit: 'month', verified: true, source: SOURCES.lightsailList },
  'ls-medium-4gb':   { label: 'Lightsail Medium 4GB (IPv4)',   usd: 24,  unit: 'month', verified: true, source: SOURCES.lightsailList },
  'ls-large-8gb':    { label: 'Lightsail Large 8GB (IPv4)',    usd: 44,  unit: 'month', verified: true, source: SOURCES.lightsailList },
  'ls-xlarge-16gb':  { label: 'Lightsail Xlarge 16GB (IPv4)',  usd: 84,  unit: 'month', verified: true, source: SOURCES.lightsailList },
  'ls-2xlarge-32gb': { label: 'Lightsail 2Xlarge 32GB (IPv4)', usd: 164, unit: 'month', verified: true, source: SOURCES.lightsailList },
  'ls-mem-2xlarge-64gb': { label: 'Lightsail メモリ最適化 2Xlarge 64GB (IPv4)', usd: 294, unit: 'month', verified: true, source: SOURCES.lightsailList },
  // IPv6 のみ（IPv4 無し）。同じスペックで 2〜3 割安い。
  'ls-small-2gb-ipv6':  { label: 'Lightsail Small 2GB (IPv6のみ)',  usd: 10, unit: 'month', verified: true, source: SOURCES.lightsailList },
  'ls-medium-4gb-ipv6': { label: 'Lightsail Medium 4GB (IPv6のみ)', usd: 20, unit: 'month', verified: true, source: SOURCES.lightsailList },

  // --- Lightsail 付随サービス（東京リージョンの公開プライスリストから実測、月額換算） ---
  'ls-db-1gb':      { label: 'Lightsail マネージドDB 1GB',        usd: 14.72, unit: 'month', verified: true, source: SOURCES.lightsailTokyoPriceList },
  'ls-db-1gb-ha':   { label: 'Lightsail マネージドDB 1GB HA',     usd: 29.44, unit: 'month', verified: true, source: SOURCES.lightsailTokyoPriceList },
  'ls-db-4gb':      { label: 'Lightsail マネージドDB 4GB',        usd: 58.87, unit: 'month', verified: true, source: SOURCES.lightsailTokyoPriceList },
  'ls-lb':          { label: 'Lightsail ロードバランサ',          usd: 17.66, unit: 'month', verified: true, source: SOURCES.lightsailTokyoPriceList },
  'ls-snapshot':    { label: 'Lightsail スナップショット',        usd: 0.05,  unit: 'gb-month', verified: true, source: SOURCES.lightsailTokyoPriceList },
  'ls-staticip-idle': { label: 'Lightsail 未アタッチ静的IPv4',    usd: 0.005 * 730, unit: 'month', verified: true, source: SOURCES.lightsailTokyoPriceList },

  // --- EC2 / RDS の参考値。AWS 一次情報で東京リージョンの実額を取れていないため verified:false ---
  'ec2-t4g-medium-tokyo': { label: 'EC2 t4g.medium (東京, 参考)', usd: 0.0432 * 730, unit: 'month', verified: false, source: SOURCES.ec2Tracker },
  'rds-t4g-micro-tokyo':  { label: 'RDS db.t4g.micro Single-AZ (東京)', usd: null, unit: 'month', verified: false, source: SOURCES.ec2Tracker },

  // --- 無料枠。Always Free は上限内なら $0 だが、上限は構成が決まらないと評価できない ---
  'free-lambda':     { label: 'Lambda 無料枠 (100万req + 40万GB-s)', usd: 0, unit: 'month', verified: true, source: SOURCES.freeTier },
  'free-cloudfront': { label: 'CloudFront 無料枠 (転送1TB + 1000万req)', usd: 0, unit: 'month', verified: true, source: SOURCES.freeTier },
};

export function lineItem(id, qty = 1, catalog = CATALOG) {
  const item = catalog[id];
  if (!item) throw new Error(`未知の価格IDです: ${id}`);
  if (!Number.isFinite(qty) || qty < 0) throw new Error(`数量は0以上の数値が必要です: ${id}`);
  const measured = typeof item.usd === 'number' && Number.isFinite(item.usd);
  const usd = measured ? item.usd * (item.unit === 'month' ? qty : qty) : null;
  return { id, qty, label: item.label, unit: item.unit, verified: item.verified, source: item.source, usd, measured };
}

/** 構成（明細の配列）を月額 USD / JPY に積む。未計測は合計に足さず件数で返す。 */
export function estimate(items, options = {}) {
  const { catalog = CATALOG, usdJpy = DEFAULT_USD_JPY, budgetJpy = DEFAULT_BUDGET_JPY } = options;
  if (!(usdJpy > 0) || !Number.isFinite(usdJpy)) throw new Error('為替レートは正の数が必要です');
  if (!(budgetJpy > 0) || !Number.isFinite(budgetJpy)) throw new Error('予算は正の数が必要です');

  const lines = items.map((it) => lineItem(it.id, it.qty ?? 1, catalog));
  let totalUsd = 0, confirmedUsd = 0, unverifiedUsd = 0, unmeasuredCount = 0;
  for (const line of lines) {
    if (!line.measured) { unmeasuredCount++; continue; }
    totalUsd += line.usd;
    if (line.verified) confirmedUsd += line.usd; else unverifiedUsd += line.usd;
  }
  const totalJpy = totalUsd * usdJpy;
  return {
    asOf: PRICE_AS_OF,
    usdJpy,
    budgetJpy,
    lines,
    totalUsd,
    totalJpy,
    confirmedJpy: confirmedUsd * usdJpy,
    unverifiedJpy: unverifiedUsd * usdJpy,
    unmeasuredCount,
    // 未確認が残るなら「確定」と言い切らない（0円を未計測と読み替えないための防波堤）
    certainty: unmeasuredCount > 0 || unverifiedUsd > 0 ? 'partial' : 'confirmed',
    verdict: totalJpy <= budgetJpy ? 'within' : 'over',
    headroomJpy: budgetJpy - totalJpy,
  };
}

export const PLANS = [
  {
    id: 'A',
    name: 'A案 最小（学習・検証・個人開発）',
    summary: '1台 + 小さいDB。無料枠の Lambda/CloudFront を併用。',
    items: [{ id: 'ls-small-2gb' }, { id: 'ls-db-1gb' }, { id: 'ls-snapshot', qty: 40 }],
  },
  {
    id: 'B',
    name: 'B案 標準（小規模Webサービス本番・単一AZ）',
    summary: '4GB 1台 + DB + LB + バックアップ。冗長化なし。',
    items: [{ id: 'ls-medium-4gb' }, { id: 'ls-db-1gb' }, { id: 'ls-lb' }, { id: 'ls-snapshot', qty: 80 }],
  },
  {
    id: 'C',
    name: 'C案 冗長化（中規模・DB HA・LB 配下）',
    summary: '16GB 1台 + DB HA + LB。DB は Multi-AZ 相当で倍額。',
    items: [{ id: 'ls-xlarge-16gb' }, { id: 'ls-db-1gb-ha' }, { id: 'ls-lb' }, { id: 'ls-snapshot', qty: 160 }],
  },
  {
    id: 'D',
    name: 'D案 予算上限の確認（どこで3万円を割るか）',
    summary: 'メモリ最適化 64GB 単体。1台で予算超過する境界。',
    items: [{ id: 'ls-mem-2xlarge-64gb' }, { id: 'ls-db-4gb' }, { id: 'ls-lb' }],
  },
];

export function estimatePlan(planId, options = {}) {
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) throw new Error(`未知のプランです: ${planId}`);
  return { plan, ...estimate(plan.items, options) };
}

export function yen(n) { return `¥${Math.round(n).toLocaleString('ja-JP')}`; }

/** 人が読む markdown レポート。既定は全プラン。 */
export function formatReport(options = {}) {
  const { usdJpy = DEFAULT_USD_JPY, budgetJpy = DEFAULT_BUDGET_JPY, planIds = PLANS.map((p) => p.id), catalog = CATALOG } = options;
  const out = [];
  out.push(`# AWS 月3万円 見積もり（${PRICE_AS_OF} 時点の価格）`);
  out.push('');
  out.push(`- 前提レート: **${usdJpy} 円/USD**（${SOURCES.fx}）`);
  out.push(`- 予算: **${yen(budgetJpy)}/月**（= $${(budgetJpy / usdJpy).toFixed(2)}）`);
  out.push('- 価格の出典: AWS 公式ドキュメント / AWS 公開プライスリスト（ap-northeast-1）');
  out.push('');
  for (const id of planIds) {
    const r = estimatePlan(id, { usdJpy, budgetJpy, catalog });
    out.push(`## ${r.plan.name}`);
    out.push('');
    out.push(r.plan.summary);
    out.push('');
    out.push('| 項目 | 数量 | USD/月 | 出典 |');
    out.push('| --- | ---: | ---: | --- |');
    for (const l of r.lines) {
      const usd = l.measured ? `$${l.usd.toFixed(2)}` : '**未計測**';
      out.push(`| ${l.label} | ${l.qty} | ${usd} | ${l.verified ? 'AWS一次' : '未確認'} |`);
    }
    out.push(`| **合計** | | **$${r.totalUsd.toFixed(2)}** | |`);
    out.push('');
    out.push(`月額 **${yen(r.totalJpy)}** — 予算に対して ${r.verdict === 'within' ? `**${yen(r.headroomJpy)} 余る**` : `**${yen(-r.headroomJpy)} 超過**`}`);
    if (r.certainty === 'partial') {
      const bits = [];
      if (r.unverifiedJpy > 0) bits.push(`未確認分 ${yen(r.unverifiedJpy)}`);
      if (r.unmeasuredCount > 0) bits.push(`未計測 ${r.unmeasuredCount} 件（実費はこれより大きい）`);
      out.push(`> ⚠️ この合計は**一部未確定**: ${bits.join(' / ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

if (isEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const usdJpy = Number(arg('jpy-rate', process.env.ORGIAST_USDJPY || DEFAULT_USD_JPY));
  const budgetJpy = Number(arg('budget', DEFAULT_BUDGET_JPY));
  const plan = arg('plan', null);
  process.stdout.write(formatReport({ usdJpy, budgetJpy, planIds: plan ? [plan.toUpperCase()] : undefined }) + '\n');
}
