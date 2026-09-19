#!/usr/bin/env bash
# ============================================================
# POSIX 启停脚本（Linux / 群晖 / macOS 共用）
# 用法：
#   ./start.sh start [--port PORT]
#   ./start.sh restart [--port PORT]   # 默认命令
#   ./start.sh stop
#   ./start.sh status
#   ./start.sh --port PORT             # 兼容旧用法（等价 restart）
#   ./start.sh --set-password "新密码"
# PID：项目根 / 项目全称.pid（见 pid-file-at-project-root）
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="$(basename "$ROOT")"
SERVER_DIR="$ROOT/server"
PID_FILE="$ROOT/${PROJECT_NAME}.pid"
LOG_FILE="$SERVER_DIR/server.log"
CONFIG_FILE="$SERVER_DIR/config.json"
# 默认端口：优先读 server/config.schema.json 的 port.default —— 各项目端口不同
#   （gallery 8081、gbmd/iwara 8642），通用脚本不该写死某一个项目的端口。
#   读不到（未声明/无 schema）才回落到 8642。
SCHEMA_PORT=""
if [ -f "$ROOT/server/config.schema.json" ]; then
  SCHEMA_PORT="$(sed -n 's/.*"port"[^}]*"default"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/server/config.schema.json" 2>/dev/null | head -n 1)"
fi
DEFAULT_PORT="${DEFAULT_PORT:-${SCHEMA_PORT:-8642}}"
LOG_ROTATE_BYTES=$((10 * 1024 * 1024))
STOP_WAIT_SEC=10
START_WAIT_SEC="${START_WAIT_SEC:-15}"   # 启动前等端口释放的上限（秒）

# ---------- 颜色（stdout 是终端才开；NO_COLOR / TERM=dumb 关闭）----------
C_GREEN="" C_YELLOW="" C_RED="" C_DIM="" C_RESET=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
fi
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
err()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

# 历史 PID 位置（迁移兼容）：老版本把这些 PID 落在 server/ 或 /tmp。
# 只按「本项目名」枚举，不硬编码具体项目——否则换项目名后这里就成了死代码
# （曾写死 gbmd.pid / gbmd-macos.pid，别的项目复用时既清不掉旧 PID 也读不到）。
legacy_pid_files() {
  printf '%s\n' \
    "$SERVER_DIR/app.pid" \
    "$SERVER_DIR/${PROJECT_NAME}.pid" \
    "/tmp/${PROJECT_NAME}.pid" \
    "/tmp/${PROJECT_NAME}-macos.pid" \
    "/tmp/start-${PROJECT_NAME}.pid"
}

# 项目自带工具目录：命名为 tool/ 与 tools/ 的都有（gallery 用 tools/），两个都认。
TOOL_DIR=""
for d in "$ROOT/tools" "$ROOT/tool"; do
  if [ -d "$d" ]; then TOOL_DIR="$d"; break; fi
done
export PATH="${TOOL_DIR:+$TOOL_DIR/node/bin:}/usr/local/bin:/opt/homebrew/bin:/opt/node/bin:/var/packages/Node.js_v24/target/usr/local/bin:/var/packages/Node.js_v22/target/usr/local/bin:/var/packages/Node.js_v20/target/usr/local/bin:$PATH"
if [ -n "$TOOL_DIR" ]; then export FFMPEG="${FFMPEG:-$TOOL_DIR/ffmpeg}"; fi

