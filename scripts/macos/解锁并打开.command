#!/bin/sh
# 萃序 Collecout 没有做 Apple 公证，首次打开会被系统以「无法验证开发者」拦下。
# 双击本文件即可清掉应用的隔离属性并启动它（等价于在终端执行 xattr -cr）。
cd "$(dirname "$0")" || exit 1

APP="Collecout.app"
if [ ! -d "$APP" ]; then
  echo "没有找到 Collecout.app。"
  echo "请把本文件和 Collecout.app 放在同一个文件夹里再双击。"
  exit 1
fi

xattr -cr "$APP"
open "$APP"
