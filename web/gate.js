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
 * Zero npm dependencies: node:https / node:http / node:net / node:crypto / node:child_process.
 *
 *   node gate.js --port 9443 --target 127.0.0.1:8000 \
 *                --cert certs/cert.pem --key certs/key.pem --token <TOKEN>
 *
 * Also serves POST /x/screenshot (token required): the mirror page has no
 * scrcpy control channel, so it cannot trigger the device-side screenshot.
 * This endpoint runs `adb shell screencap` on this machine instead and drops
 * the PNG into the phone's gallery. Override ADB_BIN / SHOT_DIR if needed.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

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

// Screenshot: the mirror page has no scrcpy control channel, so the built-in
// screenshot button does nothing. POST /x/screenshot uses adb on this machine
// instead and drops the PNG into the phone's own gallery.
const ADB_BIN = process.env.ADB_BIN || 'adb';
const SHOT_DIR = process.env.SHOT_DIR || '/sdcard/DCIM/Screenshots';

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

function jsonOut(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// The phone is often busy right after a stream starts, so adb devices can come
// back empty for a moment: retry a few times instead of reporting "no device".
function pickDevice(tries, cb) {
  execFile(ADB_BIN, ['devices'], { timeout: 8000 }, (e, out) => {
    if (e) return cb(e);
    const list = String(out).split('\n').map(s => s.trim())
      .filter(l => /\tdevice$/.test(l)).map(l => l.split('\t')[0]);
    if (list.length) return cb(null, list[0]);
    if (tries <= 1) return cb(new Error('no adb device (run: adb connect <phone-ip>:<port>)'));
    setTimeout(() => pickDevice(tries - 1, cb), 400);
  });
}

// Muting the phone before the stream closes: the scrcpy session keeps the
// phone silent, but the moment it exits the speaker comes back (and whatever
// was playing leaks out of the phone instead of the page). Two steps:
//   1. mute  — keyevent 164 is a TOGGLE, so check Muted first (already muted
//              means pressing it again would turn sound back ON)
//   2. pause — kill the source too; a restored audio route then has nothing
//              to play. dispatch pause is used instead of keyevent 85 because
//              85 is also a toggle and would START playback when idle.
// `--set 0` instead of keyevent 164: 164 is a toggle, so it needs a dumpsys
// round-trip first to know the current state — that pushed the whole command
// past 600ms and the phone still audibly leaked. --set 0 is idempotent.
const MUTE_CMD =
  "cmd media_session volume --stream 3 --set 0 >/dev/null 2>&1; " +
  "cmd media_session dispatch pause >/dev/null 2>&1" + STATE_0 + "; echo done";

/* Write the phone-side state file whenever we mute.
 * xy_audio2.sh uses it to decide whether the volume still needs restoring; if the
 * gate mutes without touching it, the script thinks "already unmuted" and never
 * restores — the owner saw exactly that: log silent, no sound, had to raise the
 * volume by hand. */
const STATE_0 = "; echo 0 > /data/local/tmp/xy_audio.state 2>/dev/null";

/* Soft mute: volume to 0 only, leave the audio source alone.
 * Used when the WebSocket drops (phone locked, iPhone backgrounded, 4G hiccup).
 * Those reconnects are immediate, and pausing the media means the page comes back
 * with picture but no sound — Douyin only declares PAUSE/PLAY_PAUSE, never PLAY,
 * so neither dispatch play nor keyevent 85 brings it back.
 * The full MUTE_CMD (with pause) is only for an explicit "close session". */
const MUTE_SOFT = "cmd media_session volume --stream 3 --set 0 >/dev/null 2>&1" + STATE_0 + "; echo done";

/* Restore the volume from the gate, not from the phone-side script.
 * xy_audio2.sh runs in Android's in_active_bg cgroup and gets throttled — its 1s
 * poll slows down or stalls, which is why "come back from background" had no sound.
 * The gate holds a persistent adb shell and is not subject to that policy.
 * Order matters: clear the Muted flag first, then set the volume — on vivo --set
 * only changes the channel volume, and a lingering Muted flag keeps it silent
 * (measured: log said "restored to 15" while the phone stayed at 0). */
const UNMUTE_CMD = "v=$(cat /data/local/tmp/xy_vol 2>/dev/null); "
  + "case \"$v\" in ''|*[!0-9]*) v=15 ;; esac; "
  + "if [ \"$v\" -lt 1 ]; then v=15; fi; "
  + "if [ \"$(dumpsys audio 2>/dev/null | grep -A1 '^- STREAM_MUSIC:' | grep -m1 'Muted:' | awk '{print $2}')\" = 'true' ]; then input keyevent 164; fi; "
  + "cmd media_session volume --stream 3 --set $v >/dev/null 2>&1; "
  + "echo 1 > /data/local/tmp/xy_audio.state; echo done";

let unmuteTimer = null;
function scheduleUnmute() {
  if (unmuteTimer) clearTimeout(unmuteTimer);
  unmuteTimer = setTimeout(() => {
    unmuteTimer = null;
    quickSerial((err, serial) => { if (!err) runShellOrFallback(serial, UNMUTE_CMD); });
  }, 3000);
}

// Spawning an adb process per mute costs ~150ms on its own. Keep one shell
// alive and write commands into its stdin instead (measured 4ms end to end);
// it is recreated automatically if the phone is unplugged or rebooted.
let shellProc = null;
let shellSerial = null;
function ensureShell(serial) {
  if (shellProc && shellProc.exitCode === null && shellSerial === serial) return shellProc;
  if (shellProc && shellProc.exitCode === null) { try { shellProc.kill(); } catch {} }
  shellSerial = serial;
  shellProc = spawn(ADB_BIN, ['-s', serial, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] });
  shellProc.stdout.on('data', () => {});
  shellProc.stderr.on('data', () => {});
  shellProc.on('exit', () => { shellProc = null; });
  shellProc.on('error', () => { shellProc = null; });
  return shellProc;
}

