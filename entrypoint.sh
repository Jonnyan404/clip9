#!/bin/sh
# 容器入口：把环境变量变成一份 config.json，再跑服务端。
#
# ⚠️★ 环境变量名与 cloud-clipboard-go 那边**完全一致**（LISTEN_PORT / AUTH_PASSWORD /
# ROOM_AUTH_JSON / MKCERT_DOMAIN_OR_IP …），所以从 Go 版切过来只需要换 image，
# compose 里那些变量不用改。差别只在**生成的配置字段**：这边历史存 redb
# （`dbPath` + `storageDir`），没有 Go 的 `historyFile` / `uds`。
#
# ⚠️★ 生成的 JSON 里**不许有注释**：Go 版的 config.json 是带 `#` 注释的，而 clip9 这边是
# `serde_json::from_str` 严格解析，**解析失败直接退出**（刻意与 Go 不同 —— Go 会打一行日志
# 然后用默认值继续跑，那意味着一个拼错的配置会让服务**不带密码**地起来）。
# 所以解释一律写在这个 shell 文件里，别写进 heredoc。
#
# ⚠️ 已经存在 config.json 时**一个字都不动**（与 Go 一致）：想让它重新生成就删掉那个文件。

CONFIG_FILE='/app/server-node/config.json'
DATA_DIR='/app/server-node/data'
DOMAIN_RECORD_FILE="${DATA_DIR}/domain_record.txt"
ROOM_AUTH_JSON_VALUE="${ROOM_AUTH_JSON:-${ROOM_AUTH:-}}"
AUTH_JSON_VALUE="${AUTH_PASSWORD:-false}"

# mkcert 会把证书写到数据目录里，而数据目录这时候可能还不存在（没挂卷时就是）。
mkdir -p "${DATA_DIR}"

# --- 配置写在哪：镜像里那个目录**归 root** -------------------------------------
#
# ⚠️★ 容器可以以非 root 跑（NAS 上的 PUID/PGID 映射、fnOS 的 fpk 用 `run-as: package`），
#    而 `/app/server-node` 是 root 的 755 —— 那时下面那个 `cat > config.json` 会
#    `Permission denied`，**而 shell 的重定向失败不会中止脚本**：
#    服务端拿**默认配置**起来，密码 / 限额 / TLS / 跨源**一条都没生效**，
#    日志里只有一行 shell 报错（2026-10-28 实测：`--user 1000:1000` 下 `/server` 报
#    `auth: false`，而环境里明明给了 AUTH_PASSWORD）。
#    这正是项目那条「失败可降级，但绝不静默丢」要挡的东西 —— 所以这里先探一下：
#    写不进去就落到**数据目录**（挂载卷，通常可写），并且明说一句。
if [ ! -w "$(dirname "${CONFIG_FILE}")" ]; then
    echo "注意：/app/server-node 不可写（容器不是 root 跑的），配置改写到 ${DATA_DIR}/config.json" >&2
    CONFIG_FILE="${DATA_DIR}/config.json"
fi

if [ -z "${ROOM_AUTH_JSON_VALUE}" ]; then
    ROOM_AUTH_JSON_VALUE='{}'
fi

case "${AUTH_JSON_VALUE}" in
    "" )
        AUTH_JSON_VALUE='false'
        ;;
    false|true|null)
        ;;
    *)
        AUTH_ESCAPED_VALUE=$(printf '%s' "${AUTH_JSON_VALUE}" | sed 's/\\/\\\\/g; s/"/\\"/g')
        AUTH_JSON_VALUE="\"${AUTH_ESCAPED_VALUE}\""
        ;;
esac

