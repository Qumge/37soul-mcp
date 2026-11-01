# 37Soul

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語**

ひとつの持続する Soul が、あなたのマシン上の **Claude Code、Codex、OpenCode、Hermes、Pi**
と 37Soul.com をつなぎます。生の会話、コード、ツールログはローカルに留まり、Soul の
アイデンティティ、長期的な関係の好み、再利用できる経験だけが、あなたが明示的にログイン
して Soul を承認したあとに同期されます。

> **現状を正直に。** ローカルランタイムは実際の Rails API に対して、ログイン、初回
> ダウンロード、push/pull、取り消し、ウェブサイト側の修正を実装・テスト済みです。4 つの
> ホストアダプタにはローカルの実機 smoke 証拠（抽出）がありますが、完全なクロスセッション
> の適用（ウェブサイト修正 → 新しいネイティブセッション）はまだ独立検証中です。観測した
> CLI バージョンは下に記載しています。
> 全テスト: Node 24 ローカルで 383 件（Node 18 のバイナリがない場合、Node 18 下限チェック
> はスキップ。未パックの checkout では tarball チェックをスキップ）。tag CI は同じスイート
> を Node 20 で実行し、最新リリースでグリーンです。

## クラウドの位置づけ

37Soul 自体は無料で使えます。無料アカウントは会話の中で彼女の直近 **30 日** の記憶を
持ち込みます。サブスクリプションはこのウィンドウを外し——どちらの場合もデータは削除
されません——写真と動画用の credits を追加します。彼女を自分の agent にバインドしても
追加料金はかからず、Markdown / SOUL.md / MEMORY.md のエクスポートはすべてのアカウントで
無料です。

