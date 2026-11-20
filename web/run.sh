#!/usr/bin/env bash
# web/run.sh - 一条命令把「iPhone 能打开的安卓投屏网页端」跑起来
#
#   ./web/run.sh setup         首次安装（拉 ws-scrcpy、构建、生成证书与令牌）
#   ./web/run.sh start|stop|restart|status|url|logs
#
# 产物：
#   web/ws-scrcpy/     网页端本体（上游 NetrisTV/ws-scrcpy）
#   web/certs/         自签证书（Safari 要求 HTTPS 才有 WebCodecs）
#   web/.env           端口 / 令牌 / 上游地址
#   web/logs/          两个进程的日志
set -uo pipefail
cd "$(dirname "$0")" || exit 1
APP="$(pwd)"
ENVF="$APP/.env"
WSREPO="$APP/ws-scrcpy"
UPSTREAM_PORT="${UPSTREAM_PORT:-8000}"
GATE_PORT="${GATE_PORT:-9443}"
NODE_BIN="${NODE_BIN:-node}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() { printf 'x %s\n' "$*" >&2; exit 1; }

need_node() {
  command -v "$NODE_BIN" >/dev/null 2>&1 || die "需要 Node.js 18/20/22（找不到 $NODE_BIN）"
  local v; v=$("$NODE_BIN" -v | tr -d 'v' | cut -d. -f1)
  [ "$v" -ge 18 ] || die "Node 版本太低：$("$NODE_BIN" -v)，需要 >=18"
  [ "$v" -le 22 ] || log "警告：Node $v 偏新，ws-scrcpy 的原生模块可能编不过，建议 20 LTS"
}

# ws-scrcpy 依赖 node-pty（原生模块），没有预编译包时要用 node-gyp 现场编
need_toolchain() {
  local missing=""
  command -v python3 >/dev/null 2>&1 || missing="$missing python3"
  command -v make    >/dev/null 2>&1 || missing="$missing make"
  { command -v g++ >/dev/null 2>&1 || command -v cc >/dev/null 2>&1; } || missing="$missing g++/build-essential"
  if [ -n "$missing" ]; then
    cat >&2 <<EOF
x 缺少构建 node-pty 需要的工具：$missing

  Debian/Ubuntu（含飞牛 NAS）：sudo apt-get install -y build-essential python3
  Alpine：apk add --no-cache build-base python3
  macOS：xcode-select --install

  装完再跑一次 ./run.sh setup
EOF
    exit 1
  fi
}

lan_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' \
    || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
}

gen_cert() {
  local ip; ip=$(lan_ip)
  mkdir -p "$APP/certs"
  [ -f "$APP/certs/cert.pem" ] && return 0
  log "生成自签证书（SAN: $ip, localhost）"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$APP/certs/key.pem" -out "$APP/certs/cert.pem" \
    -subj "/CN=android-mirror" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$ip" >/dev/null 2>&1 \
    || die "openssl 生成证书失败"
  chmod 600 "$APP/certs/key.pem"
}

setup() {
  need_node
  need_toolchain
  command -v git >/dev/null 2>&1 || die "需要 git"
  if [ ! -d "$WSREPO/.git" ]; then
    log "拉取 ws-scrcpy（上游）"
    git clone --depth 1 https://github.com/NetrisTV/ws-scrcpy.git "$WSREPO" || die "clone 失败"
  fi
  log "安装依赖并构建（几分钟，第一次慢）"
  ( cd "$WSREPO" && npm install --no-audit --no-fund ) || die "npm install 失败（多半是 node-pty 编译失败，见上面的工具链提示）"
  ( cd "$WSREPO" && "$NODE_BIN" -e "require('node-pty')" ) || die "node-pty 没装好：先装 build-essential 再重跑 setup"
  ( cd "$WSREPO" && npm run dist ) || die "构建失败"
  log "构建完成（产物在 $WSREPO/dist）"
  gen_cert
  if [ ! -f "$ENVF" ]; then
    local tok; tok=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
    cat > "$ENVF" <<EOF
UPSTREAM_PORT=$UPSTREAM_PORT
GATE_PORT=$GATE_PORT
GATE_TOKEN=$tok
EOF
    chmod 600 "$ENVF"
    log "已生成访问令牌，写在 $ENVF"
  fi
  log "完成。下一步：./web/run.sh start"
}

running() { [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null; }

start() {
  need_node
  [ -f "$ENVF" ] || die "还没 setup，先跑 ./web/run.sh setup"
  # shellcheck disable=SC1090
  set -a; . "$ENVF"; set +a
  mkdir -p "$APP/logs"

  if ! running "$APP/.ws.pid"; then
    log "启动 ws-scrcpy :$UPSTREAM_PORT"
    ( cd "$WSREPO/dist" && setsid nohup "$NODE_BIN" index.js >"$APP/logs/ws.log" 2>&1 < /dev/null & echo $! > "$APP/.ws.pid" )
    sleep 3
  fi
  if ! running "$APP/.gate.pid"; then
    log "启动 HTTPS 门 :$GATE_PORT"
    setsid nohup "$NODE_BIN" "$APP/gate.js" \
      --port "$GATE_PORT" --target "127.0.0.1:$UPSTREAM_PORT" \
      --cert "$APP/certs/cert.pem" --key "$APP/certs/key.pem" \
      --token "$GATE_TOKEN" >"$APP/logs/gate.log" 2>&1 < /dev/null &
    echo $! > "$APP/.gate.pid"
    sleep 1
  fi
  url
}

stop() {
  for f in "$APP/.gate.pid" "$APP/.ws.pid"; do
    [ -f "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null && log "停 $(basename "$f") pid=$(cat "$f")"
    rm -f "$f"
  done
}

status() {
  running "$APP/.ws.pid"   && log "ws-scrcpy 运行中 pid=$(cat "$APP/.ws.pid")"   || log "ws-scrcpy 未运行"
  running "$APP/.gate.pid" && log "https 门  运行中 pid=$(cat "$APP/.gate.pid")" || log "https 门  未运行"
}

url() {
  # shellcheck disable=SC1090
  set -a; . "$ENVF" 2>/dev/null; set +a
  local ip; ip=$(lan_ip)
  printf '\n  iPhone / iPad 打开： https://%s:%s/\n  令牌：%s\n\n' "$ip" "$GATE_PORT" "${GATE_TOKEN:-?}"
}

case "${1:-}" in
  setup)   setup ;;
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  url)     url ;;
  logs)    tail -n 40 "$APP/logs/"*.log ;;
  *) echo "用法: $0 setup|start|stop|restart|status|url|logs"; exit 2 ;;
esac
