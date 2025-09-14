Live Gateway (MVP)

最小構成の音声 Live API ゲートウェイ。`/healthz` と `/ws` を提供し、`LIVE_API_WS_URL` 設定時は Vertex AI Live API に中継、未設定時は echo 動作。

環境変数
- `PORT`: 待受ポート（既定: `8080`）
- `WS_ALLOWED_ORIGINS`: 許可オリジン（カンマ区切り）
- `GOOGLE_CLOUD_PROJECT`: GCP プロジェクトID（`x-goog-user-project`）
- `GOOGLE_CLOUD_LOCATION`: 参考（URL優先）
- `LIVE_MODEL`: 参考（必要時に使用）
- `LIVE_API_WS_URL`: 上流 Live API WS エンドポイント。未設定なら echo モード。
- 認証:
  - `GOOGLE_API_KEY`: APIキーで接続する場合に設定（ある場合はAPIキー優先）。
  - または ADC（サービスアカウント等）を使用（`GOOGLE_APPLICATION_CREDENTIALS` など）
 - タイムアウト:
   - `LIVE_READY_TIMEOUT_MS`: `upstream_ready` 到達待ちのタイムアウト（ms）。超過時は echo にフォールバック。
 - WSトークンゲート（任意）:
   - `REQUIRE_WS_TOKEN=true|false`（既定 false）、`WS_TOKEN` を設定。
   - Upgrade 前に `X-WS-Token` または `?token=` を検証。不一致は HTTP 401 で拒否（ログに `event:"auth_fail"`）。

`.env.example` を参照してください。

注意（Originの許可範囲）
- `WS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8080` は開発時向けの例です。デプロイ時は必要最小限のオリジンに絞ってください。
-
テストページ `/test` の提供は `ENABLE_TEST_CLIENT=true` のときのみ有効です（既定は無効）。本番では必ず無効にしてください。

HTTP
- `GET /healthz` → 200 OK

WebSocket `/ws`
- 起点: `Origin` ヘッダは `WS_ALLOWED_ORIGINS` に一致が必要。
- メッセージ（JSON; MVP プロトコル）:
  - `{"type":"start"}` → 直ちに `{"type":"status","state":"ready"}` を送信
  - Live 成功時は `{"type":"status","state":"upstream_ready"}` 到達後に `{"type":"ack","what":"start","upstream":"live","corr_id":"<uuid>"}` を送信
  - `{"type":"ping"}` → `{"type":"pong","ts":<ms>}`
  - `{"type":"client_audio","format":"pcm16","rate":16000,"chunk":"<BASE64>","duration_ms":200}`
  - Live→Client: `{"type":"server_audio","format":"pcm16","rate":16000,"chunk":"<BASE64>"}`（逐次）
  - Live→Client: `{"type":"transcript","role":"assistant|user","text":"...","final":true|false}`
- 15s 間隔で `{"type":"keepalive","ts":<ms>}` をゲートウェイから送出
- `{"type":"end_call"}` → `{"type":"bye"}` の後、WS Close(1000)

Live setup（上流 OPEN 時に送信）
- 既定: `model: models/gemini-2.5-flash`, `generationConfig.responseModalities: ["TEXT"]`, `inputAudioTranscription: {}`
- 環境変数で制御:
  - `LIVE_RESPONSE_MODALITIES=TEXT|AUDIO`（カンマ区切り可）
  - `LIVE_ENABLE_INPUT_TRANSCRIPTION=true|false`
  - `LIVE_MODEL`（モデル名を上書き）

Live接続失敗時の挙動
- `{"type":"error","error":"live_connect_failed",...}` 通知後、`ack(upstream:"echo", note:"live_connect_failed")` を返し echo 継続。
  - エラー種別と詳細:
    - `live_handshake_failed`: 上流のハンドシェイク失敗（`http_status`/`http_status_text` を付与）
    - `upstream_error`: ソケットレベルのエラー（`message` を付与）
    - `live_connect_failed` with `detail: "ready_timeout=<ms>`: `upstream_ready` 未到達（`LIVE_READY_TIMEOUT_MS` 既定 8000）

ログ（gateway.log）
- 1行JSONで主要イベントを出力（PII無し）。例:
  - {"ts":..., "corr_id":"...", "event":"ack", "upstream":"live"}
  - {"ts":..., "corr_id":"...", "event":"client_audio", "bytes_in":4096}
  - {"ts":..., "corr_id":"...", "event":"server_audio", "bytes_out":8192}

動作確認
- 起動: `npm run dev`
- ヘルス: `curl -i http://localhost:$PORT/healthz`
- WebSocket: `wscat -H "Origin: http://localhost:3000" -c ws://localhost:$PORT/ws`
  - `{"type":"start"}` → `ack` と `status:ready`
  - `{"type":"ping"}` → `{"type":"pong",...}`
  - `{"type":"end_call"}` → close(1000)

簡易ブラウザテスト
- テストページ: http://localhost:8080/test
- ボタン: Connect / Start / Ping / End
- Start で mic の 16kHz/200ms BASE64 送出、server_audio を即時再生
- 画面に `ack`/`status:ready`/`keepalive`/`pong` を表示

注意
- 上流 Live API のメッセージ仕様に合わせた整形は今後拡張します。本MVPでは
  - クライアント→上流: `type:"audio"` で BASE64 PCM16 を送信
  - 上流→クライアント: バイナリ＝音声、JSONで `type:"transcript"`/`type:"audio"` 類を最小整形
- 機密/PIIはログに残しません。

Docker 構成
- ゲートウェイ用: `Dockerfile.ws-gateway`（Node 20、`node server/index.js` 起動、非 root）
- UI 用: `Dockerfile.ui`（Nginx で `index.html` を配布）

デプロイ（Cloud Run）
- スクリプト: `scripts/deploy.sh`
  - 例: ゲートウェイをデプロイ
    - `PROJECT=<project> REGION=asia-northeast1 SERVICE=ws-gateway-clean \\\n+       SECRET_GOOGLE_API_KEY=google-api-key SECRET_WS_TOKEN=ws-token \\\n+       DOCKERFILE=Dockerfile.ws-gateway bash scripts/deploy.sh ws-gateway-clean`
  - 主なオプション（環境変数）
    - `DOCKERFILE` デフォルト `Dockerfile.ws-gateway`
    - `ENV_FILE` デフォルト `env.yaml`（存在しなければ未使用）
    - `SECRET_GOOGLE_API_KEY` → `GOOGLE_API_KEY` を Secret Manager から注入（例: `google-api-key[:latest]`）
    - `SECRET_WS_TOKEN` → `WS_TOKEN` を Secret Manager から注入（例: `ws-token[:latest]`）
    - `ALLOW_UNAUTH` デフォルト `true`（必要に応じて認証化）
