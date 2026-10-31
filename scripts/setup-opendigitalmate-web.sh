#!/bin/bash
# openDigitalMate Web（Bot 模式）安装 / 校验
#
# 预期布局（ROOT 一例是 ~/Documents/ds_dev，目录名不限，关系要一致）：
#
#   $ROOT/
#     dsh-web.sh
#     deepseek-harness/
#     tools/bin/pnpm
#     data/web/harness/profiles/web/    # setup 写入
#     openDigitalMate/                  # 本仓库，与 deepseek-harness 并列
#       scripts/setup-opendigitalmate-web.sh
#       vendor/ds-bot/
#
# 本文件放在仓库的 scripts/ 下时，ROOT 默认是仓库的上一级。
# 仓库不在那个目录里时：export DSH_DEV_ROOT=<含 dsh-web.sh 的目录>
# 被链接进 profile 的始终是「本脚本所在的这个仓库」。
#
#   bash scripts/setup-opendigitalmate-web.sh check
#   bash scripts/setup-opendigitalmate-web.sh setup    # 默认
#   bash scripts/setup-opendigitalmate-web.sh start
#   bash scripts/setup-opendigitalmate-web.sh help
#
# 相对「只跑 dsh-web.sh」多出来的关键步骤（以前失败常见原因）：
#   1) web profile 的 bundles 必须含 ds-bot（不能只有 opendigitalmate）
#   2) dependencies 要 link：vendor/ds-bot + openDigitalMate 仓根
#   3) cordis.patch.yml 要 insert opendigitalmate（已有 LLM / UI 配置保留）
#   4) vendor/ds-bot 里要 npm install --omit=dev（装 deep-view@0.1.0）
#   5) setup 会重写 profiles/web/package.json，不改插件运行时代码

set -euo pipefail
umask 077

phys_dir() {
  (cd -P "$1" && pwd)
}

resolve_roots() {
  local script_dir repo_guess
  script_dir="$(phys_dir "$(dirname "${BASH_SOURCE[0]}")")"
  repo_guess="$(phys_dir "$script_dir/..")"
  # 认仓库名，不要求 vendor/ds-bot 已经在。缺 ds-bot 时 check 要能报缺失，而不是把 ROOT 猜成 scripts/。
  if [ -f "$repo_guess/package.json" ] \
    && grep -q '"name"[[:space:]]*:[[:space:]]*"opendigitalmate"' "$repo_guess/package.json"; then
    ODM="$repo_guess"
  else
    ODM=""
  fi

  if [ -n "${DSH_DEV_ROOT:-}" ]; then
    [ -d "$DSH_DEV_ROOT" ] || die "DSH_DEV_ROOT 不是目录：$DSH_DEV_ROOT"
    ROOT="$(phys_dir "$DSH_DEV_ROOT")"
  elif [ -n "$ODM" ]; then
    ROOT="$(phys_dir "$ODM/..")"
  else
    ROOT="$script_dir"
  fi

  if [ -z "$ODM" ]; then
    ODM="$ROOT/openDigitalMate"
  fi

  if [ "$(basename "$script_dir")" = "scripts" ]; then
    INVOKE="bash scripts/$(basename "${BASH_SOURCE[0]}")"
  else
    INVOKE="bash $(basename "${BASH_SOURCE[0]}")"
  fi
}

info() { printf '[odm-web] %s\n' "$*"; }
warn() { printf '[odm-web] 警告：%s\n' "$*" >&2; }
die() { printf '[odm-web] 错误：%s\n' "$*" >&2; exit 1; }
ok() { printf '[odm-web] OK  %s\n' "$*"; }
miss() { printf '[odm-web] 缺  %s\n' "$*"; }

resolve_roots

readonly ROOT ODM
readonly DSBOT="$ODM/vendor/ds-bot"
readonly HARNESS="$ROOT/deepseek-harness"
readonly WEB_BIN="$ROOT/tools/bin"
readonly DSH_HOME_WEB="$ROOT/data/web/harness"
readonly PROFILE="$DSH_HOME_WEB/profiles/web"
readonly ODM_REMOTE="https://github.com/open-x-agents/openDigitalMate.git"

