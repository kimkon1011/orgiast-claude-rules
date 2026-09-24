// 顧客情報の整形処理を「ローカルモデル(Ollama)」と「クラウドAPI」で同一タスク実行し、
// 品質・速度・データ出境量(安全性)を比較する実測ハーネス。
//
// 使い方:
//   node tools/customer-data-local-vs-cloud.mjs                 # 既定の比較（ローカル1 + クラウド2）
//   node tools/customer-data-local-vs-cloud.mjs --local-only    # ネット不要（CI/テスト向け）
//   node tools/customer-data-local-vs-cloud.mjs --out <file.md>
//
// 安全性: 入力はすべて本ファイル内の合成ダミー。実在の顧客データは一切使わない
// （クラウドへ送る特性そのものを測るため、送る中身はダミーでなければならない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const FIELDS = ['customer_id', 'name', 'company', 'postal_code', 'prefecture', 'city', 'address', 'phone', 'email'];

const SYS = [
  'あなたは顧客名簿の整形担当です。入力テキストから顧客情報を抽出し、正規化したJSONだけを出力します。',
  '規則:',
  '- 電話番号は数字のみ（ハイフン・空白・全角数字は除去）',
  '- 郵便番号は数字7桁のみ',
  '- メールアドレスは小文字化',
  '- 氏名・法人名・住所から敬称（様/さん）は除去',
  '- 出力キーは ' + FIELDS.join(', ') + ' の9つのみ。説明文・コードフェンスは付けない。',
  '- 値が無い項目は空文字 "" を入れる。',
].join('\n');