// On mobile data the stream drops and reconnects repeatedly; muting on every
// close makes the phone flip mute/unmute and the volume bar dance. Only honour
// one mute per 8s window from the WebSocket path (explicit page requests skip this).
let lastWsMuteAt = 0;
function shouldMuteNow() {
  const now = Date.now();
  if (now - lastWsMuteAt < 8000) return false;
  lastWsMuteAt = now;
  return true;
}

function runShellOrFallback(serial, cmd) {
  try {
    ensureShell(serial).stdin.write(cmd + '\n');
  } catch {
    execFile(ADB_BIN, ['-s', serial, 'shell', cmd], { timeout: 8000 }, () => {});
  }
}

function handleMute(req, res) {
  // ?soft=1 → the page is being backgrounded/closed, it will come back shortly:
  // mute the volume but do not pause (see MUTE_SOFT).
  const soft = /[?&]soft=1/.test(req.url || '');
  pickDevice(2, (err, serial) => {
    if (err) return jsonOut(res, 503, { ok: false, error: err.message });
    runShellOrFallback(serial, soft ? MUTE_SOFT : MUTE_CMD);
    jsonOut(res, 200, { ok: true });
  });
}

// Page became visible again: restore the volume (handles the case where the
// WebSocket never dropped, so no new stream request fires scheduleUnmute).
function handleUnmute(res) {
  pickDevice(2, (err, serial) => {
    if (err) return jsonOut(res, 503, { ok: false, error: err.message });
    runShellOrFallback(serial, UNMUTE_CMD);
    jsonOut(res, 200, { ok: true });
  });
}

