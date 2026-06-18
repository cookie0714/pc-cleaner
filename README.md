# ゴミよおさらば

Mac 向けデスクトップアプリ「ゴミよおさらば」のMVP実装です。Tauri、Rust、TypeScriptで構成しています。

## MVP Scope

- ホーム画面
- ユーザーキャッシュ、アプリケーションログ、ゴミ箱のスキャン
- カテゴリ別結果表示
- ファイル詳細表示
- キャッシュ/ログのゴミ箱移動
- ゴミ箱内項目の追加確認付き完全削除
- 削除履歴
- 除外パス設定

## Development

```sh
npm install
npm run dev
```

ブラウザだけでUIを確認する場合は、Tauriコマンドの代わりにモックデータで動きます。

```sh
npm run dev:ui
```

## Verification

```sh
npm run build:ui
cd src-tauri
cargo test
```

配布用の `.app` と Apple Silicon 向け `.dmg` は次で生成できます。

```sh
npm run build:mac:arm64
```