// 合成データ。実在の人物・法人ではない。
export const CASES = [
  {
    id: 'C-1001',
    raw: 'お客様名: 山田 太郎 様 ／ 法人: 株式会社オージャスト ／ 〒150-0001 東京都渋谷区神宮前1-2-3 神宮前ビル5F ／ TEL ０３－１２３４－５６７８ ／ Mail: Yamada.Taro@Example.co.jp',
    gold: { customer_id: 'C-1001', name: '山田 太郎', company: '株式会社オージャスト', postal_code: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-2-3 神宮前ビル5F', phone: '0312345678', email: 'yamada.taro@example.co.jp' },
  },
  {
    id: 'C-1002',
    raw: '担当 佐藤　花子 / 東邦鋼業株式会社 / 郵便番号 530-0001 大阪府大阪市北区梅田1-1-1 / 電話 06-6345-6789 / hanako.sato@toho-kogyo.example.com',
    gold: { customer_id: 'C-1002', name: '佐藤 花子', company: '東邦鋼業株式会社', postal_code: '5300001', prefecture: '大阪府', city: '大阪市北区', address: '梅田1-1-1', phone: '0663456789', email: 'hanako.sato@toho-kogyo.example.com' },
  },
  {
    id: 'C-1003',
    raw: '鈴木 一郎 様（株式会社サンプル商事）〒460-0008 愛知県名古屋市中区栄3-4-5 サンプルビル2F 電話: ０５２－１１１－２２２２ メール ichiro@sample-shoji.example.jp',
    gold: { customer_id: 'C-1003', name: '鈴木 一郎', company: '株式会社サンプル商事', postal_code: '4600008', prefecture: '愛知県', city: '名古屋市中区', address: '栄3-4-5 サンプルビル2F', phone: '0521112222', email: 'ichiro@sample-shoji.example.jp' },
  },
  {
    id: 'C-1004',
    raw: 'NEXTForward株式会社 / 高橋 美咲 / 〒 810-0001 福岡県福岡市中央区天神2-2-2 / Tel 092-333-4444 / Misaki@Nextforward.Example.jp',
    gold: { customer_id: 'C-1004', name: '高橋 美咲', company: 'NEXTForward株式会社', postal_code: '8100001', prefecture: '福岡県', city: '福岡市中央区', address: '天神2-2-2', phone: '0923334444', email: 'misaki@nextforward.example.jp' },
  },
  {
    id: 'C-1005',
    raw: '田中 健（合同会社テスト工業） 〒060-0001 北海道札幌市中央区北一条西1-1 電話 011-555-6666 mail ken.tanaka@test-kogyo.example.jp',
    gold: { customer_id: 'C-1005', name: '田中 健', company: '合同会社テスト工業', postal_code: '0600001', prefecture: '北海道', city: '札幌市中央区', address: '北一条西1-1', phone: '0115556666', email: 'ken.tanaka@test-kogyo.example.jp' },
  },
];

export function buildPrompt(c) {
  return SYS + '\n\n--- 入力 ---\n' + c.raw + '\n--- ここまで ---\ncustomer_id は "' + c.id + '" としてください。';
}

// LLM応答からJSON本体を取り出す（コードフェンス・前置き混入に耐える）。
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// 全角数字(U+FF10-FF19)を半角へ。これが無いと全角TELが「数字0桁」に化ける。
export function toHalfWidthDigits(s) {
  return String(s).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

export function canon(field, v) {
  if (v === null || v === undefined) return '';
  let s = toHalfWidthDigits(String(v)).trim();
  if (field === 'phone') return s.replace(/[^0-9]/g, '');
  if (field === 'postal_code') return s.replace(/[^0-9]/g, '');
  if (field === 'email') return s.toLowerCase();
  s = s.replace(/[\s　]+/g, ' ');
  s = s.replace(/\s*(様|さん)$/, '');
  return s.trim();
}

// gold と予測を突き合わせる。schemaOk は「9キーが過不足なく揃い、JSONとして読めた」こと。
export function scoreRecord(gold, got) {
  if (!got || typeof got !== 'object') return { schemaOk: false, matched: 0, total: FIELDS.length, perField: {} };
  const keys = Object.keys(got);
  const schemaOk = keys.length === FIELDS.length && FIELDS.every((f) => keys.includes(f));
  const perField = {};
  let matched = 0;
  for (const f of FIELDS) {
    const ok = canon(f, got[f]) === canon(f, gold[f]);
    perField[f] = ok;
    if (ok) matched += 1;
  }
  return { schemaOk, matched, total: FIELDS.length, perField };
}

// numGpu=0 は CPU 実行を強制する。既定を 0 にしているのは、この PC の Ollama が
// CUDA の PTX 不一致（0xc0000409 / "unsupported toolchain"）で llama-server ごと
// 落ちるため。GPU が正常な環境では --num-gpu 99 等で上書きしてよい。
function ollamaCall(model, prompt, host, numGpu) {
  return fetch(host + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
      options: { temperature: 0, num_gpu: numGpu },
    }),
  });
}