usage() {
  cat <<EOF
openDigitalMate 本地 Web（Bot 模式）安装部署

  $INVOKE check
  $INVOKE setup   # 默认
  $INVOKE start
  $INVOKE help

当前解析：
  ROOT=$ROOT
  ODM=$ODM

布局（ROOT 默认是本仓库的上一级；否则 export DSH_DEV_ROOT=那个目录）：

  \$ROOT/
    dsh-web.sh
    deepseek-harness/
    tools/bin/pnpm
    data/web/harness/profiles/web/
    openDigitalMate/          # 本仓库，与 deepseek-harness 并列
      scripts/setup-opendigitalmate-web.sh
      vendor/ds-bot/

前提（本脚本不替代）：
  - 已有 deepseek-harness 源码与构建产物 → 先 bash dsh-web.sh check / build
  - Node.js >= 24.9，\$ROOT/tools/bin/pnpm 可用 → 必要时 bash dsh-dev.sh setup
  - macOS，不要用 sudo

本脚本只负责把 openDigitalMate + ds-bot 挂进 data/web/harness 的 web profile。
setup 会重写 profiles/web/package.json（bundles 固定含 ds-bot）。
cordis.patch.yml 只追加 opendigitalmate insert，不覆盖已有 LLM / UI 配置。
EOF
}

need_host() {
  [ "$(uname -s)" = Darwin ] || die "请在 macOS 上运行。"
  [ "$(id -u)" -ne 0 ] || die "不要用 sudo。"
  command -v node >/dev/null 2>&1 || die "未找到 node。"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<24||(a===24&&b<9)){console.error("需要 Node >=24.9，当前 "+process.version); process.exit(1)}'
  command -v git >/dev/null 2>&1 || die "未找到 git。"
  command -v npm >/dev/null 2>&1 || die "未找到 npm。"
}

ensure_dirs() {
  mkdir -p "$DSH_HOME_WEB" "$PROFILE" "$ROOT/data/web/agents" "$ROOT/workspace/web"
}

