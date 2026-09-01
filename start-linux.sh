#!/usr/bin/env bash
# ============================================================
# 拾光集 - Linux 启动脚本（学 downloader start-linux.sh）
# 用法：
#   重启（默认）：./start-linux.sh [restart] [--port 8081]
#   启动：        ./start-linux.sh start [--port 8081]
#   停止：        ./start-linux.sh stop
#   状态：        ./start-linux.sh status
#   设置密码：    ./start-linux.sh --set-password "新密码"
# ============================================================
set -e
cd "$(dirname "$0")"

LOG_FILE="server/server.log"
PID_FILE="/tmp/gallery.pid"
NODE_BIN=""
DEFAULT_PORT=8081

find_node() {
  for c in node /usr/bin/node /usr/local/bin/node /opt/node/bin/node \
           /var/packages/Node.js_v20/target/usr/local/bin/node \
           /var/packages/Node.js_v18/target/usr/local/bin/node; do
    if command -v "$c" >/dev/null 2>&1 || [[ -x "$c" ]]; then
      NODE_BIN="$(command -v "$c" 2>/dev/null || echo "$c")"
      return 0
    fi
  done
  return 1
}

if ! find_node; then
  echo "❌ 未找到 Node.js！请先安装 Node.js LTS"
  exit 1
fi
echo "✓ Node.js: $NODE_BIN ($($NODE_BIN -v))"

start_server() {
  local port_opt=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) port_opt="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "⚠️  服务已在运行（PID: $(cat "$PID_FILE")）"
    return 1
  fi
  local port="${port_opt:-$DEFAULT_PORT}"
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "▶ 启动 拾光集 (端口 $port) ..."
  PORT="$port" nohup "$NODE_BIN" server/app.js >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  echo "✓ 服务已启动，PID: $pid"
  echo "  日志文件: $LOG_FILE"
  echo "  停止服务: ./$0 stop"
}

stop_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "⚠️  PID 文件不存在，服务可能未运行"
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "⚠️  进程 $pid 不存在，清理 PID 文件"
    rm -f "$PID_FILE"
    return 1
  fi
  echo "▶ 停止服务 (PID: $pid) ..."
  kill "$pid"
  local count=0
  while kill -0 "$pid" 2>/dev/null && [[ $count -lt 10 ]]; do
    sleep 1
    ((count++))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "  进程未响应，强制终止 ..."
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "✓ 服务已停止"
}

restart_server() {
  echo "▶ 重启服务 ..."
  stop_server || true
  start_server "$@"
}

status_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "✓ 服务正在运行，PID: $pid"
      return 0
    else
      echo "⚠️  PID 文件存在但进程已消失"
      rm -f "$PID_FILE"
      return 1
    fi
  else
    echo "❌ 服务未运行"
    return 1
  fi
}

if [[ "$1" == "--set-password" ]]; then
  if [[ -z "$2" ]]; then
    echo "❌ 请提供新密码: --set-password \"新密码\""
    exit 1
  fi
  "$NODE_BIN" server/app.js --set-password "$2"
  echo "✓ 密码已设置"
  exit 0
fi

CMD="${1:-restart}"
if [[ "$CMD" == "--port" ]]; then
  CMD="restart"
  shift
elif [[ "$CMD" == "start" || "$CMD" == "stop" || "$CMD" == "restart" || "$CMD" == "status" ]]; then
  shift
else
  CMD="start"
fi

case "$CMD" in
  start)    start_server "$@" ;;
  stop)     stop_server ;;
  restart)  restart_server "$@" ;;
  status)   status_server ;;
  *)
    echo "❌ 未知命令: $CMD"
    echo "可用命令: start, stop, restart, status"
    echo "旧用法: --port PORT 或 --set-password PASSWORD"
    exit 1
    ;;
esac
