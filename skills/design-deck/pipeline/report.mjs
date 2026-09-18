import fs from 'node:fs';
import path from 'node:path';
import {dir,out,title,readJSON} from './runtime.mjs';
const optional=(file,fallback)=>fs.existsSync(file)?readJSON(file):fallback;
// Report only evidence from this build. Never copy the original project's approval or scores.
export function writeReport(){
  const pages=readJSON(path.join(dir,'pages.json'));
  const checks=optional(path.join(out,'build-checks.json'),{pages:[],warnings:['build未実行']});
  const pdf=optional(path.join(out,'pdf-info.json'),{});
  const preview=optional(path.join(out,'preview-checks.json'),{pages:[],issues:['preview未実行']});
  const review=optional(path.join(dir,'visual-review.json'),null);
  const log=optional(path.join(dir,'gen-visuals-log.json'),{runs:[]});
  const attempts=log.runs.flatMap(r=>r.pages.flatMap(p=>p.attempts??[]));
  const cell=s=>String(s??'').replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>');
  const rows=pages.map(p=>{
    const visual=checks.pages.find(c=>c.id===p.id)?.visual;
    const sources=p.directVisual?[p.directVisual]:p.photoSources??[];
    return `| ${cell(p.id)} ${cell(p.headline)} | ${cell(p.type)} | ${cell(sources.join(', '))} | ${cell(visual?.mode??'写真なし')} |`;
  });
  fs.writeFileSync(path.join(dir,'BUILD-REPORT.md'),`# ${title} BUILD REPORT

生成日時: ${new Date().toISOString()}

- PDF: [out/${title}.pdf](out/${encodeURIComponent(title)}.pdf) / ${pdf.pageCount??'未確認'}ページ / ${pdf.bytes??'未確認'} bytes
- HTML: [out/${title}.html](out/${encodeURIComponent(title)}.html)
- PNG: ${preview.pages.length}ページ / [一覧](out/preview-index.html)
- ビルド警告: ${checks.warnings.length}件 / [記録](out/build-checks.json)
- プレビュー問題: ${preview.issues.length}件 / [記録](out/preview-checks.json)
- 原稿表との照合: ${preview.sourceTablesVerified===true?'一致':preview.sourceTablesVerified===false?'不一致':'未実施（sourceHtml未指定）'}
- 画像生成の累計試行: ${attempts.length}回 / 失敗: ${attempts.filter(a=>!a.success).length}回 / [記録](gen-visuals-log.json)
- Drive・Git操作はこのパイプラインに含まない。

| ページ | 型 | 入力画像 | 採用方式 |
|---|---|---|---|
${rows.join('\n')}

## 修正事項

${[...checks.warnings,...preview.issues].map(x=>'- '+x).join('\n')||'機械チェックの問題なし。目視の代替にはならない。'}

## 全ページ目視採点（5点満点）

${review?`| ページ | 写真 | 余白 | 文字量 | 数字 | 一貫性 | 所見 |\n|---|---|---|---|---|---|---|\n${review.pages.map(r=>`| ${cell(r.page)} | ${r.photo??'対象外'} | ${r.space} | ${r.text} | ${r.numbers} | ${r.consistency} | ${cell(r.note)} |`).join('\n')}\n\n${review.summary??''}`:'未実施。全PNGをReadで目視し、visual-review.jsonに採点を記録する。'}

入力・CSSの修正後は古い採点を引き継がず、再出力した全ページを再目視する。3点以下は修正する。自己評価は社長承認の代わりではない。
`);
}