odm_is_repo() {
  git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

ensure_odm_repo() {
  if ! odm_is_repo "$ODM"; then
    if [ -e "$ODM" ]; then
      die "openDigitalMate 不是 git 仓库：$ODM"
    fi
    info "克隆 openDigitalMate → $ODM"
    git clone "$ODM_REMOTE" "$ODM"
  fi
  [ -f "$ODM/package.json" ] || die "openDigitalMate 不完整：$ODM"
  [ -f "$DSBOT/package.json" ] || die "缺少 vendored ds-bot：$DSBOT"
}

ensure_deep_view() {
  if [ -f "$DSBOT/node_modules/deep-view/package.json" ]; then
    ok "deep-view 已在 vendor/ds-bot/node_modules"
    return 0
  fi
  info "在 vendor/ds-bot 安装 runtime 依赖（deep-view@0.1.0）"
  (cd "$DSBOT" && npm install --omit=dev --no-fund --no-audit)
  [ -f "$DSBOT/node_modules/deep-view/package.json" ] \
    || die "deep-view 安装失败：$DSBOT/node_modules/deep-view"
  ok "deep-view 安装完成"
}

write_profile_package() {
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const dsbot = process.argv[2];
    const odm = process.argv[3];
    const pkg = {
      name: "dsh-profile-web",
      private: true,
      dependencies: {
        "ds-bot": "link:" + dsbot,
        opendigitalmate: "link:" + odm,
      },
      dsh: {
        profile: {
          bundles: [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "ds-bot",
          ],
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$PROFILE/package.json" "$DSBOT" "$ODM"
  ok "profile package.json → ds-bot + opendigitalmate link；bundles 含 ds-bot"
}

cordis_has_odm() {
  # 整行匹配，避免 name: opendigitalmate-extra 被当成已经 insert。
  grep -E -q '^[[:space:]]*name:[[:space:]]*"?opendigitalmate"?[[:space:]]*$' "$1"
}

ensure_cordis_insert() {
  local patch="$PROFILE/cordis.patch.yml"
  if [ ! -f "$patch" ]; then
    cat > "$patch" <<'YAML'
# Your patch layer for this dsh profile, applied after every bundle layer.
- insert:
    - id: opendigitalmate
      name: opendigitalmate
YAML
    ok "新建 cordis.patch.yml 并 insert opendigitalmate"
    return 0
  fi
  if cordis_has_odm "$patch"; then
    ok "cordis.patch.yml 已含 opendigitalmate insert"
    return 0
  fi
  # 保留用户 LLM / UI 配置，只追加 insert
  if [ -n "$(tail -c 1 "$patch" 2>/dev/null || true)" ]; then
    printf '\n' >> "$patch"
  fi
  cat >> "$patch" <<'YAML'
- insert:
    - id: opendigitalmate
      name: opendigitalmate
YAML
  ok "已向现有 cordis.patch.yml 追加 opendigitalmate insert"
}

pnpm_install_profile() {
  [ -x "$WEB_BIN/pnpm" ] || die "缺少 $WEB_BIN/pnpm；请先 bash dsh-dev.sh setup"
  export PATH="$WEB_BIN:$PATH"
  info "pnpm install（profile）"
  (cd "$PROFILE" && pnpm install)
  [ -L "$PROFILE/node_modules/ds-bot" ] || die "ds-bot link 未生成"
  [ -L "$PROFILE/node_modules/opendigitalmate" ] || die "opendigitalmate link 未生成"
  ok "node_modules：ds-bot → $(readlink "$PROFILE/node_modules/ds-bot")"
  ok "node_modules：opendigitalmate → $(readlink "$PROFILE/node_modules/opendigitalmate")"
}

profile_links_ok() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const pkgPath = process.argv[1];
    const dsbot = process.argv[2];
    const odm = process.argv[3];
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); }
    catch { process.exit(1); }
    const deps = pkg.dependencies || {};
    const base = path.dirname(pkgPath);
    const same = (spec, abs) => {
      if (typeof spec !== "string" || !spec.startsWith("link:")) return false;
      try {
        return fs.realpathSync(path.resolve(base, spec.slice(5))) === fs.realpathSync(abs);
      } catch { return false; }
    };
    process.exit(same(deps["ds-bot"], dsbot) && same(deps.opendigitalmate, odm) ? 0 : 1);
  ' "$PROFILE/package.json" "$DSBOT" "$ODM"
}

profile_has_ds_bot_bundle() {
  node -e '
    const fs = require("fs");
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { process.exit(1); }
    const bundles = (((pkg.dsh || {}).profile || {}).bundles) || [];
    process.exit(bundles.includes("ds-bot") ? 0 : 1);
  ' "$PROFILE/package.json"
}

profile_not_odm_only_bundle() {
  node -e '
    const fs = require("fs");
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { process.exit(1); }
    const bundles = (((pkg.dsh || {}).profile || {}).bundles) || [];
    const odmOnly = bundles.includes("opendigitalmate") && !bundles.includes("ds-bot");
    process.exit(odmOnly ? 1 : 0);
  ' "$PROFILE/package.json"
}

check_all() {
  local bad=0
  need_host
  info "根目录：$ROOT"
  info "openDigitalMate：$ODM"
  if [ ! -f "$HARNESS/package.json" ] && [ ! -f "$ROOT/dsh-web.sh" ]; then
    warn "ROOT=$ROOT 不像 ds_dev 根目录。本仓库应与 deepseek-harness、dsh-web.sh 并列；或设置 DSH_DEV_ROOT。"
  fi
  if [ -f "$HARNESS/package.json" ]; then ok "deepseek-harness 源码存在"
  else miss "deepseek-harness 源码（$HARNESS）"; bad=1; fi
  if [ -x "$WEB_BIN/pnpm" ]; then ok "tools/bin/pnpm"
  else miss "tools/bin/pnpm（先 dsh-dev.sh setup）"; bad=1; fi
  if [ -f "$ROOT/dsh-web.sh" ]; then ok "dsh-web.sh"
  else miss "dsh-web.sh"; bad=1; fi
  if odm_is_repo "$ODM"; then
    ok "openDigitalMate @ $(git -C "$ODM" rev-parse --short HEAD) ($(git -C "$ODM" log -1 --pretty=%s))"
  else miss "openDigitalMate 仓库"; bad=1; fi
  if [ -f "$DSBOT/package.json" ]; then ok "vendor/ds-bot"
  else miss "vendor/ds-bot"; bad=1; fi
  if [ -f "$DSBOT/node_modules/deep-view/package.json" ]; then
    ok "deep-view（缺这个会导致 bot failed to import）"
  else miss "vendor/ds-bot/node_modules/deep-view → npm install --omit=dev"; bad=1; fi
  if [ -f "$PROFILE/package.json" ]; then
    if profile_links_ok; then
      ok "profile dependencies 含 ds-bot + opendigitalmate link"
    else
      miss "profile package.json 未正确 link ds-bot / opendigitalmate"
      bad=1
    fi
    if profile_has_ds_bot_bundle; then
      ok "profile bundles 含 ds-bot（Bot 模式）"
    else
      miss "profile bundles 没有 ds-bot（会变成非 Bot 界面）"
      bad=1
    fi
    if profile_not_odm_only_bundle; then
      :
    else
      miss "bundles 只有 opendigitalmate、没有 ds-bot"
      bad=1
    fi
  else
    miss "profile package.json（$PROFILE）"
    bad=1
  fi
  if [ -f "$PROFILE/cordis.patch.yml" ] && cordis_has_odm "$PROFILE/cordis.patch.yml"; then
    ok "cordis.patch.yml insert opendigitalmate"
  else
    miss "cordis.patch.yml 未 insert opendigitalmate"
    bad=1
  fi
  if [ -L "$PROFILE/node_modules/ds-bot" ] && [ -L "$PROFILE/node_modules/opendigitalmate" ]; then
    ok "profile node_modules links"
  else
    miss "profile node_modules links（需在 profiles/web 下 pnpm install）"
    bad=1
  fi
  if [ "$bad" -eq 0 ]; then
    info "检查全部通过。启动：$INVOKE start"
    return 0
  fi
  info "有缺失项。执行：$INVOKE setup"
  return 1
}

do_setup() {
  need_host
  ensure_dirs
  [ -f "$HARNESS/package.json" ] || die "先准备 deepseek-harness（bash dsh-dev.sh setup && bash dsh-web.sh build）"
  [ -f "$ROOT/dsh-web.sh" ] || die "缺少 dsh-web.sh"
  ensure_odm_repo
  info "当前 openDigitalMate：$(git -C "$ODM" rev-parse --short HEAD) — 如需最新：git -C \"$ODM\" pull --ff-only origin main"
  ensure_deep_view
  write_profile_package
  ensure_cordis_insert
  pnpm_install_profile
  info "setup 完成。"
  check_all || true
  cat <<EOF

下一步：
  $INVOKE start
  # 或：bash dsh-web.sh start
  # 浏览器打开日志里的 http://127.0.0.1:3081/?token=...
  # 应看到左侧 Bot 房间（Writer / Chief…），不是普通单 Agent 界面。

若启动日志出现：
  bot (ds-bot): failed to import ... Cannot find package 'deep-view'
说明 deep-view 未装进 vendor/ds-bot，重新跑本脚本 setup。
EOF
}

do_start() {
  need_host
  check_all || die "先跑 setup 补齐缺失项。"
  info "转调 bash dsh-web.sh start"
  cd "$ROOT" || die "无法进入 $ROOT"
  exec bash ./dsh-web.sh start
}

cmd="${1:-setup}"
case "$cmd" in
  help|-h|--help) usage; exit 0 ;;
  check) check_all ;;
  setup) do_setup ;;
  start) do_start ;;
  *) usage >&2; die "未知命令：$cmd" ;;
esac