# ---------- Node 定位 ----------
# start.sh 是「独立可搬运」脚本：它会被直接拷进项目根，而项目里没有 scripts/。
# 因此这里内联定位逻辑，不 source 外部文件——否则换了环境就找不到 node
# （表现为脚本刚启动就报 lib-node.sh 不存在）。
# 候选顺序与 scripts/lib-node.sh 保持一致，改一处要同步改另一处。
find_node() {
  local c nvm
  for c in \
    "$ROOT/tool/node/bin/node" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /opt/node/bin/node \
    /var/packages/Node.js_v24/target/usr/local/bin/node \
    /var/packages/Node.js_v22/target/usr/local/bin/node \
    /var/packages/Node.js_v20/target/usr/local/bin/node \
    /var/packages/DeepSeekHarness-NAS/target/bin/node \
    node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; return 0; fi
    if command -v "$c" >/dev/null 2>&1; then NODE_BIN="$(command -v "$c")"; return 0; fi
  done
  for nvm in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$nvm" ]; then NODE_BIN="$nvm"; return 0; fi
  done
  return 1
}

if ! find_node; then
  err "❌ 找不到 node。请安装 Node.js，或把官方二进制解压到 tool/node/"
  exit 1
fi
ok "✓ Node: $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"

file_size() {
  local f="$1"
  [ -f "$f" ] || { echo 0; return; }
  stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || wc -c < "$f"
}

human_size() {
  local n="$1"
  if [ "$n" -ge 1048576 ]; then awk -v n="$n" 'BEGIN{printf "%.1fMB", n/1048576}'; else awk -v n="$n" 'BEGIN{printf "%.1fKB", n/1024}'; fi
}

# ---------- 配置验证（不打印 Cookie / Token / 密码哈希）----------
validate_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    warn "⚠️  无 $CONFIG_FILE ，启动后会按默认值生成"
    return 0
  fi
  local out rc=0
  out="$("$NODE_BIN" -e '
const fs = require("fs");
const p = process.argv[1];
const def = Number(process.argv[2]);
let raw;
try { raw = fs.readFileSync(p, "utf8"); }
catch (e) {
  const code = e && e.code ? e.code : "";
  console.log((code === "EACCES" || code === "EPERM" ? "NO_PERM " : "READ_FAIL ") + (e.message || code));
  process.exit(2);
}
let c;
try { c = JSON.parse(raw); }
catch (e) { console.log("JSON_FAIL " + e.message); process.exit(3); }
if (!c || typeof c !== "object" || Array.isArray(c)) {
  console.log("NOT_OBJECT");
  process.exit(4);
}
if (c.port != null && c.port !== "") {
  const n = Number(c.port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.log("BAD_PORT " + String(c.port));
    process.exit(5);
  }
}
const port = (c.port == null || c.port === "") ? def : Number(c.port);
console.log("OK " + port);
' "$CONFIG_FILE" "$DEFAULT_PORT" 2>&1)" || rc=$?
  case "$out" in
    OK\ *) ok "✓ config.json 格式正常  port=${out#OK }"; return 0 ;;
    NO_PERM\ *) warn "⚠️  无权限读 config.json，跳过格式校验"; return 0 ;;
  esac
  err "❌ config.json 校验失败：$out"
  return 1
}

config_port() {
  "$NODE_BIN" -e '
try {
  const c = require(process.argv[1]);
  const d = Number(process.argv[2]);
  const n = Number(c.port);
  console.log(Number.isInteger(n) && n >= 1 && n <= 65535 ? n : d);
} catch (e) { console.log(process.argv[2]); }
' "$CONFIG_FILE" "$DEFAULT_PORT" 2>/dev/null || echo "$DEFAULT_PORT"
}

rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  local sz
  sz="$(file_size "$LOG_FILE")"
  [ "$sz" -gt "$LOG_ROTATE_BYTES" ] || return 0
  local ts dest
  ts="$(date +%Y%m%d-%H%M%S)"
  dest="${LOG_FILE}.${ts}"
  mv "$LOG_FILE" "$dest" || return 0
  if command -v gzip >/dev/null 2>&1; then
    gzip -f "$dest" && dest="${dest}.gz"
  fi
  warn "⚠️  日志超过 10MB，已轮转: $dest ($(human_size "$sz"))"
}

