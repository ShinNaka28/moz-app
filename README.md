# 🔒 完全ローカル完結型 AI＆追従モザイクエディター (`moz-app`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub%20Pages-success.svg)](https://pages.github.com/)
[![Local Only](https://img.shields.io/badge/Security-Zero%20Network%20Access-emerald.svg)]()

個人情報・プライバシー保護のため、**外部サーバーと一切通信せずブラウザ内（iPhone Safari / Android Chrome / PC）だけで完結**する動画（.mp4）および静止画のモザイクWebアプリケーションです。

「不規則に動く人物の顔」のAI自動追跡だけでなく、「カメラのパン・移動に伴って動くPC画面内の機密情報や書類・名札（ユーザー指定領域）」へのオプティカルフロー自動追従、画面外へ出た際の自動消去、適用時間（In点〜Out点）の自由指定、音声トラックを保持したブラウザ内MP4書き出しに対応しています。

---

## 🛡️ なぜ動画・画像データが外部に一切漏れないのか？

本アプリは、企業の機密情報や医療・教育現場、街頭撮影などのプライバシーを極めて安全に取り扱えるよう、**ゼロ通信アーキテクチャ**を採用しています。

### 1. メモリ内完結処理（File API / Blob URL）
動画や画像を開く際、一般的なWebサービスのようにクラウドサーバーへアップロードすることは一切ありません。ブラウザの `File API` と `URL.createObjectURL` を利用して端末のローカルメモリ上にのみ展開し、HTML5 `<canvas>` 上で直接画像処理を行います。

### 2. CSP（Content-Security-Policy）による外部送信の物理遮断
HTMLヘッダーに厳格なセキュリティポリシーを設定しています：
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self' blob: data:; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; connect-src 'self' blob: data:; worker-src 'self' blob:;" />
```
`connect-src 'self' blob: data:;` により、JavaScript からの `fetch`、`XMLHttpRequest`、`WebSocket`、外向きビーコン送信などが**ブラウザエンジンレベルで強制遮断**されます。悪意のあるスクリプトや外部拡張機能が存在しても、データを外部へ送信することは不可能です。

### 3. AIモデル・推論エンジンの完全ローカル配備（機内モード動作可）
MediaPipeの推論用WASMバイナリ（`public/wasm/`）および顔検出モデル `blaze_face_short_range.tflite`（`public/models/`）はすべてWebアプリ本体に同梱されています。クラウド推論APIを呼び出すのではなく、**端末のローカルCPU/GPU上で直接推論**するため、**機内モード（完全オフライン）**でも問題なく高速動作します。

---

## ✨ 主な機能

### ① AIによる人物・顔の自動追従（不規則な動きに対応）
- **自動検出 & Track ID付与**: MediaPipeによりフレーム内の人物・顔を検出し、フレーム間のIoU・重心距離トラッキングにより各人物へID（人物 #1, #2...）を割り当てて追跡。
- **個別ON / OFF**: 画面上の検出枠をタップするか、サイドパネルの目玉アイコンから「この人物はモザイクON / この人物はOFF」を個別に切り替え可能（一括ON/OFFボタンも搭載）。
- **見失い補間（残像バッファ）**: 人物が急に横を向いたり素早く動いて一時的に検出が途切れても、直前の移動ベクトル（速度・方向）から予測位置を一定フレーム維持し、素顔のチラ見えを徹底防止。

### ② ユーザー指定領域の自動追従（PC画面・書類・名札等のトラッキング）
- **直感的な3つの指定方法**:
  - **矩形追従（Square）**: ドラッグして四角形領域を指定
  - **自由曲線ブラシ（Paintbrush）**: 指やマウスで自由になぞって指定
  - **ポリゴン（Pentagon）**: クリック/タップして多角形領域を指定
- **自動追従（Lucas-Kanade オプティカルフロー ＋ Median Flow）**: 指定領域内の特徴点（高輝度勾配）をサンプリングし、カメラのパン・チルトや対象の移動に合わせて毎フレーム座標を自動追従。
- **画面外（フレームアウト）自動消去**: カメラ移動等で追跡対象が画面境界外へ出た場合や、追跡信頼度が低下した場合は、モザイク描画を自動的に非表示（消去）。
- **手動キーフレーム補正（ズレ修正）**: 自動追従がズレた場合は動画を一時停止し、枠をドラッグ移動させて「位置を補正 (Key)」を押すことでキーフレームとして記録。前後のフレーム座標を滑らかに線形補間（再計算）。

### ③ モザイク適用時間（タイムライン）の指定機能
- **トラック別タイムラインバー**: 各モザイクの「開始時間（In点）」〜「終了時間（Out点）」をタイムラインバーで視覚化。左右ハンドルをドラッグして直感的に伸縮可能。
- **クイックIn/Out指定**: 「[ In点指定」「Out点指定 ]」ボタンで、現在の再生位置をワンタップで開始点・終了点に設定。
- **フレーム単位のシーク**: $\pm 1/30$ 秒単位のコマ送り・コマ戻しボタンを搭載。

### ⑤ 選択外モザイク（反転モザイク / 背景保護機能）
- **選択領域以外の「背景全体」をモザイク化**: 指定した人物やPC画面だけを高精細でクリアに残し、それ以外の散らかった背景・周囲の人・不要な画面全体をワンクリックで一括モザイク/すりガラス/黒塗り可能。
- **Even-Odd クリッピング**: 複数人や複数画面を保護対象として同時指定した場合でも、対象領域のみを綺麗にくり抜いて背景全体にモザイクを適用。

### ⑥ 高精度ハイブリッド自動追従（Auto Track）
- **大域探索ブロックマッチング（SAD）＋サブピクセルLucas-Kanade＋Median Flow**: カメラの急激なパン（左右の移動）や対象の素早い動きにも見失わずに自動追従。
- **区間トラッキング解析**: ユーザーが領域を指定した際や「自動追従を解析」ボタンを押すことで、In点〜Out点の動画フレームを高密度に先読みトラッキングしてキーフレームを自動生成。再生やシーク時にもピタッと貼り付く追従性を実現。
- **AI顔検出の35%安全マージン**: 顔検出境界に自動でパディングを付加し、首振りや動きに伴う素顔のチラ見えを徹底防止。

---

## 🚀 GitHub Pages への公開手順

本リポジトリには、GitHub Pagesへの自動ビルド・デプロイを行う GitHub Actions ワークフロー（`.github/workflows/deploy.yml`）が含まれています。

### 手順
1. GitHub で新規リポジトリ `moz-app` を作成します。
2. ローカルコードをプッシュします：
   ```bash
   git init
   git add .
   git commit -m "feat: Initial commit for privacy mosaic app"
   git branch -M main
   git remote add origin https://github.com/<YOUR-USERNAME>/moz-app.git
   git push -u origin main
   ```
3. GitHub リポジトリの **Settings** > **Pages** を開きます。
4. **Build and deployment** の **Source** を **「GitHub Actions」** に設定します。
5. プッシュと同時に GitHub Actions が自動実行され、数分で `https://<YOUR-USERNAME>.github.io/moz-app/` に公開されます。

※ 別のリポジトリ名で公開する場合は、`vite.config.ts` および `.github/workflows/deploy.yml` 内の `BASE_PATH` を変更してください。

---

## 💻 ローカルでの開発・実行手順

### 必要環境
- Node.js 18+ (推奨 20+)
- npm または pnpm

### コマンド
```bash
# 依存関係のインストール
npm install

# 開発サーバー起動（PC & スマホからアクセス可能）
npm run dev

# プロダクションビルド
npm run build
```

開発サーバー起動後、ブラウザで `http://localhost:5173/` にアクセスしてください。

---

## 📄 ライセンス
MIT License

