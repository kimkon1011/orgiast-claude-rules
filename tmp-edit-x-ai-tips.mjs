import fs from 'node:fs';
const src = fs.readFileSync('tools/x-ai-tips-collect.mjs', 'utf8');

// 1. Add likesCondition after 'const from' line
const result = src.replace(
  'export function buildRequest(topic, now, config, isFallback = false) {\n  const from = new Date(+now - 2 * DAY).toISOString();\n  return {',
  `export function buildRequest(topic, now, config, isFallback = false) {
  const from = new Date(+now - 2 * DAY).toISOString();
  const likesCondition = isFallback
    ? 'likes が確認できない場合は likes を省略してよい。ただし出典 URL（x.com の投稿 URL）は必須。'
    : \`likes が \${config.minLikes} 未満または確認不能の投稿は除外。\`;
  return {`
);

// 2. Replace hardcoded likes condition with variable
const result2 = result.replace(
  '宣伝だけ、感想だけ、出典不明の数値、likes が ${config.minLikes} 未満または確認不能の投稿は除外。手順・数値は投稿に実在するものだけ。見つからなければ items:[]。',
  '宣伝だけ、感想だけ、出典不明の数値、${likesCondition}手順・数値は投稿に実在するものだけ。見つからなければ items:[]。'
);

if (result === src) {
  console.error('FAIL: pattern 1 did not match');
  process.exit(1);
}
if (result2 === result) {
  console.error('FAIL: pattern 2 did not match');
  process.exit(1);
}

fs.writeFileSync('tools/x-ai-tips-collect.mjs', result2, 'utf8');
console.log('OK: buildRequest updated');