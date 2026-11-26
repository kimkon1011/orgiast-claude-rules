## 概要

竹 premium のみ Gemini が寸法下絵を大きく再設計していた問題を、下絵とブリーフの曖昧さに沿って修正しました。

## 変更

- premium 下絵へ、寸法枠内・背面壁固定の小型楕円発光膜3個を追加
- 生成ブリーフから `Glowing Lantern` を外し、既存形状の質感仕上げだけを指示
- Geminiのみで再生成し、1回目を目視合格（巨大吊り物・背景置換・人物消去なし）
- Driveへ新規アップロードし、kim@ writerを読み戻し確認

## 検証

- `node --test tools/booth-perse-gen.test.mjs` — 26 pass / 0 fail
- Blender内蔵Pythonで `tools/booth-3d/check-underlay-edge.test.py` — 5 pass / OK
- Gemini実費: $0.141644

## 成果物

- https://drive.google.com/file/d/15EqkcwvZo0VBEY46aEmu2-i3ZvZ-SStp/view?authuser=kim@orgiast.jp