# --- 跨源来源白名单：前后端分离部署时，前端所在的那个 origin ------------------
#
# ⚠️★ `ALLOW_ORIGINS="https://clip.example.com,https://cdn.example.org"` →
#    `"allowOrigins": ["https://clip.example.com","https://cdn.example.org"]`。
#    不设 = `[]`（只放行内置那三类：桌面壳与本机回环）。
#
# ⚠️ 服务端会**再校验一次**（`clip9_core::config::normalize_origin`）：写法歪的条目在启动
#    日志里是一条 warn（被忽略、其余照常生效），**不会**让容器起不来。刻意的 ——
#    一条手滑不该把整台服务挡在门外。所以「配了但前端还是被 CORS 拦」时，先看那行 warn。
#
# ⚠️ 用 `tr , 空格` 再 `for` 拆：busybox 的 `read -a` 不保证有，而 `$(...)` 里的拆词是
#    POSIX 的基础行为。来源里不会出现空格（服务端也不接受）。
build_allow_origins_json() {
    _out=''
    for _origin in $(printf '%s' "$1" | tr ',' ' '); do
        _escaped=$(printf '%s' "${_origin}" | sed 's/\\/\\\\/g; s/"/\\"/g')
        if [ -z "${_out}" ]; then
            _out="\"${_escaped}\""
        else
            _out="${_out},\"${_escaped}\""
        fi
    done
    if [ -z "${_out}" ]; then
        printf '[]'
    else
        printf '[%s]' "${_out}"
    fi
}
ALLOW_ORIGINS_JSON=$(build_allow_origins_json "${ALLOW_ORIGINS:-}")

# --- SSL：优先级与 Go 版逐条一致：手动路径 > mkcert > 不启用 ---
KEY=""
CERT=""

# 1. 手动指定的证书路径（优先级最高）
if [ -n "${MANUAL_KEY_PATH}" ] && [ -n "${MANUAL_CERT_PATH}" ]; then
    echo "Manual SSL paths provided: KEY='${MANUAL_KEY_PATH}', CERT='${MANUAL_CERT_PATH}'"
    if [ -f "${MANUAL_KEY_PATH}" ] && [ -f "${MANUAL_CERT_PATH}" ]; then
        KEY="${MANUAL_KEY_PATH}"
        CERT="${MANUAL_CERT_PATH}"
        echo "Using manually specified SSL certificate files."
    else
        echo "Warning: Manual SSL paths specified, but files not found at '${MANUAL_KEY_PATH}' or '${MANUAL_CERT_PATH}'. SSL will be disabled." >&2
    fi

# 2. 用 mkcert 生成（域名/IP 变了就重新生成）
elif [ -n "${MKCERT_DOMAIN_OR_IP}" ]; then
    echo "MKCERT_DOMAIN_OR_IP is set ('${MKCERT_DOMAIN_OR_IP}'). Managing certificates via mkcert..."
    MKCERT_KEY_PATH="${DATA_DIR}/key.pem"
    MKCERT_CERT_PATH="${DATA_DIR}/cert.pem"
    CURRENT_DOMAIN=${MKCERT_DOMAIN_OR_IP}

    REGENERATE_CERT=false
    if [ ! -f "$MKCERT_KEY_PATH" ] || [ ! -f "$MKCERT_CERT_PATH" ]; then
        echo "mkcert SSL certificates not found. Will generate new ones."
        REGENERATE_CERT=true
    elif [ ! -f "$DOMAIN_RECORD_FILE" ]; then
        echo "Domain record file not found. Will generate new certificates."
        REGENERATE_CERT=true
    else
        PREVIOUS_DOMAIN="$(cat "$DOMAIN_RECORD_FILE")"
        if [ "$CURRENT_DOMAIN" != "$PREVIOUS_DOMAIN" ]; then
            echo "Domain/IP changed from '$PREVIOUS_DOMAIN' to '$CURRENT_DOMAIN'. Will generate new certificates."
            REGENERATE_CERT=true
        else
            echo "Domain/IP unchanged. Using existing mkcert certificates."
        fi
    fi
    if [ "$REGENERATE_CERT" = true ]; then
        echo "##### Generating SSL certificate via mkcert #####"
        echo "##### Domain/IP: ${CURRENT_DOMAIN} #####"
        # ⚠️ 域名要按空格拆开分别传给 mkcert，所以这里**不加引号**（与 Go 一致）。
        mkcert -key-file "$MKCERT_KEY_PATH" -cert-file "$MKCERT_CERT_PATH" $CURRENT_DOMAIN
        if [ $? -ne 0 ]; then
            echo "Error: Failed to generate SSL certificates with mkcert." >&2
            exit 1
        fi
        printf "%s" "$CURRENT_DOMAIN" > "$DOMAIN_RECORD_FILE"
        echo "mkcert certificates generated successfully."
    fi
    KEY="$MKCERT_KEY_PATH"
    CERT="$MKCERT_CERT_PATH"