// クラウド経路: 既存の統合CLI(llm-ask.mjs)を子プロセスで呼ぶ。--no-fallback で
// 「実際にどのプロバイダが答えたか」を1本に固定し、失敗は失敗として数える。
function cloudCall(root, provider, model, prompt, timeoutMs) {
  const ask = path.join(root, 'tools', 'llm-ask.mjs');
  const r = spawnSync(process.execPath, [ask, '--provider', provider, '--model', model, '--no-fallback', '--max', '1200', prompt], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}

async function runLocal(root, model, host, timeoutMs, numGpu) {
  const rows = [];
  for (const c of CASES) {
    const prompt = buildPrompt(c);
    const t0 = Date.now();
    let text = '';
    let err = '';
    try {
      const res = await ollamaCall(model, prompt, host, numGpu);
      const j = await res.json();
      // Ollama はサーバ側で落ちても HTTP 500 + {error} を返す。例外ではないので明示的に拾う
      // （拾わないと「無言の0点」になり、モデル品質の問題と誤読する）。
      if (j && j.error) err = 'ollama: ' + String(j.error).slice(0, 200);
      else text = (j.message && j.message.content) || '';
    } catch (e) { err = String(e && e.message || e); }
    rows.push({ caseId: c.id, ms: Date.now() - t0, text, err, egress: 0 });
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const localModel = opt('--local-model', 'qwen2.5:3b');
  const host = opt('--ollama', 'http://127.0.0.1:11434');
  const timeoutMs = parseInt(opt('--timeout', '90000'), 10);
  const localOnly = args.includes('--local-only');
  const cloudSpecs = [
    { name: 'cloud:openrouter/qwen3-coder-flash', provider: 'openrouter', model: 'qwen/qwen3-coder-flash' },
    { name: 'cloud:groq/gpt-oss-120b', provider: 'groq', model: 'openai/gpt-oss-120b' },
  ];

  const results = [];

  const numGpu = parseInt(opt('--num-gpu', '0'), 10);
  const lrows = await runLocal(root, localModel, host, timeoutMs, numGpu);
  results.push({ name: 'local:ollama/' + localModel + (numGpu === 0 ? ' (CPU)' : ''), offDevice: false, rows: lrows });

  if (!localOnly) {
    for (const spec of cloudSpecs) {
      const rows = [];
      for (const c of CASES) {
        const prompt = buildPrompt(c);
        const t0 = Date.now();
        const r = cloudCall(root, spec.provider, spec.model, prompt, timeoutMs);
        rows.push({
          caseId: c.id,
          ms: Date.now() - t0,
          text: r.stdout,
          err: r.status === 0 ? '' : ('exit=' + r.status + ' ' + String(r.stderr).slice(0, 200)),
          egress: Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(r.stdout || '', 'utf8'),
        });
      }
      results.push({ name: spec.name, offDevice: true, rows });
    }
  }

  const out = [];
  out.push('', '| 経路 | schema適合 | 項目一致率 | 平均遅延 | 5件合計 | データ出境量 |', '|---|---:|---:|---:|---:|---:|');
  const detail = [];
  for (const r of results) {
    let schema = 0, matched = 0, total = 0, sumMs = 0, sumEg = 0, calls = 0;
    for (const row of r.rows) {
      const cs = CASES.find((c) => c.id === row.caseId);
      const got = extractJson(row.text);
      const sc = scoreRecord(cs.gold, got);
      if (sc.schemaOk) schema += 1;
      matched += sc.matched; total += sc.total;
      sumMs += row.ms; sumEg += row.egress; calls += 1;
      detail.push({ ...r, ...row, schemaOk: sc.schemaOk, matched: sc.matched, total: sc.total, perField: sc.perField });
    }
    out.push('| ' + r.name + ' | ' + schema + '/' + calls + ' | ' + matched + '/' + total + ' (' + (total ? Math.round(matched / total * 100) : 0) + '%) | ' + Math.round(sumMs / calls) + 'ms | ' + (sumMs / 1000).toFixed(1) + 's | ' + (r.offDevice ? sumEg + ' B (外部送信)' : '0 B (端末内)') + ' |');
  }

  console.log(out.join('\n'));
  console.log('\n### ケース別');
  for (const d of detail) {
    console.log('- ' + d.name + ' ' + d.caseId + ': schema=' + (d.schemaOk ? 'OK' : 'NG') + ' 一致=' + d.matched + '/' + d.total + ' ' + d.ms + 'ms' + (d.err ? ' ERR=' + d.err : ''));
  }
  console.log('\n### 不一致だった項目');
  for (const d of detail) {
    const bad = FIELDS.filter((f) => !d.perField[f]);
    if (bad.length) console.log('- ' + d.name + ' ' + d.caseId + ': ' + bad.join(', '));
  }

  const outFile = opt('--out', '');
  if (outFile) {
    const lines = ['', ...out, '', '### 生データ', '', '```json', JSON.stringify(detail.map((d) => ({ model: d.name, case: d.caseId, ms: d.ms, schemaOk: d.schemaOk, matched: d.matched, total: d.total, err: d.err })), null, 1), '```'];
    fs.appendFileSync(outFile, lines.join('\n') + '\n');
    console.log('\n[written] ' + outFile);
  }
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === 'customer-data-local-vs-cloud.mjs';
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
