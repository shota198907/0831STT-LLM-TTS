// server/live-bridge.mjs
// 上流（Vertex AI Live API など）へのWebSocketブリッジ。
// - APIキー または OAuth/ADC（サービスアカウント）で認証
// - APIキー利用時は x-goog-user-project を送らない
// - OAuth/ADC利用時は Authorization: Bearer と x-goog-user-project を付与
// - 接続OPENで {type:"status", state:"upstream_ready"} を通知
// - ハンドシェイク失敗（101以外）は {type:"error", error:"live_handshake_failed", http_status, http_status_text}
// - 上流バイナリ→ BASE64 にして {type:"server_audio", format:"pcm16", rate:16000, chunk}
// - 上流JSONの transcript / audio 類は最小整形して透過
// - error/close は呼び出し元に伝搬（onEvent / onClose）

import WebSocket from "ws";

/**
 * ADC(OAuth) のアクセストークンを取得
 * - ランタイムに google-auth-library がある前提（無い場合はエラー）
 * - Cloud Run / GCE 環境ではメタデータ経由、ローカルでは gcloud ADC など
 */
async function getAccessToken(scope = "https://www.googleapis.com/auth/cloud-platform") {
  try {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: [scope] });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Failed to obtain access token");
    return token;
  } catch (e) {
    throw new Error(`ADC access token fetch failed: ${e?.message || String(e)}`);
  }
}

/**
 * 上流Liveセッションを開く
 * @param {Object} opts
 * @param {string} opts.wsUrl - Live APIのWSエンドポイント（必須）
 * @param {string} [opts.project] - x-goog-user-project に使うGCPプロジェクト（OAuth/ADC時のみ付与）
 * @param {string} [opts.location] - 参考（現状未使用）
 * @param {string} [opts.model] - 参考（現状未使用）
 * @param {string} [opts.apiKey] - Google APIキー（指定があればAPIキー優先）
 * @param {string} [opts.corrId] - 相関ID（ヘッダ X-Corr-Id）
 * @param {(evt: any) => void} [opts.onEvent] - 上流イベント通知
 * @param {(code?: number, reason?: string, meta?: {opened:boolean}) => void} [opts.onClose] - クローズ通知
 * @returns {Promise<{ready:() => boolean, sendAudio:(frame:{format:string,rate:number,chunk:string,duration_ms?:number})=>void, close:()=>void }>}
 */
export async function openLiveSession({
  wsUrl,
  project,
  location, // eslint-disable-line no-unused-vars
  model,    // eslint-disable-line no-unused-vars
  apiKey,
  corrId,
  onEvent,
  onClose,
  responseModalities,
  enableInputTranscription,
}) {
  if (!wsUrl) throw new Error("LIVE_API_WS_URL is not set");

  // 認証ヘッダとURLの組み立て
  let url = wsUrl;
  const headers = { "X-Corr-Id": corrId || "" };

  if (apiKey && apiKey.trim()) {
    // === APIキー経路 ===
    // ルール：?key=... と x-goog-api-key を付与。x-goog-user-project は付けない。
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}key=${encodeURIComponent(apiKey.trim())}`;
    headers["x-goog-api-key"] = apiKey.trim();
  } else {
    // === OAuth/ADC経路 ===
    // ルール：Authorization: Bearer と x-goog-user-project（あれば）を付与
    const bearer = await getAccessToken();
    headers["Authorization"] = `Bearer ${bearer}`;
    if (project) headers["x-goog-user-project"] = project;
  }

  // 上流WSを開く
  const upstream = new WebSocket(url, { headers });
  let opened = false;

  upstream.on("open", () => {
    opened = true;
    // 最初の1本目に setup を送信（BidiGenerateContentSetup）
    try {
      const modalities = Array.isArray(responseModalities) && responseModalities.length
        ? responseModalities
        : ['TEXT'];
      const setup = { setup: { model: model || 'models/gemini-2.5-flash', generationConfig: { responseModalities: modalities } } };
      if (enableInputTranscription !== false) setup.setup.inputAudioTranscription = {};
      upstream.send(JSON.stringify(setup));
      // 下流へ通知（ローカルWSへは server/index.js で透過送信される）
      onEvent?.({ type: 'status', state: 'upstream_setup_sent' });
    } catch {}

    // 上流準備完了（ハンドシェイク成功）
    onEvent?.({ type: "status", state: "upstream_ready" });
  });

  // ハンドシェイクで 101 Switching Protocols 以外が返った場合
  upstream.on("unexpected-response", (_req, res) => {
    const status = res?.statusCode;
    const text = res?.statusMessage;
    onEvent?.({ type: "error", error: "live_handshake_failed", http_status: status, http_status_text: text });
    try { res?.resume?.(); } catch {}
  });

  // 上流→下流の整形: バイナリは音声、JSONは内容で分岐
  upstream.on("message", (data, isBinary) => {
    try {
      if (isBinary || Buffer.isBuffer(data)) {
        // バイナリ音声（PCM16想定）→ BASE64 化して server_audio として下流へ
        const b64 = Buffer.from(data).toString("base64");
        onEvent?.({ type: "server_audio", format: "pcm16", rate: 16000, chunk: b64 });
        return;
      }
      const text = data.toString();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        // JSONでないテキストは情報イベントとして通知
        onEvent?.({ type: "info", upstream: "text" });
        return;
      }

      // よくあるペイロードの最小整形
      if (msg?.type === "transcript" || typeof msg?.text === "string") {
        onEvent?.({
          type: "transcript",
          role: msg.role || "assistant",
          text: msg.text || msg.transcript || "",
          final: !!msg.final
        });
      } else if (msg?.type === "audio" || msg?.server_audio || msg?.audio) {
        const payload = msg.server_audio || msg.audio || {};
        const b64 = payload.chunk || payload.data || payload.base64 || "";
        if (typeof b64 === "string" && b64) {
          onEvent?.({
            type: "server_audio",
            format: payload.format || "pcm16",
            rate: Number(payload.rate) || 16000,
            chunk: b64
          });
        } else {
          // 形式不明は情報として透過
          onEvent?.({ type: "info", upstream: msg?.type || "json" });
        }
      } else {
        // 不明なJSONは情報として透過
        onEvent?.({ type: "info", upstream: msg?.type || "json" });
      }
    } catch (e) {
      onEvent?.({ type: "error", error: "upstream_parse_error", message: e?.message || String(e) });
    }
  });

  upstream.on("close", (code, reason) => {
    onClose?.(code, reason?.toString(), { opened });
  });

  upstream.on("error", (e) => {
    onEvent?.({ type: "error", error: "upstream_error", message: e?.message || "upstream_error" });
    onClose?.(1011, e?.message || "upstream_error", { opened });
  });

  // 呼び出し元が使う操作
  return {
    ready: () => upstream.readyState === WebSocket.OPEN,
    /**
     * クライアントからの音声フレーム（BASE64/PCM16/16kHz）を上流へ送る
     * @param {{format:string, rate:number, chunk:string, duration_ms?:number}} frame
     */
    sendAudio: ({ format, rate, chunk, duration_ms }) => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      // 暫定：上流にもJSONで送る（必要に応じて後日プロトコルに合わせて調整）
      const payload = {
        type: "audio",
        format: format || "pcm16",
        rate: Number(rate) || 16000,
        chunk,
      };
      if (typeof duration_ms === "number") payload.duration_ms = duration_ms;
      upstream.send(JSON.stringify(payload));
    },
    close: () => {
      try { upstream.close(1000, "gateway_shutdown"); } catch {}
    },
  };
}