# 3. 都没给 → 不起 TLS（cert 与 key 都留空）
else
    echo "Neither manual SSL paths nor MKCERT_DOMAIN_OR_IP are set. SSL is disabled."
fi

if [ ! -f $CONFIG_FILE ]; then
echo "#####Generating configuration file#####"
cat>"${CONFIG_FILE}"<<EOF
{
    "server": {
        "host": [
            "${LISTEN_IP:-0.0.0.0}",
            "${LISTEN_IP6}"
        ],
        "port": ${LISTEN_PORT:-9501},
        "prefix": "${PREFIX}",
        "cert": "${CERT}",
        "key": "${KEY}",
        "history": ${MESSAGE_NUM:-50},
        "auth": ${AUTH_JSON_VALUE},
        "roomAuth": ${ROOM_AUTH_JSON_VALUE},
        "dbPath": "clip9.redb",
        "storageDir": "uploads",
        "roomList": ${ROOM_LIST:-false},
        "roomCleanup": 3600,
        "allowOrigins": ${ALLOW_ORIGINS_JSON}
    },
    "text": {
        "limit": ${TEXT_LIMIT:-4096}
    },
    "file": {
        "expire": ${FILE_EXPIRE:-3600},
        "chunk": 1048576,
        "limit": ${FILE_LIMIT:-104857600}
    },
    "automation": {
        "enabled": ${AUTOMATION_ENABLED:-true},
        "tickSeconds": 30,
        "graceSeconds": 600,
        "defaultTZ": "${DEFAULT_TZ:-Asia/Shanghai}"
    }
}
EOF
else
    echo "#####Configuration file already exists#####"
fi

# ⚠️★ 上面那段是**重定向**，失败时 shell 只打一行错、脚本继续往下跑。所以这里收一次口：
#    配置没落盘就**不启动**。带密码的部署「起来了、但没密码」比起不来危险得多。
if [ ! -f "${CONFIG_FILE}" ]; then
    echo "错误：没能写出配置文件 ${CONFIG_FILE}" >&2
    echo "      （数据目录不可写？挂载点要允许容器内的用户写入）" >&2
    echo "      环境变量（密码 / 限额 / TLS）都不会生效，因此不启动。" >&2
    exit 1
fi

# ⚠️ `dbPath` / `storageDir` 写的是**相对路径**，它们相对 `-data` 解析（不是相对 cwd）——
# 所以下面那个 `-data` 是必须的：库落在 <data>/clip9.redb、上传落在 <data>/uploads。
#
# ⚠️ 用 `exec` 换掉这个 shell（少一个进程、退出码也直接传出去）。**但它解决不了停机慢**：
# PID 1 对没有处理函数的信号是**内核直接忽略**的，而服务端这边没有装 SIGTERM 处理器 ——
# 实测 `docker stop` 不加 `--init` 要**整整 10 秒**（等超时后被 SIGKILL），加了 `--init`
# 是 **0.22 秒**（tini 转发信号）。所以 compose 里写了 `init: true`，`docker run` 要加 `--init`。
cd /app/server-node
exec ./clip9-cli -config "${CONFIG_FILE}" -data "${DATA_DIR}"
