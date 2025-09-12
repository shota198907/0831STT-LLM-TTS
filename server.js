
/* server.js */
const http = require('http');
const next = require('next');
const WebSocket = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const {
  GATEWAY_WS_URL,
  GATEWAY_WS_TOKEN,
  PROXY_ORIGIN,
  PORT = 8080,
} = process.env;

if (!GATEWAY_WS_URL || !GATEWAY_WS_TOKEN || !PROXY_ORIGIN) {
  console.error('Missing env: GATEWAY_WS_URL / GATEWAY_WS_TOKEN / PROXY_ORIGIN');
  process.exit(1);
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => handle(req, res));
  const wss = new WebSocket.Server({ noServer: true });

  wss.on('connection', (client /*, request */) => {
    const upstream = new WebSocket(GATEWAY_WS_URL, {
      headers: {
        Origin: PROXY_ORIGIN,
        'X-WS-Token': GATEWAY_WS_TOKEN,
      },
    });

    // downstream -> upstream
    client.on('message', d => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(d);
    });
    client.on('close', () => { try { upstream.close(1000, 'client_closed'); } catch
{} });
    client.on('error', () => { try { upstream.close(1011, 'client_error'); } catch
{} });
    client.on('ping', d => { try { client.pong(d); } catch {} });

    // upstream -> downstream
    upstream.on('message', d => {
      if (client.readyState === WebSocket.OPEN) client.send(d);
    });
    upstream.on('close', (code, reason) => {
      try { client.close(code || 1011, (reason && reason.toString()) ||
'upstream_closed'); } catch {}
    });
    upstream.on('error', (e) => {
      try { client.close(1011, e?.message || 'upstream_error'); } catch {}
    });
  });

  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== '/api/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  server.listen(Number(PORT), () => {
    console.log(`ai-phone-system listening on :${PORT}`);
  });
});