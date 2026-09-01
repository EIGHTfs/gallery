#!/usr/bin/env bash
# ============================================================
# 用项目本地的 GitHub 推送凭据，推送到 origin/master
#
# 凭据文件：项目根 .git-push-token（已 gitignore，绝不上库）
#   内容：一行 GitHub token（ghp_... / github_pat_...）
#   首次：把 token 写入该文件即可；本脚本每次从它读取，不依赖外部存档。
# 用法：bash scripts/git-push.sh [--force]
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN_FILE=".git-push-token"
CRED_FILE=".git-credentials-local"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "❌ 未找到 $TOKEN_FILE" >&2
  echo "   请把 GitHub token 写入项目根 $TOKEN_FILE（该文件已被 .gitignore 忽略，不会入库）" >&2
  exit 1
fi

TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
if [[ -z "$TOKEN" ]]; then
  echo "❌ $TOKEN_FILE 为空" >&2
  exit 1
fi

# 用 credential store 临时文件，避免 token 出现在命令行/进程列表
printf 'https://EIGHTfs:%s@github.com\n' "$TOKEN" > "$CRED_FILE"
chmod 600 "$CRED_FILE"
trap 'rm -f "$CRED_FILE"' EXIT

BRANCH=$(git branch --show-current)
echo "▶ 推送 ${BRANCH} → origin（使用项目本地凭据）..."
timeout 120 git -c credential.helper="store --file=$CRED_FILE" push origin "$BRANCH" "$@"
echo "✅ 推送完成"