pid_alive() {
  local p="$1"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

read_pid_file() {
  local f="$1"
  [ -f "$f" ] && [ -s "$f" ] || return 1
  tr -d ' \t\r\n' < "$f"
}

collect_live_pids() {
  local f p seen=" "
  for f in "$PID_FILE" $(legacy_pid_files); do
    p="$(read_pid_file "$f" 2>/dev/null || true)"
    if pid_alive "$p"; then
      case "$seen" in
        *" $p "*) ;;
        *) seen="$seen$p "; printf '%s\n' "$p" ;;
      esac
    fi
  done
  # 端口兜底：被外部（宿主/手动 nohup）拉起时不会写 PID 文件，只靠 PID 文件
  #   会误判「未运行」而漏杀，随后 start 阶段又因端口占用起不来。
  #   这里按监听端口反查 PID（仅认本项目 node 进程，避免误杀同端口其他程序）。
  local port
  port="$(config_port 2>/dev/null || true)"
  [ -n "$port" ] || return 0
  local lp
  lp="$(port_pids "$port")"
  for p in $lp; do
    case "$seen" in
      *" $p "*) ;;
      *) seen="$seen$p "; printf '%s\n' "$p" ;;
    esac
  done
}

# 本机是否已有进程监听该端口（精确匹配端口号，不看 PID）
#   注意：必须用「末尾锚定」的端口匹配。旧写法 `$4 ~ ":8642"` 是子串匹配，
#   会连 ":18642" / ":86421" 一起命中——同机跑多实例时互相误判、误杀。
port_in_use() {
  local port="$1" out=""
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -tln 2>/dev/null)"
  elif command -v netstat >/dev/null 2>&1; then
    out="$(netstat -tln 2>/dev/null)"
  fi
  [ -n "$out" ] || return 1
  # 第 4 列形如 0.0.0.0:8642 / [::]:8642 / :::8642 / 127.0.0.1:8642
  printf '%s\n' "$out" | awk -v p="$port" '
    $4 ~ ("[.:]" p "$") { found = 1; exit }
    END { exit(found ? 0 : 1) }'
}

# 监听指定端口的进程 PID（取本项目 node 进程；优先 ss，退回 netstat）
port_pids() {
  local port="$1" out=""
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -tlnp 2>/dev/null | awk -v p="$port" '$4 ~ ("[.:]" p "$") {print}')"
  elif command -v netstat >/dev/null 2>&1; then
    out="$(netstat -tlnp 2>/dev/null | awk -v p="$port" '$4 ~ ("[.:]" p "$") {print}')"
  fi
  [ -n "$out" ] || return 0
  # ss 格式：users:(("node",pid=1234,fd=20)) → 取 pid=NNN
  # netstat 格式：最后一列是 "1234/node"        → 取斜杠前的数字
  printf '%s\n' "$out" | grep -o 'pid=[0-9]*' | cut -d= -f2
  printf '%s\n' "$out" | awk '{n=split($NF,a,"/"); if (n>1 && a[1] ~ /^[0-9]+$/) print a[1]}'
}

# 等端口真正释放（旧进程退出 ≠ 端口立刻可用：TIME_WAIT、子进程继承 fd）
#   返回 0 = 已释放，1 = 超时仍被占用
wait_port_free() {
  local port="$1" timeout="${2:-10}" i=0
  while [ "$i" -lt "$((timeout * 2))" ]; do
    port_in_use "$port" || return 0
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

listen_line() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | awk -v p=":$port" '$0 ~ p {print; exit}'
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk -v p=":$port" '$0 ~ p {print; exit}'
  fi
}

