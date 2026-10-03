#!/usr/bin/env bash
#
# 一条命令发一版：**先核对「这一版的说明写了吗」**，再跑自检、打 tag、建 Release。
#
#   bash tools/release.sh v0.1.2                # 正式版
#   bash tools/release.sh v0.1.2-beta1          # 预发布（按 tag 后缀自动判）
#   bash tools/release.sh v0.1.2 --dry-run      # 只说要做的事，一个字节都不改
#   bash tools/release.sh v0.1.2 --yes          # 不问确认（非交互时必需）
#   bash tools/release.sh v0.1.2 --skip-gates   # 跳过静态自检（不建议）
#
# ── 为什么要有它（2026-10-03，`v0.1.1` 那次）──────────────────────────────────
#
# `v0.1.1` 与 `v0.1.1-beta3` 两次发布坏的是同一件事：**资产全传上去了、Release 页面是空的**。
# 根因不是脚本坏了，是**顺序** —— Release 正文的唯一来源是 `CHANGELOG.md`
# （`tools/release-notes.mjs` 抽 `## <tag>` 那一段），而 `RELEASE_TEMPLATE.md` 要求
# 「先提交、再打 tag」。**这条约束没有任何东西强制它**：忘了就忘了，而且症状出现在
# **发布之后**（那时资产已经传完，只能事后补一次、重跑一个 job）。
#
# 所以这个脚本把「提交说明」「打 tag」「建 Release」合成一个动作，而**第 3 步就是核对说明**
# —— 顺序错不了。它**不负责写说明**（那是人/模型的事），它负责让「漏写」不可能悄悄溜过。
#
# ⚠️★ 顺带消掉一个窗口期：正文是**建 Release 时**就带上去的（`--notes-file`），
#    所以不会出现「页面先空几秒、显示 tag 那句英文提交信息」那一段（模板里写过它）。
#    CI 里那个 `release-notes` job 从此只是一道安全网。
#
# ⚠️★ `--dry-run` 除外的每一步都会改**远端**（推 tag、建 Release 都会立刻触发 CI）。
#    第 3 步之前的所有检查都是为了「不要打出去一个半成品」—— 已经打出去的 tag
#    是别人下载、镜像、tap 认着的东西，事后挪它比补一段说明更坏。
#
# ── 它**不**做什么 ─────────────────────────────────────────────────────────────
#
#   · 不写说明、不替你润色：只核对 `CHANGELOG.md` 里有没有 `<tag>` 那一段。
#   · 不跑 Rust / Android / 打包：那是 CI 的事。这里只跑**静态自检**（几秒钟）。
#   · 不改版本号：这个仓库没有版本号文件，版本号只住在 tag 里（见 `RELEASE_TEMPLATE.md`）。

set -euo pipefail

# ⚠️ 允许用 `CLIP9_RELEASE_ROOT` 指向另一棵树 —— **判据（`tools/release-smoke.mjs`）靠它做夹具**。
#    不设时就是「本脚本所在仓库」。
ROOT="${CLIP9_RELEASE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE="${NODE:-node}"
GH="${GH:-gh}"

TAG=''
DRY=0
ASSUME_YES=0
SKIP_GATES=0

# ⚠️ 静态自检那一批与 CI 的 frontend job 同源（`node tools/<n>.mjs`）。
#    `release-smoke` 也在里面：它验的是**本脚本自己**（夹具里跑拒绝路径）——
#    它的夹具一律带 `--skip-gates`，所以不会套娃。
GATES='desktop-ui-smoke share-bridge-smoke shell-smoke android-contract-smoke workflows-smoke release-smoke'

die() {
  printf '\n✗ %s\n' "$*" >&2
  exit 1
}

note() { printf '  %s\n' "$*"; }
head1() { printf '\n── %s ────────────────────────────────\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# 只会打印、不会执行 —— `--dry-run` 的那一半。
run() {
  if [ "$DRY" = 1 ]; then
    printf '  [dry-run] %s\n' "$*"
    return 0
  fi
  printf '  $ %s\n' "$*"
  "$@"
}

usage() {
  # ⚠️ 用法那一段就从**本文件抬头**里取（单一来源，与上面的注释不会各说各话）：
  #    从「一条命令发一版」那行开始，到第一条 `# ── …` 分隔线为止。
  #    ⚠️ 刻意**不写死行号** —— 抬头一改就失准，而这类失准不会有人发现。
  sed -n '/^# 一条命令发一版/,/^# ── /p' "${BASH_SOURCE[0]}" | sed '$d' | sed -e 's/^# \{0,1\}//' -e '/^$/d'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --skip-gates) SKIP_GATES=1 ;;
    -h | --help) usage ;;
    -*) die "不认识的参数：$1（--help 看用法）" ;;
    *)
      [ -z "$TAG" ] || die "只接受一个 tag（已经给过 ${TAG}，又来一个 $1）"
      TAG="$1"
      ;;
  esac
  shift
done

[ -n "$TAG" ] || usage

# ── 0. 环境 ──────────────────────────────────────────────────────────────────
have git || die '找不到 git'
have "$NODE" || die "找不到 node（可用 NODE=<路径> 指定）"
[ -d "$ROOT/.git" ] || die "${ROOT} 不是一个 git 仓库"

