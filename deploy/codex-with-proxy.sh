#!/bin/zsh
# Runner 净化环境不透传代理变量；本机 codex 出网依赖本地代理（与 Leo shell 的 codex 函数同参）。
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
export NO_PROXY=127.0.0.1,localhost
exec /opt/homebrew/bin/codex "$@"
