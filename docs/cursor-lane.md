# Cursor レーン

Claude Code の利用枠を減らすため、GitHub リポジトリのまとまったコード修正は Cursor cloud agent に渡す。Cursor の割当は Claude Code とは別で、いま使っていない枠を使う。追加の API キーも、従量課金のサービスも使わない。

起動するプログラム（Grok Bot の毎時ポーラー）は、このリポジトリの外にある。ここには、Claude Code 側とポーラー側が守る契約だけを書く。

## 誰が何をするか

対象は、このリポジトリの共通ルールを読む全アカウントである。kim@orgiast.jp、cr@orgiast.jp、seisaku-team@orgiast.jp、nishi@orgiast.jp を含む。

- Claude Code は、数行を超えるリポジトリのコード修正を自分で実装しない。`tools/cursor-handoff.mjs` で issue を立て、できた PR を確認するだけにする。
- 数行の軽い修正（typo、リネーム、import 追加、1ファイルの数行）と、GitHub に上げない PC ローカル作業は、これまでどおり Claude Code または Codex で行う。
- オーナーの Grok Bot は、開いている `cursor-agent` issue を毎時見て、1 issue につき Cursor cloud agent を1つ起動する。Bot 自身はコードを書かない。
- Cursor cloud agent は issue の内容で実装し、PR を出す。

## ラベル

| ラベル | 状態 | 誰が付けるか |
|---|---|---|
| `cursor-agent` | 待ち行列。ポーラーが拾う open issue | `cursor-handoff.mjs` |
| `cursor-agent:running` | Cursor cloud agent が着手した | ポーラー。`cursor-agent` を外して付け替える |
| `cursor-agent:done` | PR ができた | ポーラー。`cursor-agent:running` を外して付け替える |

ポーラーは `cursor-agent` が付いた open issue だけを起動する。`cursor-agent:running` と `cursor-agent:done` は起動しない。これで同じ issue に agent を重ねない。

handoff は、対象リポジトリにこの3つのラベルが無ければ作る。issue 自体に付けるのは `cursor-agent` だけである。

## issue の中身

```sh
node tools/cursor-handoff.mjs \
  --repo owner/name \
  --title "何を直すか" \
  --body-file task.md \
  --from "kim@orgiast.jp / kim-PC / セッションID"
```

`--body` と `--body-file` はどちらか一方。`--dry-run` は gh を呼ばず、作る予定の issue を表示して終わる。

`task.md` には次を書く。

- 目的
- 受け入れ条件
- 触るファイル・範囲
- テストの仕方
- 依頼元（どのアカウント・どの PC・どのセッションが頼んだか）。`--from` にも同じものを書き、ツールが本文の先頭に再掲する

トークン、鍵、パスワードは issue に書かない。ツールはそれららしい文字列があると作らずに止まる。

gh がインストールされていない、または `gh auth status` が失敗するときは、issue を作る前に理由を出して止まる。認証は各 PC の既存の `gh auth login` だけで、新しい資格情報は作らない。

## PR

Cursor cloud agent が出す PR の本文に、対象 issue への `Closes #N` を入れる。N はその issue の番号である。マージすると GitHub が issue を閉じる。

ポーラーは PR ができたことを確認し、ラベルを `cursor-agent:done` に付け替える。Claude Code は、その PR の diff とテスト結果を見て受け入れるか差し戻す。

## ポーラーの契約（このリポジトリの外）

オーナーの Grok Bot が、毎時、次を行う。

1. 対象リポジトリの open issue のうち、ラベル `cursor-agent` が付いているものを列挙する。
2. issue ごとに Cursor cloud agent を1つ起動する。指示は issue 本文。完了条件は、PR を出し、本文に `Closes #N` を含めること。
3. 起動できたら `cursor-agent` を外し、`cursor-agent:running` を付ける。起動に失敗した issue は `cursor-agent` のまま残し、次の時刻に再試行する。
4. PR ができている issue は `cursor-agent:done` に付け替える。
5. `cursor-agent` が残っている issue だけを待ち行列とする。running や done には新しい agent を起動しない。
