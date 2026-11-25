// cache-audit.mjs — Anthropic SDK呼び出しの大きな安定prefixに cache_control が無い候補を静的検出する（書換えなし）。
import fs from 'node:fs'; import path from 'node:path';

const roots = process.argv.slice(2).filter((x) => !x.startsWith('-'));
if (!roots.length) roots.push('.');
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.py']);
const ignored = new Set(['node_modules', '.next', 'dist', '.git']);
const files = [];

function walk(p) {
  let st; try { st = fs.statSync(p); } catch { return; }
  if (st.isFile()) { if (exts.has(path.extname(p))) files.push(p); return; }
  let es = []; try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
  for (const e of es) if (!ignored.has(e.name)) walk(path.join(p, e.name));
}
for (const r of roots) walk(path.resolve(r));

function lineOf(s, at) { return s.slice(0, at).split('\n').length; }

// 文字列を飛ばしながら、式を終えるトップレベルの区切り位置を探す。
function expressionEnd(src, start, stops) {
  const stack = [];
  let quote = '', triple = false, escaped = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (triple && src.startsWith(quote.repeat(3), i)) { i += 2; quote = ''; triple = false; continue; }
      if (!triple && c === quote) quote = '';
      continue;
    }
    if ((c === "'" || c === '"') && src.startsWith(c.repeat(3), i)) { quote = c; triple = true; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i + 2); i = nl < 0 ? src.length : nl - 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const close = src.indexOf('*/', i + 2); i = close < 0 ? src.length : close + 1; continue; }
    if (c === '#') { const nl = src.indexOf('\n', i + 1); i = nl < 0 ? src.length : nl - 1; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      if (!stack.length && stops.has(c)) return i;
      stack.pop();
    } else if (!stack.length && stops.has(c)) {
      // 演算子の直後で改行した連結式は、次の行まで定義の右辺に含める。
      if (c === '\n' && ['+', ',', '\\'].includes(src.slice(start, i).trimEnd().at(-1))) continue;
      return i;
    }
  }
  return src.length;
}

function definitions(src, isPython) {
  const out = new Map();
  const re = isPython
    ? /^\s*([A-Za-z_]\w*)\s*=\s*/gm
    : /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m;
  while ((m = re.exec(src))) {
    const end = expressionEnd(src, re.lastIndex, new Set(isPython ? ['\n'] : [';', '\n']));
    out.set(m[1], src.slice(re.lastIndex, end));
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return out;
}

// リテラル部分の概算長と、文字列の外にある識別子を同時に得る。
function expressionParts(src) {
  let literal = 0, masked = '', quote = '', triple = false, escaped = false, interpolationDepth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      masked += ' ';
      if (escaped) { escaped = false; literal++; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (triple && src.startsWith(quote.repeat(3), i)) { masked += '  '; i += 2; quote = ''; triple = false; continue; }
      if (!triple && c === quote) { quote = ''; continue; }
      if (quote === '`' && c === '$' && src[i + 1] === '{') {
        // テンプレート埋め込み自体はリテラル長に含めない。
        masked += ' ';
        i++;
        interpolationDepth = 1;
        while (++i < src.length && interpolationDepth) {
          const d = src[i]; masked += d;
          if (d === '{') interpolationDepth++;
          else if (d === '}') interpolationDepth--;
        }
        continue;
      }
      literal++;
      continue;
    }
    if ((c === "'" || c === '"') && src.startsWith(c.repeat(3), i)) { quote = c; triple = true; masked += '   '; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; masked += ' '; continue; }
    masked += c;
  }
  const identifiers = [...masked.matchAll(/\b[A-Za-z_$][\w$]*\b/g)].map((m) => m[0]);
  return { literal, identifiers };
}

function evaluator(defs) {
  const memo = new Map();
  function resolve(name, depth = 0, visiting = new Set()) {
    if (memo.has(name)) return memo.get(name);
    if (depth > 2 || visiting.has(name) || !defs.has(name)) return 0;
    const next = new Set(visiting); next.add(name);
    const parts = expressionParts(defs.get(name));
    let n = parts.literal;
    for (const id of new Set(parts.identifiers)) n += resolve(id, depth + 1, next);
    memo.set(name, n);
    return n;
  }
  return function evaluate(expr) {
    const parts = expressionParts(expr);
    let n = parts.literal;
    const via = [];
    for (const id of new Set(parts.identifiers)) {
      if (!defs.has(id)) continue;
      const added = resolve(id);
      n += added;
      if (added > 0) via.push(id);
    }
    return { n, via };
  };
}

function callChunk(src, openParen) {
  const end = expressionEnd(src, openParen + 1, new Set([')']));
  return src.slice(openParen + 1, end);
}

function fieldExpression(chunk, name, isPython) {
  const separator = isPython ? '[:=]' : ':';
  const re = new RegExp(`\\b${name}\\s*${separator}\\s*`, 'g');
  const m = re.exec(chunk);
  if (!m) return '';
  const end = expressionEnd(chunk, re.lastIndex, new Set([',', '\n', '}', ')']));
  return chunk.slice(re.lastIndex, end);
}

const hits = [];
for (const f of files) {
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!/(?:new\s+Anthropic\s*\(|anthropic\.messages\.create|messages\.batches\.create)/i.test(s)) continue;
  const isPython = path.extname(f) === '.py';
  const evaluate = evaluator(definitions(s, isPython));
  const callRe = /(?:anthropic\.messages\.create|messages\.batches\.create)\s*\(/gi;
  let m;
  while ((m = callRe.exec(s))) {
    const openParen = callRe.lastIndex - 1;
    const chunk = callChunk(s, openParen);
    if (/cache_control\s*[:=]/i.test(chunk)) continue;
    const system = evaluate(fieldExpression(chunk, 'system', isPython));
    const tools = evaluate(fieldExpression(chunk, 'tools', isPython));
    const best = system.n >= tools.n ? { ...system, field: 'system' } : { ...tools, field: 'tools' };
    if (best.n >= 4000) hits.push({ f, line: lineOf(s, m.index), ...best });
  }
}

for (const h of hits) {
  const via = h.via.length ? ` (${h.via.join(', ')} 経由)` : '';
  console.log(`${path.relative(process.cwd(), h.f) || h.f}:${h.line} — ${h.field} 約${h.n}文字${via} / cache_control なし`);
}
console.log(`候補 ${hits.length} 件`);
console.log("安定した system/tools prefix の最後のcontent blockへ cache_control: { type: 'ephemeral' } を付けます。");
console.log('安定 prefix は先頭に固定し、日時・ID・ユーザー入力などの動的値は後ろへ置きます。');
console.log('正規表現ベースの候補検出なので、適用前に呼出し構造と5分以内の再利用有無を確認してください。');