# ── 1. tag 形状 ──────────────────────────────────────────────────────────────
# ⚠️ 预发布与否**由 tag 自己决定**（有 `-` 后缀就是），不给开关：
#    「记得去网页上勾 pre-release」正是那个事后补不回来的动作（`release.yml` 的 info job
#    是按 release 对象问出来的），交给命名规则比交给记忆可靠。
case "$TAG" in
  *-*) PRE=1 ;;
  *) PRE=0 ;;
esac
if ! printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  die "标签要形如 v0.1.2 或 v0.1.2-beta1（收到 ${TAG}）"
fi

printf '══ 发 %s（%s）══\n' "$TAG" "$([ "$PRE" = 1 ] && printf '预发布' || printf '正式版')"

head1 '1/6 前置检查'

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = main ] || die "要在 main 上发（现在是 ${BRANCH}）"
note "分支 main ✓"

# 工作区：只允许「只有 CHANGELOG.md 改了」这一种脏 —— 那正是这一版新增的说明，
# 下面会替它 commit（提交信息用模板 §3 规定的形状）。
CHANGELOG_DIRTY=0
OTHERS=''
while IFS= read -r line; do
  [ -n "$line" ] || continue
  path="${line:3}"
  if [ "$path" = 'CHANGELOG.md' ]; then
    CHANGELOG_DIRTY=1
  else
    OTHERS="${OTHERS}${line}"$'\n'
  fi
done <<< "$(git -C "$ROOT" status --porcelain)"
if [ -n "$OTHERS" ]; then
  printf '%s' "$OTHERS" >&2
  die '工作区还有别的改动 —— 先提交或挪走它们（release 只接受「只有 CHANGELOG.md 改了」）'
fi
if [ "$CHANGELOG_DIRTY" = 1 ]; then
  note '工作区：只有 CHANGELOG.md 改了 → 下面会替你 commit + push'
else
  note '工作区干净 ✓'
fi

has_origin=0
if git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
  has_origin=1
  run git -C "$ROOT" fetch --quiet origin
  if [ "$(git -C "$ROOT" rev-parse --verify --quiet origin/main || printf '')" != "$(git -C "$ROOT" rev-parse HEAD)" ]; then
    die 'HEAD 与 origin/main 不一致 —— 先 pull / push，别在一个别人看不到的提交上打 tag'
  fi
  note '与 origin/main 同步 ✓'
  if git -C "$ROOT" ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    die "远端已经有 ${TAG} 这个 tag —— 换个号，或者先确认它是不是发过"
  fi
else
  note '⚠️ 没有 origin 远端 —— 跳过同步与重名检查（夹具模式）'
fi

if git -C "$ROOT" rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  die "本地已经有 ${TAG} 这个 tag"
fi
note 'tag 重名检查 ✓'

# ── 2. 这一版的说明在不在（**这个脚本存在的理由**）──────────────────────────
#
# ⚠️★ 这一步必须在**任何改动之前**（提交之前、推之前、打 tag 之前）：核对本身不碰任何东西，
#    失败了就整整齐齐地退出去，**不留一个半成品提交**、也不动远端一个字节。
head1 '2/6 这一版的说明在不在'
# ⚠️ `${TMPDIR}` 结尾通常带 `/`（macOS 就是），直接拼会得到 `T//clip9-notes…` ——
#    能跑，但每次打印命令时都在眼前晃。先去尾。
TMP_BASE="${TMPDIR:-/tmp}"
NOTES="$(mktemp "${TMP_BASE%/}/clip9-notes.XXXXXX")"
NOTES_ERR="$(mktemp "${TMP_BASE%/}/clip9-notes-err.XXXXXX")"
trap 'rm -f "$NOTES" "$NOTES_ERR"' EXIT

if ! "$NODE" "$ROOT/tools/release-notes.mjs" --tag "$TAG" >"$NOTES" 2>"$NOTES_ERR"; then
  cat >&2 <<EOF

