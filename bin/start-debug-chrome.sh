#!/bin/bash
# start-debug-chrome.sh
# 启动带远程调试端口的 Chrome，使用真实 profile 副本（保留所有登录态）
#
# 已验证：macOS + Chrome 149+
#
# 用法：
#   ./start-debug-chrome.sh              # 启动调试 Chrome（首次自动复制真实 profile）
#   ./start-debug-chrome.sh --rebuild    # 删除副本并重建（适合副本损坏 / 需要重新登录）
#
# 说明：副本一旦登录过，登录态就持久保存在副本里，不需要、也不应该再从真实
#       profile 同步 cookie（v20 cookie 跨路径解不开，同步只会把登录态冲掉）。
#       详见 docs/chrome.md。

set -e

CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
REAL_PROFILE="$HOME/Library/Application Support/Google/Chrome"
DEBUG_PROFILE="${TOOLKIT_DEBUG_PROFILE:-$HOME/chrome-debug-profile}"
DEBUG_PORT="${TOOLKIT_DEBUG_PORT:-9222}"

REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
  esac
done

if [ ! -f "$CHROME_PATH" ]; then
  echo "❌ Chrome 未找到: $CHROME_PATH"
  exit 1
fi

# 已开则退出
if curl -s --max-time 1 "http://localhost:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
  echo "✅ 调试端口 $DEBUG_PORT 已在线"
  exit 0
fi

echo "🔪 只关闭使用副本目录的残留 Chrome（真实 Chrome 保留）..."
pkill -9 -f "user-data-dir=$DEBUG_PROFILE" 2>/dev/null || true
sleep 1

if [ $REBUILD -eq 1 ] && [ -d "$DEBUG_PROFILE" ]; then
  echo "♻️  --rebuild：删除旧副本 $DEBUG_PROFILE"
  rm -rf "$DEBUG_PROFILE"
fi

if [ ! -d "$DEBUG_PROFILE" ]; then
  echo "📦 首次复制真实 profile 到 $DEBUG_PROFILE（可能 1-3 分钟）..."
  rsync -a --exclude='Singleton*' "$REAL_PROFILE/" "$DEBUG_PROFILE/"
  echo "✅ 复制完成: $(du -sh "$DEBUG_PROFILE" | cut -f1)"
  echo "ℹ️  首次启动后请用 node bin/login-helper.mjs <site> 在副本里登录一次（永久保留）"
fi

rm -f "$DEBUG_PROFILE/Singleton"* 2>/dev/null || true

echo "🚀 启动 Chrome（调试端口 $DEBUG_PORT）..."
# 关键 flag：
# - --disable-blink-features=AutomationControlled：关闭 navigator.webdriver 指纹
# - --disable-features=LockProfileCookieDatabase：让跨路径副本仍能读旧 v10 cookie
"$CHROME_PATH" \
  --remote-debugging-port=$DEBUG_PORT \
  --user-data-dir="$DEBUG_PROFILE" \
  --disable-blink-features=AutomationControlled \
  --disable-features=LockProfileCookieDatabase \
  --no-first-run \
  --no-default-browser-check \
  > /dev/null 2>&1 &

for i in $(seq 1 20); do
  sleep 1
  if curl -s --max-time 1 "http://localhost:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
    BROWSER=$(curl -s "http://localhost:$DEBUG_PORT/json/version" | python3 -c "import sys,json; print(json.load(sys.stdin)['Browser'])")
    echo "✅ 调试端口就绪 (${i}s) | 🌐 $BROWSER"
    exit 0
  fi
  echo -n "."
done

echo ""
echo "❌ Chrome 启动超时"
exit 1