[料金](https://37soul.com/pricing?ref=mcp-readme-ja)

## クイックスタート: 新しい Soul を作る

macOS または Linux、Node.js 18+ が必要です。

```bash
curl -fsSL https://37soul.com/install.sh | bash
```

インストールは匿名優先です。**HTTP リクエストはゼロ**、検出した agent に hooks を書き込み、
ローカルランタイムを起動し、ローカルの `assets_only` プロファイルを作成します。この時点
では何もアップロードされません。

名前、性別、年齢（16–65）、50 文字以上のキャラクターでローカル Soul を作り、agent で
使います:

```bash
37soul soul create --name "Nyx" --sex female --age 24 \
  --character "小七是一位喜欢摄影与旅行的年轻女性，性格温和而独立，说话简洁自然。她喜欢先听清对方的想法，再分享自己的观察。" [--avatar ./avatar.png]
37soul soul select <soul_uid>
37soul status
```

agent を再起動します。新しいセッションはその Soul を読み込みます。同じ Soul をウェブ
サイトとマシンをまたいで使いたいときは、ログインして明示的に承認します。あなたが入力
したプロファイルは公開されますが、プライベートな会話と個人の記憶は公開されません:

```bash
37soul login
37soul soul authorize <soul_uid> --categories identity,relationship,experience
37soul sync
```

`37soul login` は承認ページを開きます。最初の sync が Soul を登録し、デバイスごとの
Consent を開きます。それまでのローカル Soul とキュー内のアセットはローカルに留まり、
**失敗ではありません**。ログイン後はウェブサイト側でアイデンティティとアセットを修正
でき、次のローカルセッションがその修正を取得します。

## クイックスタート: ウェブサイト上の既存 Soul を復元する

すでに 37Soul.com に Soul がある人向けの手順です。

1. 上のコマンドでランタイムをインストールします。
2. 実行します:

   ```bash
   37soul login
   ```

3. 承認ページで**既存の Soul** を選び、承認します。
4. CLI はこのデバイス用の scoped credential を受け取り、Soul、そのアイデンティティ、
   長期的なアセットを取得します。自動的にアカウントのデフォルトになります:

   ```
   Soul restored: <name> (<soul_uid>), <n> asset(s)
   ```

5. agent を再起動して作業を続けます。アイデンティティの source of truth はウェブサイト
   にあり、ローカルセッションはダウンロードしたコピーを使います。生の会話は決して
   アップロードされません。

選択した Soul がまだ届いていない場合、CLI はそう伝え、似たものを作らずにデフォルトを
未設定のままにします。接続できたら `37soul sync` を実行してください。

## 確認

```bash
37soul status
37soul doctor
37soul soul list
```

- `status` はマシン、scoped credential の数、保留中/隔離されたローカル変更を報告します。
  `login required` はローカル利用は可能だがまだ何も同期していない状態です。
- `doctor` はホストがそれらの状態を公開している場合、installed / loaded / trusted /
  gateway-only を区別します。ローカル送信キューのみはエラーではありません。ヒント行は
  `SOUL37_LANG`、`LC_ALL`、`LANG`（en / zh / ja）に従い、CLI のその他の出力は英語です。
- `not_run` はこのビルドでは実行できなかったチェック（ホストの実機ターン、Node 20 CI、
  GitHub Release）に使われます。合格として報告されることはありません。

## 同期するもの — しないもの

| データ | 保存場所 | 同期 |
| --- | --- | --- |
| Soul のアイデンティティ（名前、説明、キャラクター、挨拶） | ローカル + 37Soul | ログイン + Consent 後。ウェブサイトの修正が優先 |
| 関係アセット（安定した好み、目標、合意した進め方） | ローカル + 37Soul | 承認されたカテゴリのみ |
| 経験アセット（再利用できる方法） | ローカル + 37Soul | 承認されたカテゴリのみ |
| 生の会話、プロンプト、コード、ツールログ | ローカルのみ | **決してアップロードしない** |
| レガシー brief / 会話の書き戻し（`log_turn`、`remember`、`resume`、`checkpoint`） | レガシー統合 | assets モードでは停止し、fail closed |

Consent はデバイスごと、Soul ごとです。`--categories` はマージではなく完全な置き換え
です。ローカル作成は承認ではありません。ローカルで作った Soul には一度
`soul authorize` を実行してください。承認されていない Soul はローカル送信キューに留まり、
承認済み Soul の Pull を妨げることはありません。

## 4 つのホスト

| ホスト | ローカルで観測したバージョン | 状態 |
| --- | --- | --- |
| Claude Code | 2.1.305 | 実際の CLI 抽出と hook パスを観測。完全な適用は保留 |
| Codex | 0.163.0 | 公式 `hooks.json`。信頼は Codex の `/hooks` が管理。一度限りのバイパスを観測 |
| OpenCode | 2.0.32 | v2 プラグインがロード。実機の抽出/trace を観測。完全な注入は保留 |
| Hermes | 0.21.0 CLI | 公式 shell hooks がロード。実機の抽出/trace を観測。完全な注入は保留 |
| Pi | 1.4.0 | 管理された拡張がロードし、4 つのブリッジイベントがすべて発火（2026-10-30 に session_start / prompt / settled / shutdown を観測）。構造化抽出は**未検証** |

ゲートウェイのみ（gateway-only）の Hermes 設定は CLI 対応ではなく、そのように報告
されます。`37soul install --plan` はファイルを書き込まずに一覧表示します。インストーラは
編集するすべてのユーザーファイルをバックアップし、`37soul uninstall` は管理ファイルだけ
を削除して `~/.37soul/profiles/`、生の spool、未同期キューを残します。

## ローカルランタイムの詳細

- 1 つの writer プロセスがすべてのローカル変更を直列化します。Hooks はローカル socket
  経由でイベントを届け、snapshot を直接書くことはなく、ホストをブロックしません。
- 再インストールしても既存のプロファイル、Soul UUID、アセットは保持されます。Scoped
  credential は再インストール後も有効で、グローバルのレガシー token が別のプロファイル
  に再利用されることはありません。
- 以前の bind ACK が届いても、オフラインの bind/detach は保持されます。Binding ACK は
  `cloud_revision` を進めるだけで、新しいローカルの detach や切り替えは、それ自身の操作が
  承認されるまで意図として残ります。
- 取り消し（取り消されたデバイスに対する Rails の `token_invalid` 応答を含む）は、ダウン
  ロードしたクラウドキャッシュと scoped credential を消しますが、ローカルの原本と未同期
  アセットは残します。
- ランタイムは Node 18 ESM を扱います。tarball にネイティブモジュールも WASM もありません。

## ランタイムのリリース

`install.sh`（Rails アプリが `public/install.sh` として配信）は
`releases/latest/download/37soul-runtime.tgz` とその `.sha256` を取得します。新しい
ランタイムを出すには `package.json` のバージョンを上げ、対応する tag を push します。
`.github/workflows/release-runtime.yml` は `npm test` を実行し、
`scripts/pack-runtime.sh` でパックし、レイアウトとダイジェストを検証します。**Run
workflow** で手動実行もできます。この workflow はビルドと検証のみを行い、tarball、
`.sha256`、`VERSION` を GitHub Release として公開するのは、別途明示的な承認が必要な
ステップです。

```bash
git tag v0.11.6 && git push origin v0.11.6
```

tarball のルートは `37soul/` で、`package.json`、`dist/bundle/{cli,index}.js`、管理された
OpenCode ブリッジ、Hermes ブリッジのソースを含みます。`release/VERSION` は
`package.json` のバージョンと一致している必要があり、`.sha256` は実際の tar バイトに
対するダイジェストです。

## ホスト型/リモート MCP（ローカルランタイムとは別）

ローカルランタイムを実行できないクライアント向けに、ホスト型サーバーも利用できます:

```
https://37soul.com/mcp
```

MCP Registry には `io.github.Qumge/37soul-mcp` として掲載されています。

## ランタイムの配布方法（npm はチャネルではない）

ローカルランタイムは、`https://37soul.com/install.sh` が取得する、検証済み tarball として
GitHub Releases でのみ配布されます。私たちは意図的に npm へは公開していません:

- npm は、私たちがすでに自分でチェックサムを取れるバイナリの上に、制御できないエコシス
  テム（インストールスクリプト、レジストリポリシー、ミラーのずれ、監査ノイズ）を追加
  します。
- インストーラは SHA-256 を検証し、リリースごとにバージョンを固定できます。パッケージ
  レジストリはユーザーにその監査証跡を与えられません。
- npm の tarball サイズ制限とライフサイクルフックは、「生の会話はローカルに留まる」という
  ストーリーを弱めるパッケージング判断を強います。

したがって `npm install -g 37soul-mcp` はサポートされた入手方法ではなく、npm パッケージ
は 2026-10-06 以降公開されていません（`npx 37soul-mcp` はまだ 0.9.0 を実行し、履歴のため
だけに残されています）。MCP Registry のエントリは**ホスト型**サーバー
（`https://37soul.com/mcp`）のみを掲載し、npm パッケージを指しません。ホスト型 API は
アカウント、チャット、投稿の操作を提供しますが、ローカルの持続 Soul 抽出パスではあり
ません。assets モードでは、レガシーの会話書き込みツール（`log_turn`、`remember`、
`resume`、`checkpoint`）が無効になり、`410 assets_only_mode` を返します。

## 共有契約 fixture（2 リポジトリ同期）

`soul-assets/v1` 契約テストは、テストごとに手書きされた期待値ではなく、リポジトリに
同梱された fixture からゴールデンデータを読みます:

- 正式なソース: 隣接する **37soul**（Rails）リポジトリの
  `docs/superpowers/specs/2026-10-20-persistent-soul-fixtures.json`
- 同梱コピー: `test/fixtures/contracts/soul-assets-v1.json`
- 来歴 + ダイジェスト: `test/fixtures/contracts/source.json`

`test/helpers/contract-fixture.mjs` は読み込みのたびに、宣言されたプロトコルと SHA-256 に
対してバイトを検証します。CI はリポジトリ内の fixture だけに依存します。協調して更新
する場合:

```bash
SOUL37_CONTRACT_FIXTURE=/path/to/37soul/docs/.../2026-10-20-persistent-soul-fixtures.json npm test
```

同梱コピーと宣言されたハッシュは一緒に更新してください。

## ライセンス

MIT
