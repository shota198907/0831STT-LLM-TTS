(() => {
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const corrEl = document.getElementById('corr');

  let ws = null;
  let audioCtx = null;
  let mediaStream = null;
  let micProcessor = null;
  let recording = false;
  let corrId = null;
  let bufferFloat = [];
  let playHead = 0;
  const targetRate = 16000;
  const chunkMs = 200; // 200ms
  const jitterLead = 0.4; // 400ms

  function log(msg) {
    const tag = corrId ? `corr_id=${corrId} ` : '';
    const line = `${new Date().toISOString()} ${tag}${msg}`;
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  const seenStates = [];
  let seenAck = false;
  let pendingReady = false;
  function pushState(state) {
    if (!seenStates.includes(state)) seenStates.push(state);
    statusEl.textContent = `status: ${seenStates.join(' → ')}`;
  }

  function base64FromBytes(bytes) {
    let binary = '';
    const len = bytes.length;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function bytesFromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function floatToPCM16le(float32Array) {
    const out = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return new Uint8Array(out.buffer);
  }

  function pcm16leToFloat(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.byteLength / 2;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const s = view.getInt16(i * 2, true);
      out[i] = s / 0x8000;
    }
    return out;
  }

  function resampleFloat32(src, srcRate, dstRate) {
    if (srcRate === dstRate) return src;
    const ratio = srcRate / dstRate;
    const newLen = Math.floor(src.length / ratio);
    const out = new Float32Array(newLen);
    let pos = 0;
    for (let i = 0; i < newLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, src.length - 1);
      const t = idx - i0;
      out[i] = (1 - t) * src[i0] + t * src[i1];
      pos = i1;
    }
    return out;
  }

  async function startMic() {
    if (recording) return;
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    const source = audioCtx.createMediaStreamSource(mediaStream);
    const proc = audioCtx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => {
      if (!recording) return;
      const input = e.inputBuffer.getChannelData(0);
      bufferFloat.push(new Float32Array(input));
      const concatLen = bufferFloat.reduce((a, b) => a + b.length, 0);
      const tmp = new Float32Array(concatLen);
      let off = 0;
      for (const arr of bufferFloat) { tmp.set(arr, off); off += arr.length; }
      const resampled = resampleFloat32(tmp, audioCtx.sampleRate, targetRate);
      const needed = Math.floor(targetRate * (chunkMs / 1000)); // 3200 samples
      if (resampled.length >= needed) {
        const chunk = resampled.subarray(0, needed);
        const rest = resampled.subarray(needed);
        bufferFloat = rest.length ? [rest] : [];
        const bytes = floatToPCM16le(chunk);
        const b64 = base64FromBytes(bytes);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'client_audio', format: 'pcm16', rate: 16000, chunk: b64, duration_ms: chunkMs }));
        }
      } else {
        bufferFloat = [resampled];
      }
    };
    source.connect(proc);
    proc.connect(audioCtx.destination);
    micProcessor = proc;
    recording = true;
    log('mic started');
  }

  async function stopMic() {
    recording = false;
    if (micProcessor) { try { micProcessor.disconnect(); } catch {} }
    if (mediaStream) { for (const t of mediaStream.getTracks()) t.stop(); }
    micProcessor = null; mediaStream = null;
    log('mic stopped');
  }

  function playServerAudio(b64) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const bytes = bytesFromBase64(b64);
      const floats = pcm16leToFloat(bytes);
      const buf = audioCtx.createBuffer(1, floats.length, targetRate);
      buf.getChannelData(0).set(floats);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      if (!playHead || playHead < now + 0.05) playHead = now + jitterLead;
      src.start(playHead);
      playHead += floats.length / targetRate;
    } catch (e) {
      log('playback error: ' + e.message);
    }
  }

  // UI bindings
  document.getElementById('btnConnect').onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const token = document.getElementById('token').value.trim();
    const mode = document.getElementById('authMode').value;
    const headers = {};
    let subprotocols = [];
    if (token) {
      if (mode === 'token') subprotocols = [`token=${token}`];
      else if (mode === 'bearer') subprotocols = [`bearer:${token}`];
      else if (mode === 'header') headers['X-WS-Token'] = token; // non-browser clients only; kept for parity
    }
    try {
      // Browser WebSocket cannot set arbitrary headers; only subprotocols.
      ws = new WebSocket(url, subprotocols);
    } catch (e) {
      log('WebSocket init error: ' + e.message);
      return;
    }
    ws.onopen = () => { pushState('connected'); log('ws open; protocol=' + (ws.protocol || '-')); };
    ws.onclose = (ev) => { setStatus('closed'); log(`ws close code=${ev.code} reason=${ev.reason}`); stopMic(); };
    ws.onerror = (ev) => { log('ws error'); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ack') {
          if (msg.corr_id) { corrId = msg.corr_id; corrEl.textContent = `corr_id: ${corrId}`; }
          pushState('ack');
          seenAck = true;
          if (pendingReady) { pushState('ready'); pendingReady = false; }
        }
        if (msg.type === 'status' && msg.state === 'ready') {
          if (seenAck) pushState('ready'); else pendingReady = true;
        }
        if (msg.type === 'status' && msg.state === 'upstream_ready') { pushState('upstream_ready'); }
        if (msg.type === 'server_audio' && typeof msg.chunk === 'string') {
          playServerAudio(msg.chunk);
        }
        log('recv ' + JSON.stringify(msg));
      } catch {
        log('recv(non-json)');
      }
    };
  };

  document.getElementById('btnStart').onclick = async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { log('not connected'); return; }
    ws.send(JSON.stringify({ type: 'start' }));
    await startMic();
  };

  document.getElementById('btnPing').onclick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'ping' }));
  };

  document.getElementById('btnEnd').onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'end_call' }));
    }
    stopMic();
  };
})();
