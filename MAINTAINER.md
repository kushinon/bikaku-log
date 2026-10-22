# ビカクログ 管理者向けメモ

アプリを公開・更新する人（このリポジトリの持ち主）や、改造して自分で公開したい人向けのメモです。
ふつうに使うだけの人は [README.md](README.md) を見てください。

---

## ひな形のスプレッドシートを作る（README の「方法A」用）

利用者が「コピーを作成」するだけで設置できるように、**コード入りで、データの入っていない** スプレッドシートを用意します。

> ⚠️ **自分が記録に使っているスプレッドシートを、ひな形として共有しないでください。** 記録が丸見えになります。
> 必ず、ひな形専用に新しく作ります。

1. <https://sheets.new> で新しいスプレッドシートを作り、名前を **「ビカクログ」** にします。
2. **拡張機能 → Apps Script** を開き、`gas/Code.gs` の中身で **すべて置き換えて** 保存します。プロジェクト名も「ビカクログ」にします。
3. 次のことは **しない** でください（コピーした人に引き継がれたり、ひな形にデータが残ったりします）。
   - スクリプト プロパティに `PASSCODE` を設定する（コピーにも引き継がれます）
   - 関数の実行やデプロイ
4. （任意）1枚目のシートに「拡張機能 → Apps Script を開き、README の STEP 2 へ進んでください」などと書いておくと親切です。
5. 右上の **「共有」** → 「一般的なアクセス」を **「リンクを知っている全員」・「閲覧者」** にして **「リンクをコピー」** を押します。
6. コピーしたリンクは次の形です。最後の `/edit…` の部分を **`/copy`** に置き換えます。
   ```
   https://docs.google.com/spreadsheets/d/（ID）/edit?usp=sharing
   ↓
   https://docs.google.com/spreadsheets/d/（ID）/copy
   ```
   このリンクを開くと「コピーを作成」の画面が直接出ます。
7. README の「方法A」の「準備中です」の行を、このリンクに置き換えます。

`gas/Code.gs` を更新したときは、ひな形の Apps Script も同じ内容に置き換えておきます。

---

## 画面を公開する（GitHub Pages）

1. リポジトリの **Settings → Pages** を開きます。
2. 「Branch」を **main**、フォルダを **/docs** にして **Save** を押します。
3. 数分で `https://（ユーザー名）.github.io/（リポジトリ名）/` で公開されます。

フォークして自分で公開する場合は、README の URL（`kushinon.github.io/bikaku-log`、`raw.githubusercontent.com/kushinon/…`）を自分のものに置き換えてください。

---

## 更新するとき

- **画面だけの変更**（`docs/` の中）：main に反映すれば、利用者の端末では開き直したときに自動で新しい版に切り替わります。
  `docs/sw.js` の `CACHE` の番号と、`docs/js/app.js` の `APP_VERSION` を上げてください。
- **サーバー側の変更**（`gas/src/server.js`）：`node tools/build-gas.js` で `gas/Code.gs` を作り直します。
  利用者はそれぞれ自分の Apps Script を貼り替えて「デプロイを管理 → 編集 → 新バージョン」をする必要があるので、
  **古いサーバーのままでも新しい画面が動くように**（通信の形を変えないように）してください。
- `docs/js/shared.js`（水やり判定）はサーバーにも含まれますが、サーバー側で使うのはメール通知だけです。

---

## ファイル構成

```
docs/                    … 画面（GitHub Pages で公開する部分）
  index.html
  css/style.css
  js/app.js              … 画面・端末への保存・同期
  js/shared.js           … 水やり判定とサンプルデータ（画面とサーバーで共通）
  js/importer.js         … Keep などのメモの読み取り
  sw.js                  … オフラインで開けるようにする仕組み
  manifest.webmanifest   … ホーム画面用の設定
  icons/                 … アイコン
gas/
  Code.gs                … Apps Script に貼り付けるコード（自動生成）
  src/server.js          … サーバー側の元のコード
tools/
  build-gas.js           … gas/src/server.js と docs/js/shared.js から gas/Code.gs を作る
```
