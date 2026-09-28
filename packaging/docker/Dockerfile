# syntax=docker/dockerfile:1

# clip9 服务端镜像。
#
# ⚠️★ 镜像里**不编译任何东西**：二进制从 GitHub Release 直接下（buildx 一次调用就出多平台，
# 每个平台在各自的容器里下载自己那一份）。所以这个文件只在「要发的那个 tag 已经存在」时才有用。
#
# 构建（context 就指到这个目录 —— 镜像不需要仓库里的任何文件，别把整个仓库当 context 发过去）：
#   docker build --build-arg VERSION=v0.1.0-beta1 -t clip9 .
#
# ⚠️ 服务端是**静态链接的 musl 二进制**，前端产物已 `include_bytes!` 编在里面 ——
# 所以运行时不需要任何库，基础镜像只用来提供 ca-certificates 与 tzdata。

FROM alpine:latest

ARG VERSION
ARG TARGETARCH
ARG TARGETVARIANT

RUN apk add --no-cache ca-certificates tzdata

# 平台变量 → Release 归档名。
# ⚠️ armv7 时 TARGETARCH=arm 且 TARGETVARIANT=v7，**两个都要看**（只看 arch 会把 32 位
# 设备喂给 64 位的包）。
RUN set -eux; \
    case "${TARGETARCH}-${TARGETVARIANT}" in \
      amd64-*) triple=x86_64-unknown-linux-musl ;; \
      arm64-*) triple=aarch64-unknown-linux-musl ;; \
      arm-v7)  triple=armv7-unknown-linux-musleabihf ;; \
      *) echo "不支持的平台: ${TARGETARCH}/${TARGETVARIANT}" >&2; exit 1 ;; \
    esac; \
    [ -n "${VERSION}" ] || { echo "缺少 build-arg VERSION" >&2; exit 1; }; \
    name="clip9-cli-${triple}"; \
    wget -q -O /tmp/clip9.tar.gz \
      "https://github.com/Jonnyan404/clip9/releases/download/${VERSION}/${name}.tar.gz"; \
    tar -xz -C /tmp -f /tmp/clip9.tar.gz "${name}/clip9-cli"; \
    install -m 0755 "/tmp/${name}/clip9-cli" /usr/local/bin/clip9-cli; \
    rm -rf /tmp/clip9.tar.gz "/tmp/${name}"; \
    clip9-cli -v

# 数据目录：redb 库与 uploads/ 都在这里（`-data` 一个参数同时管这两样）。
# ⚠️ 不挂卷的话容器一删，房间与上传的文件全没。
VOLUME /data

# ⚠️ 服务端**认环境变量**（`CLIP9_` + 参数名大写，命令行优先）—— 所以这里不用包一层
# entrypoint 脚本。要改端口/密码就 `-e CLIP9_PORT=… -e CLIP9_AUTH=…`。
ENV CLIP9_DATA=/data \
    CLIP9_HOST=0.0.0.0 \
    CLIP9_PORT=9501

EXPOSE 9501

# ⚠️ 探的是**端口**不是 HTTP：`/` 要不要发外壳由 `Accept` 头决定（见 `static_files.rs` 的
# `wants_html`），一个不带头的探测会拿到 404 —— 那会变成看不懂的「容器一直 unhealthy」。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD nc -z 127.0.0.1 "${CLIP9_PORT}" || exit 1

ENTRYPOINT ["clip9-cli"]
