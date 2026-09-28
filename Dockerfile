# syntax=docker/dockerfile:1

# 直接下载 GitHub Release 中已构建好的静态二进制（已内嵌前端静态资源），
# 不再在镜像内编译前端/后端，大幅加快镜像生成。
# 需要 build-arg: VERSION  (例如 v0.1.0-beta1)；
# TARGETARCH / TARGETVARIANT 由 docker buildx 自动注入。
#
# ⚠️★ 构建 context 是**仓库根**：`docker build --build-arg VERSION=vX -t clip9 .`
# 根上那份 `.dockerignore` 把 `rust/target`（GB 级）与各 `node_modules` 都排掉了 ——
# 别删它，否则每次构建都要把几百 MB 送到 builder。
#
# 与 cloud-clipboard-go 的 `cloud-clip/Dockerfile` 是同一套做法、同一批依赖，
# 只有配置字段不同（这边历史存 redb：`dbPath` + `storageDir`，没有 Go 的
# `historyFile` / `uds`）—— 见 `entrypoint.sh`。

FROM alpine:latest

ARG VERSION
ARG TARGETARCH
ARG TARGETVARIANT

# 运行时依赖（与 Go 镜像一致）
RUN apk add --no-cache ca-certificates netcat-openbsd git tzdata \
    && apk add --repository=https://dl-cdn.alpinelinux.org/alpine/edge/testing mkcert

WORKDIR /app/server-node

COPY entrypoint.sh /app/entrypoint.sh

# 按平台映射 Release 归档名并解压出二进制。
# ⚠️ armv7 时 TARGETARCH=arm 且 TARGETVARIANT=v7 —— **两个都要看**，只看 arch 会把
# 32 位设备喂给 64 位的包。
# ⚠️ 包里的二进制在 `clip9-cli-<triple>/` 下（发布时就这么打的），所以解到 /tmp 再搬到
# 目标位置；不用 `--strip-components`（busybox 的 tar 没有这个 GNU 选项）。
# 末尾那下 `-v` 是**构建期**的核对：跑不起来（架构不对 / 不是静态）就当场编不出来，
# 而不是等容器起来了才发现。
RUN chmod +x /app/entrypoint.sh \
 && case "${TARGETARCH}-${TARGETVARIANT}" in \
      amd64-*) B="x86_64-unknown-linux-musl";; \
      arm64-*) B="aarch64-unknown-linux-musl";; \
      arm-v7)  B="armv7-unknown-linux-musleabihf";; \
      *) echo "不支持的平台: ${TARGETARCH}-${TARGETVARIANT}"; exit 1;; \
    esac \
 && wget -q -O - "https://github.com/Jonnyan404/clip9/releases/download/${VERSION}/clip9-cli-${B}.tar.gz" \
      | tar -xz -C /tmp "clip9-cli-${B}/clip9-cli" \
 && mv "/tmp/clip9-cli-${B}/clip9-cli" /app/server-node/clip9-cli \
 && rm -rf "/tmp/clip9-cli-${B}" \
 && chmod +x /app/server-node/clip9-cli \
 && /app/server-node/clip9-cli -v

# 暴露端口
EXPOSE 9501

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=10s \
    CMD nc -z 127.0.0.1 "${LISTEN_PORT:-9501}" || exit 1

# 运行应用
ENTRYPOINT ["/app/entrypoint.sh"]