✗ CHANGELOG.md 里没有 \`## ${TAG}\` 那一段（或者那一段还是占位）—— 发版前必须先写它。

  正文的唯一来源就是它：Release 页面上的说明由 tools/release-notes.mjs 从这里抽。
  写成什么样见 .github/RELEASE_TEMPLATE.md 第二节的骨架。
EOF
  # ⚠️ 把抽正文脚本**自己的说法**透出来：它分得清「没这一段」与「是占位」，
  #    而这两件事该怎么补是不一样的 —— 吞掉它只会让人来回试。
  if [ -s "$NOTES_ERR" ]; then
    printf '\n  抽正文的脚本说的是：\n'
    sed 's/^/    /' "$NOTES_ERR" >&2
  fi
  PREV="$(git -C "$ROOT" describe --tags --abbrev=0 HEAD 2>/dev/null || printf '')"
  if [ -n "$PREV" ]; then
    printf '\n  上一个 tag 是 %s，这一段里的提交是（写「这一版有什么」的原料）：\n\n' "$PREV"
    git -C "$ROOT" log --format='    %h  %s' --max-count=60 "${PREV}..HEAD" || true
  else
    printf '\n  从仓库开头到 HEAD 的提交是：\n\n'
    git -C "$ROOT" log --format='    %h  %s' --max-count=60 || true
  fi
  cat >&2 <<EOF

  写进 CHANGELOG.md 的**最上面**（按版本倒序），然后重跑本脚本 ——
  ⚠️ 工作区只允许「只有 CHANGELOG.md 改了」，脚本会替你 commit + push 那一处。

EOF
  exit 1
fi
note "$(printf '%s 行、%s 字节' "$(wc -l <"$NOTES" | tr -d ' ')" "$(wc -c <"$NOTES" | tr -d ' ')")"

# ── 3. 提交这一版的说明（这一步就是「先提交、再打 tag」里那个「先」）──────────
if [ "$CHANGELOG_DIRTY" = 1 ]; then
  head1 '3/6 提交这一版的说明'
  run git -C "$ROOT" add CHANGELOG.md
  run git -C "$ROOT" commit -m "docs(changelog): ${TAG}"
else
  head1 '3/6 提交这一版的说明（工作区已经干净，跳过）'
fi

# ── 4. 静态自检 ──────────────────────────────────────────────────────────────
head1 '4/6 静态自检'
if [ "$SKIP_GATES" = 1 ]; then
  note '⚠️ --skip-gates：跳过了（CI 会跑，但那时 tag 已经推出去了）'
elif [ "$DRY" = 1 ]; then
  for s in $GATES; do run "$NODE" "$ROOT/tools/${s}.mjs"; done
  run "$NODE" "$ROOT/tools/sync-web-assets.mjs" --check
else
  for s in $GATES; do
    if ! out="$("$NODE" "$ROOT/tools/${s}.mjs" 2>&1)"; then
      printf '%s\n' "$out"
      die "${s} 红了 —— 先修它，再发版"
    fi
    note "${s} ✓"
  done
  if ! out="$("$NODE" "$ROOT/tools/sync-web-assets.mjs" --check 2>&1)"; then
    printf '%s\n' "$out"
    die '入库的前端产物与当前源码不一致（sync-web-assets --check 红）'
  fi
  note 'sync-web-assets --check ✓'
fi

# ⚠️ 自检不许改工作区：改了说明有产物该提交（那正是「本次发布少了什么」的信号）。
if [ "$DRY" = 0 ] && [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  git -C "$ROOT" status --short >&2
  die '自检改动了工作区 —— 有产物没提交，先处理掉'
fi

# ── 5. 推上去 ────────────────────────────────────────────────────────────────
head1 '5/6 推 main 与 tag'
if [ "$has_origin" = 1 ] && [ "$CHANGELOG_DIRTY" = 1 ]; then
  run git -C "$ROOT" push origin main
fi
run git -C "$ROOT" tag "$TAG"
if [ "$has_origin" = 1 ]; then
  run git -C "$ROOT" push origin "$TAG"
fi

# ── 6. 建 Release（正文当场就是中文，没有空页面的窗口）──────────────────────
head1 '6/6 建 Release'
if [ "$DRY" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
  if [ ! -t 0 ]; then
    die '不在终端里 —— 要么加 --yes，要么在终端里跑'
  fi
  printf '  要建 %s 的 Release 吗？这一步会立刻触发 CI 开始传产物。[y/N] ' "$TAG"
  read -r ans || ans=''
  case "$ans" in
    y | Y | yes) ;;
    *) die '停下了（tag 已经推出去，CI 还没跑；确认后重跑本脚本会跳过已存在的 tag 检查……不，它会拒绝。手动 `gh release create` 即可）' ;;
  esac
fi

REL_ARGS=(release create "$TAG" --title "$TAG" --notes-file "$NOTES" --verify-tag)
# ⚠️ 刻意**不加** `--generate-notes`：那会拿自动生成的英文分类盖掉手写说明
#    （`release.yml` 的文件头写着这条）。
[ "$PRE" = 1 ] && REL_ARGS+=(--prerelease)
run "$GH" "${REL_ARGS[@]}"

printf '\n'
if [ "$DRY" = 1 ]; then
  printf '✓ dry-run 结束 —— 上面每一步都没真跑。\n'
  exit 0
fi

cat <<EOF
✓ 发出去了。接下来**自动**发生的事：

  · \`release: published\` 触发 release.yml：编 30 个包 → 传资产（几十个 job，十几分钟）；
  · \`release-notes\` job 会再抽一次正文（现在 tag 里有那一段，一次就绿）；
  · \`record-version\` job 往 main 上推一条 \`chore(release): ${TAG}\` 的**空**提交。

看进度：  gh run list --repo "\$(gh repo view --json nameWithOwner -q .nameWithOwner)" --limit 3

⚠️ 真发错了要撤（**趁早**，CI 已经开始在传资产了）：

  gh release delete ${TAG} --yes --cleanup-tag
  git tag -d ${TAG}                     # 本地那份
  # ⚠️ \`record-version\` 可能已经往 main 推过一条空提交 —— 那条不用管，它不指向任何东西。
EOF