function handleScreenshot(res) {
  pickDevice(3, (err, serial) => {
    if (err) return jsonOut(res, 503, { ok: false, error: err.message });
    const name = 'xy_' + stamp(new Date()) + '.png';
    const full = SHOT_DIR + '/' + name;
    const cmd = 'mkdir -p ' + SHOT_DIR + '; screencap -p ' + full + ';'
      + ' am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://' + full;
    execFile(ADB_BIN, ['-s', serial, 'shell', cmd], { timeout: 25000 }, (e2, out2, serr) => {
      if (e2) return jsonOut(res, 500, { ok: false, error: String(serr || e2.message).slice(0, 200) });
      jsonOut(res, 200, { ok: true, path: full, name });
    });
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

    // Incompressible payload so the client can time its own downlink.
    if (req.method === 'GET' && u.pathname === '/x/speedtest') {
      const mb = Math.max(1, Math.min(parseInt(u.searchParams.get('mb') || '3', 10) || 3, 16));
      const buf = require('crypto').randomBytes(mb * 1024 * 1024);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'no-store' });
      return res.end(buf);
    }
    // Silence the phone before the page lets the stream go (the page beacons
    // this on pagehide, and a closing toolbar button calls it first).
    if (req.method === 'POST' && u.pathname === '/x/unmute') {
      return handleUnmute(res);
    }
    if (req.method === 'POST' && u.pathname === '/x/mute') {
      return handleMute(req, res);
    }
    // Screenshot goes to the phone's gallery, not to the page (the page has no
    // scrcpy control channel to trigger the device-side capture).
    if (req.method === 'POST' && u.pathname === '/x/screenshot') {
      return handleScreenshot(res);
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

// ── Bandwidth-aware stream profile ────────────────────────────────────────
// Capture happens on the phone side, so the bottleneck is the DOWNLINK to the
// viewer: a desk PC on Tailscale relay, a phone on 4G and a laptop on gigabit
// LAN need very different bitrates. The page measures its own downlink
// (GET /x/speedtest, incompressible random bytes) and stores the result in the
// x_mbps cookie; here we turn that into scrcpy stream parameters.
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

// Manual override wins: the toolbar's A / 1.2K / 1.6K / 2.4K button writes
// x_quality. Covers three real cases — 1280 for idle background play (a fifth of
// the encoder load), 1600 for desktop viewing (lossless at ~400 CSS px wide),
// 2400 (native) only for iPhone full-screen, where the Retina panel needs 1:1.
const QUALITY_TABLE = {
  1280: { maxSize: 1280, bitrate: 5000000, maxFps: 30 },
  1600: { maxSize: 1600, bitrate: 8000000, maxFps: 60 },
  2400: { maxSize: 2400, bitrate: 12000000, maxFps: 60 },
};

function profileFor(req) {
  const forced = parseInt(getCookie(req, 'x_quality') || '0', 10);
  if (QUALITY_TABLE[forced]) return QUALITY_TABLE[forced];
  const mbps = parseInt(getCookie(req, 'x_mbps') || '0', 10);
  if (!mbps || mbps <= 0) return null;
  if (mbps >= 50) return { maxSize: 2400, bitrate: 12000000, maxFps: 60 };
  if (mbps >= 20) return { maxSize: 1920, bitrate: 8000000, maxFps: 60 };
  if (mbps >= 8) return { maxSize: 1600, bitrate: 5000000, maxFps: 60 };
  if (mbps >= 3) return { maxSize: 1280, bitrate: 3000000, maxFps: 30 };
  return { maxSize: 960, bitrate: 1500000, maxFps: 30 };
}

function injectProfile(url, req) {
  if (url.indexOf('action=stream') === -1) return url;
  const p = profileFor(req);
  if (!p) return url;
  const u = new URL(url, 'https://gate.invalid');
  u.searchParams.set('maxSize', String(p.maxSize));
  u.searchParams.set('bitrate', String(p.bitrate));
  u.searchParams.set('maxFps', String(p.maxFps));
  scheduleUnmute();
  /* Pin non-Apple browsers to H.264.
   * The front-end's automatic codec choice got stuck on a pre-release bundle
   * (bundle.js shipped without a cache-busting query), so it picked H.265 — and
   * MTK's HEVC encoder looks visibly worse at the same bitrate. Reported symptom:
   * "highest resolution but the picture is a blurry mess". Apple gets HEVC
   * hardware decode and better quality, so iOS is left alone.
   * Note: h264 is ws-scrcpy's default, so the front-end ignores the param and
   * falls back to it — which is exactly what we want. */
  /* Pin H.264 — and the codec and encoder must be changed TOGETHER.
   * The front-end picks videoCodec=h265 + videoEncoder=c2.mtk.hevc.encoder. Changing
   * only the codec yields "codec=avc + encoder=hevc", and scrcpy dies with
   * 'Video encoder type ... does not match codec type' — the web UI then shows
   * "reconnecting" forever. That was a real outage; do not repeat it.
   * h264 is the server default, so drop the codec param; drop the encoder too and let
   * scrcpy pick the hardware video/avc encoder itself.
   * Why H.264 at all: MTK's HEVC encoder looks visibly worse — on the owner's iPhone a
   * 1072x2400 @11.4MiB/s H.265 stream was unreadably blurry; H.264 fixed it. */
  u.searchParams.delete('videoCodec');
  u.searchParams.delete('videoEncoder');
  return u.pathname + (u.search || '');
}

// WebSocket (and any Upgrade) passthrough: raw socket piping, token checked once
server.on('upgrade', (req, socket, head) => {
  if (!ok(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  const up = net.connect(TPORT, tHost, () => {
    const lines = [`${req.method} ${injectProfile(req.url, req)} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  // Closing the stream must silence the phone: the scrcpy session is what keeps
  // the speaker quiet, so the moment it ends whatever was playing leaks out.
  // Connections younger than 15s are page loads, not real streams — ignore them.
  const startedAt = Date.now();
  let gone = false;
  const onGone = () => {
    if (gone) return;
    gone = true;
    if (!req.url.includes('action=stream')) return;
    if (Date.now() - startedAt < 15000) return;
    if (!shouldMuteNow()) return;
    pickDevice(2, (err, serial) => { if (!err) runShellOrFallback(serial, MUTE_CMD); });
  };
  up.on('close', onGone);
  socket.on('close', onGone);
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`gate: https://0.0.0.0:${PORT} -> http://${TARGET} (token required)`);
});