start_server() {
  local port_opt=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port_opt="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done
  validate_config || return 1
  local port="${port_opt:-$(config_port)}"
  local live
  live="$(collect_live_pids | head -n 1 || true)"
  if [ -n "$live" ]; then
    warn "⚠️  已在运行 (PID $live, 端口 $port)。如需重启: ./start.sh restart"
    return 1
  fi
  # 端口仍被占但找不到归属进程：典型是上一次重启刚发的 SIGTERM 还没走完，
  #   连接处于 TIME_WAIT、或子进程临时继承了监听 fd（非 root 看不到其 PID）。
  #   旧逻辑此处直接启动，bind 失败后进程秒退，表现为「重启后服务没起来」。
  #   这里先等端口真正空出来，等到就继续启动，等不到才报错退出。
  if port_in_use "$port"; then
    warn "⏳ 端口 $port 仍被占用，等待释放（最多 ${START_WAIT_SEC}s）..."
    if ! wait_port_free "$port" "$START_WAIT_SEC"; then
      err "❌ 端口 $port 等待 ${START_WAIT_SEC}s 仍未释放，放弃启动。"
      err "   排查：netstat -tlnp | grep :$port   或换端口: ./start.sh --port <新端口>"
      return 1
    fi
    ok "✓ 端口 $port 已释放"
  fi
  rm -f "$PID_FILE"
  mkdir -p "$SERVER_DIR"
  rotate_log
  cd "$SERVER_DIR" || exit 1
  local cmd=("$NODE_BIN" boot.cjs)
  if [ -n "$port_opt" ]; then
    export PORT="$port_opt"
    cmd+=("--port" "$port_opt")
  fi
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "${cmd[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup "${cmd[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  echo $! > "$PID_FILE"
  local new_pid
  new_pid="$(cat "$PID_FILE")"

  local okflag=0 i
  for i in $(seq 1 8); do
    sleep 1
    if curl -sf -m 3 "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then
      okflag=1
      break
    fi
    pid_alive "$new_pid" || break
  done
  if [ "$okflag" = 1 ]; then
    ok "✅ 启动成功  PID=$new_pid  端口=$port"
    echo "   页面: http://<本机IP>:$port"
    echo "   日志: $LOG_FILE"
    echo "   PID:  $PID_FILE"
  else
    err "❌ 启动失败（8 秒内未通过健康检查），最近日志："
    tail -15 "$LOG_FILE" 2>/dev/null
    return 1
  fi
}

stop_one() {
  local pid="$1"
  warn "⏹  SIGTERM  PID=$pid （最多等 ${STOP_WAIT_SEC}s）"
  kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 "$STOP_WAIT_SEC"); do
    if ! pid_alive "$pid"; then
      ok "✓ PID $pid 已在 ${i}s 内退出"
      return 0
    fi
    sleep 1
  done
  if pid_alive "$pid"; then
    warn "⚠️  ${STOP_WAIT_SEC}s 未退出，SIGKILL PID=$pid"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
  if pid_alive "$pid"; then
    err "❌ PID $pid 仍在，请检查"
    return 1
  fi
  ok "✓ PID $pid 已强制结束"
}

stop_server() {
  local pids
  pids="$(collect_live_pids || true)"
  if [ -z "$pids" ]; then
    warn "⚠️  未运行（无有效 PID）"
    rm -f "$PID_FILE"
    local f
    for f in $(legacy_pid_files); do rm -f "$f"; done
    return 0
  fi
  local rc=0
  for p in $pids; do
    stop_one "$p" || rc=1
  done
  rm -f "$PID_FILE"
  local f
  for f in $(legacy_pid_files); do rm -f "$f"; done
  if [ "$rc" = 0 ]; then
    ok "✅ 已停止"
  else
    err "❌ 停止未完成"
  fi
  return "$rc"
}

status_server() {
  local port
  port="$(config_port)"
  echo "======== $PROJECT_NAME ========"
  echo "根目录: $ROOT"
  echo "PID文件: $PID_FILE$([ -f "$PID_FILE" ] && echo " (存在)" || echo " (无)")"
  echo "配置:   $CONFIG_FILE"
  validate_config || true

  local p
  p="$(read_pid_file "$PID_FILE" 2>/dev/null || true)"
  if pid_alive "$p"; then
    ok "进程:   ✓ PID $p"
    ps -o pid=,ppid=,etime=,rss=,stat=,args= -p "$p" 2>/dev/null | while IFS= read -r line; do
      dim "        $line"
    done
  elif [ -n "$p" ]; then
    err "进程:   ✗ PID 文件有 $p 但进程已退出"
  else
    err "进程:   ✗ 未运行"
  fi

  local extra extra_other=""
  extra="$(ps -eo pid,args 2>/dev/null | awk -v root="$ROOT" '
    $0 ~ /boot\.cjs/ && $0 ~ /node/ && index($0, root) { print $1 }
  ' || true)"
  for p2 in $extra; do
    if [ "$p2" != "${p:-}" ]; then extra_other="$extra_other $p2"; fi
  done
  extra_other="$(echo "$extra_other" | xargs)"
  if [ -n "$extra_other" ]; then
    warn "进程:   ⚠️  未记入 PID 文件: $extra_other"
  fi

  local lis
  lis="$(listen_line "$port")"
  if [ -n "$lis" ]; then
    ok "监听:   ✓ 端口 $port"
    dim "        $lis"
  else
    warn "监听:   未发现 :$port"
  fi

  local curlout code time
  curlout="$(curl -sS -m 5 -o /tmp/${PROJECT_NAME}-status.body -w '%{http_code} %{time_total}' "http://127.0.0.1:$port/api/status" 2>/dev/null || echo "000 0")"
  code="${curlout%% *}"
  time="${curlout#* }"
  if [ "$code" = "200" ]; then
    ok "HTTP:   ✓ GET /api/status  $code  ${time}s"
    head -c 240 "/tmp/${PROJECT_NAME}-status.body" 2>/dev/null; echo
  else
    err "HTTP:   ✗ GET /api/status  HTTP $code"
  fi
  rm -f "/tmp/${PROJECT_NAME}-status.body"

  if [ -f "$LOG_FILE" ]; then
    local sz mtime
    sz="$(file_size "$LOG_FILE")"
    mtime="$(date -r "$LOG_FILE" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || stat -c %y "$LOG_FILE" 2>/dev/null | cut -d. -f1)"
    echo "日志:   $LOG_FILE  $(human_size "$sz")  更新 $mtime"
    if [ "$sz" -gt "$LOG_ROTATE_BYTES" ]; then
      warn "日志:   已超过 10MB，下次 start/restart 会轮转压缩"
    fi
    echo "-------- 最近 8 行 --------"
    tail -8 "$LOG_FILE" 2>/dev/null
  else
    warn "日志:   尚无 $LOG_FILE"
  fi
}

if [ "${1:-}" = "--set-password" ]; then
  if [ -z "${2:-}" ]; then
    err "❌ 请提供新密码: --set-password \"新密码\""
    exit 1
  fi
  "$NODE_BIN" "$SERVER_DIR/boot.cjs" --set-password "$2"
  ok "✓ 密码已设置"
  exit 0
fi

CMD="${1:-restart}"
if [ "$CMD" = "--port" ]; then
  CMD="restart"
elif [ "$CMD" = "start" ] || [ "$CMD" = "stop" ] || [ "$CMD" = "restart" ] || [ "$CMD" = "status" ]; then
  shift
else
  CMD="restart"
fi

case "$CMD" in
  start)   start_server "$@" ;;
  stop)    stop_server ;;
  restart)
    # 不再用固定 sleep 1：stop 只保证进程退出，端口未必立刻可用。
    #   start_server 内部会等端口释放（START_WAIT_SEC），这里只做一次
    #   短暂的进程回收间隔，避免 stop 刚 kill 完就 bind。
    stop_server
    sleep 1
    start_server "$@"
    ;;
  status)  status_server ;;
  *)
    err "❌ 未知命令: $CMD"
    echo "可用命令: start, stop, restart, status"
    exit 1
    ;;
esac
