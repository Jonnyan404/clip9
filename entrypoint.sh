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
        "roomCleanup": 3600
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

# ⚠️ `dbPath` / `storageDir` 写的是**相对路径**，它们相对 `-data` 解析（不是相对 cwd）——
# 所以下面那个 `-data` 是必须的：库落在 <data>/clip9.redb、上传落在 <data>/uploads。
#
# ⚠️ 用 `exec` 换掉这个 shell（少一个进程、退出码也直接传出去）。**但它解决不了停机慢**：
# PID 1 对没有处理函数的信号是**内核直接忽略**的，而服务端这边没有装 SIGTERM 处理器 ——
# 实测 `docker stop` 不加 `--init` 要**整整 10 秒**（等超时后被 SIGKILL），加了 `--init`
# 是 **0.22 秒**（tini 转发信号）。所以 compose 里写了 `init: true`，`docker run` 要加 `--init`。
cd /app/server-node
exec ./clip9-cli -config "${CONFIG_FILE}" -data "${DATA_DIR}"
