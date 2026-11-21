# Phase 1: media-master.ts のみ

`tools/gakkai-media/media-master.ts` を新規作成せよ。探索不要。以下が全仕様。

## media-master.ts

```typescript
export interface Media {
  name: string;
  type: '新聞' | '雑誌' | 'Web' | 'ラジオ' | 'テレビ';
  reading_demo: string;
  source: string;
}

const MEDIA_LIST: Media[] = [
  // 新聞(7)
  { name: '日経新聞', type: '新聞', reading_demo: '40代〜60代のビジネス層・経営者', source: 'knowledge' },
  { name: '朝日新聞', type: '新聞', reading_demo: '40代〜70代のリベラル層・知識層', source: 'knowledge' },
  { name: '読売新聞', type: '新聞', reading_demo: '40代〜70代の保守層・ファミリー層', source: 'knowledge' },
  { name: '毎日新聞', type: '新聞', reading_demo: '40代〜70代の知識層', source: 'knowledge' },
  { name: '産経新聞', type: '新聞', reading_demo: '50代〜70代の保守層', source: 'knowledge' },
  { name: '日本経済新聞電子版', type: '新聞', reading_demo: '30代〜50代のビジネス層', source: 'knowledge' },
  { name: '中日新聞', type: '新聞', reading_demo: '40代〜70代の東海圏居住者', source: 'knowledge' },
  // 雑誌(5)
  { name: '週刊文春', type: '雑誌', reading_demo: '40代〜60代の男性・スクープ関心層', source: 'knowledge' },
  { name: '週刊新潮', type: '雑誌', reading_demo: '40代〜60代の男性', source: 'knowledge' },
  { name: '日経ビジネス', type: '雑誌', reading_demo: '30代〜50代のビジネスパーソン', source: 'knowledge' },
  { name: '東洋経済', type: '雑誌', reading_demo: '30代〜50代のビジネスパーソン', source: 'knowledge' },
  { name: 'プレジデント', type: '雑誌', reading_demo: '30代〜50代のビジネスパーソン', source: 'knowledge' },
  // Web(7)
  { name: 'Yahoo! JAPAN', type: 'Web', reading_demo: '20代〜60代の全般層', source: 'knowledge' },
  { name: 'Google広告', type: 'Web', reading_demo: '20代〜60代の全般層（検索行動による）', source: 'knowledge' },
  { name: 'Instagram', type: 'Web', reading_demo: '10代〜40代の女性中心', source: 'knowledge' },
  { name: 'X（Twitter）', type: 'Web', reading_demo: '20代〜50代の情報感度の高い層', source: 'knowledge' },
  { name: 'YouTube', type: 'Web', reading_demo: '10代〜40代の全般層', source: 'knowledge' },
  { name: 'LINE', type: 'Web', reading_demo: '10代〜50代の全般層（国内最大級のMAU）', source: 'knowledge' },
  { name: 'ABEMA', type: 'Web', reading_demo: '20代〜40代のネットネイティブ層', source: 'knowledge' },
  // ラジオ(4)
  { name: 'J-WAVE', type: 'ラジオ', reading_demo: '20代〜40代の都市部住民', source: 'knowledge' },
  { name: 'TOKYO FM', type: 'ラジオ', reading_demo: '20代〜50代の首都圏住民', source: 'knowledge' },
  { name: 'TBSラジオ', type: 'ラジオ', reading_demo: '40代〜60代の男性中心', source: 'knowledge' },
  { name: 'ニッポン放送', type: 'ラジオ', reading_demo: '40代〜60代の全般層', source: 'knowledge' },
  // テレビ(5)
  { name: '日本テレビ', type: 'テレビ', reading_demo: '10代〜70代の全般層', source: 'knowledge' },
  { name: 'テレビ朝日', type: 'テレビ', reading_demo: '10代〜70代の全般層', source: 'knowledge' },
  { name: 'TBSテレビ', type: 'テレビ', reading_demo: '10代〜70代の全般層', source: 'knowledge' },
  { name: 'フジテレビ', type: 'テレビ', reading_demo: '10代〜70代の全般層', source: 'knowledge' },
  { name: 'テレビ東京', type: 'テレビ', reading_demo: '30代〜60代の都心部居住者', source: 'knowledge' },
];

export function listAll(): Media[] { return MEDIA_LIST; }
export function findByName(name: string): Media | undefined { return MEDIA_LIST.find(m => m.name === name); }
```

**完了条件**: このファイルを tools/gakkai-media/media-master.ts に書き、`npx tsx -e "const {listAll}=require('./tools/gakkai-media/media-master'); console.log(listAll().length)"` が `26` を出力すること。