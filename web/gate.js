#!/usr/bin/env node
/*
 * gate.js - HTTPS + token gate in front of ws-scrcpy.
 *
 * Why this exists:
 *   iOS Safari only exposes WebCodecs in a secure context, so a plain-HTTP
 *   mirror page shows a device list and a black canvas. This gate terminates
 *   HTTPS with a self-signed cert and enforces an access token, so the mirror
 *   never gets exposed to the LAN without one.
 *
 * Zero dependencies: node:https / node:http / node:net / node:crypto only.
 *
 *   node gate.js --port 9443 --target 127.0.0.1:8000 \
 *                --cert certs/cert.pem --key certs/key.pem --token <TOKEN>
 */
'use strict';

const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    out[k] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv);
const PORT = parseInt(args.port || process.env.GATE_PORT || '9443', 10);
const TARGET = args.target || process.env.GATE_TARGET || '127.0.0.1:8000';
const CERT = args.cert || process.env.GATE_CERT;
const KEY = args.key || process.env.GATE_KEY;
const TOKEN = args.token || process.env.GATE_TOKEN;
const COOKIE = 'ar_token';

if (!CERT || !KEY || !TOKEN) {
  console.error('need --cert, --key and --token (or GATE_CERT / GATE_KEY / GATE_TOKEN)');
  process.exit(2);
}
if (TOKEN.length < 16) {
  console.error('refusing a token shorter than 16 chars');
  process.exit(2);
}

// target is "host:port" (plain HTTP upstream, the ws-scrcpy default) or
// "https://host:port" when ws-scrcpy itself already terminates TLS
const TLS_UPSTREAM = TARGET.startsWith('https://');
const target = TARGET.replace(/^https?:\/\//, '');
const [tHost, tPort] = target.split(':');
const TPORT = parseInt(tPort || (TLS_UPSTREAM ? 443 : 80), 10);
const upstreamLib = TLS_UPSTREAM ? https : http;

function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function tokenFrom(req) {
  let u;
  try {
    u = new URL(req.url, 'https://local');
  } catch {
    return null;
  }
  const q = u.searchParams.get('token');
  if (q) return q;
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== COOKIE) continue;
    // The cookie is attacker-controlled text. decodeURIComponent('%') throws,
    // and an uncaught throw here used to kill the whole gate: one request with
    // `Cookie: ar_token=%` was enough to take the mirror down.
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

function ok(req) {
  const t = tokenFrom(req);
  return !!t && safeEq(t, TOKEN);
}

const LOGIN = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Android · 解锁</title>
<style>
:root{color-scheme:dark}
body{margin:0;height:100dvh;display:grid;place-items:center;background:#0f1218;
     color:#e8eef6;font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
form{width:min(88vw,340px);background:#171c24;border:1px solid #262d38;border-radius:16px;padding:26px}
h1{font-size:17px;margin:0 0 6px}
p{color:#8fa3b8;font-size:13px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:13px;border-radius:10px;border:1px solid #2a3340;
      background:#0d1016;color:#e8eef6;font-size:16px;margin-bottom:12px}
button{width:100%;padding:13px;border:0;border-radius:10px;background:#4f8be0;color:#fff;
       font-size:16px;font-weight:600}
.err{color:#ff8a8a;font-size:13px;margin:0 0 12px}
</style>
<h1>这台安卓机只对持有令牌的人开放</h1>
<p>输入访问令牌（服务端 web/.env 里的 GATE_TOKEN）</p>
<form method=POST action=/__auth>
  <input name=token type=password placeholder="令牌" autofocus autocomplete=off>
  <button>进入</button>
</form>`;

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

async function handle(req, res) {
    const u = new URL(req.url, 'https://local');

    if (req.method === 'POST' && u.pathname === '/__auth') {
      const body = await readBody(req);
      const given = new URLSearchParams(body).get('token') || '';
      if (safeEq(given, TOKEN)) {
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          Location: '/',
        });
        return res.end();
      }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN.replace('<p>', '<p class=err>令牌不对</p><p>'));
    }

    if (!ok(req)) {
      if (u.searchParams.get('token')) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('bad token\n');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN);
    }

    // strip the token from the proxied URL so it does not leak into logs/history
    const path = u.pathname + (u.search ? '?' + new URLSearchParams([...u.searchParams].filter(([k]) => k !== 'token')).toString() : '');
    const headers = Object.assign({}, req.headers, { host: `${tHost}:${TPORT}` });
    const p = upstreamLib.request(
      { host: tHost, port: TPORT, method: req.method, path, headers,
        ...(TLS_UPSTREAM ? { rejectUnauthorized: false } : {}) },
      (pr) => { res.writeHead(pr.statusCode || 502, pr.headers); pr.pipe(res); }
    );
    p.on('error', (e) => { res.writeHead(502); res.end('upstream: ' + e.message); });
    req.pipe(p);
}

const server = https.createServer(
  { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) },
  (req, res) => {
    // A throw in here must not take the gate down: the mirror would just go
    // black and nothing restarts it.
    handle(req, res).catch((e) => {
      console.error('gate: request failed:', e && e.stack || e);
      try { res.writeHead(500); res.end('gate error\n'); } catch { try { res.destroy(); } catch {} }
    });
  }
);

// Last resort: keep serving instead of dying on an unexpected throw.
process.on('uncaughtException', (e) => console.error('gate: uncaught:', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('gate: unhandled rejection:', e && e.stack || e));

// WebSocket (and any Upgrade) passthrough: raw socket piping, token checked once
server.on('upgrade', (req, socket, head) => {
  if (!ok(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  const up = net.connect(TPORT, tHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`gate: https://0.0.0.0:${PORT} -> http://${TARGET} (token required)`);
});
