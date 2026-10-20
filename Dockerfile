# syntax=docker/dockerfile:1

# 直接下载 GitHub Release 中已构建好的静态二进制（已内嵌前端静态资源），
# 不再在镜像内编译前端/后端，大幅加快镜像生成。
# 需要 build-arg: VERSION  (例如 v0.1.0-beta1)；
# TARGETARCH / TARGETVARIANT 由 docker buildx 自动注入。
#
# ⚠️★ 两个变体，同一个 Dockerfile（`NOUI=1` 切到「不带界面」的那份产物）：
#
#   · 缺省（`NOUI=0`）→ `clip9-cli-<tag>-<平台>.tar.gz`：**内嵌前端**，开箱即用。
#   · `NOUI=1`        → `clip9-cli-noui-<tag>-<平台>.tar.gz`：**没有内嵌前端**，
#     `/` 上是一页「这个二进制没带界面」的说明。给**前后端分离部署**用
#     （前端放 CDN / 静态托管，容器只当 API）。
#
# ⚠️ 两个变体只是**换下载哪个产物**，装进去以后**都叫** `/app/server-node/clip9-cli` ——
#    `entrypoint.sh` 与 HEALTHCHECK 认的就是这个名字，改它要一起改。
#
# ⚠️★ 构建 context 是**仓库根**：`docker build --build-arg VERSION=vX -t clip9 .`
# 根上那份 `.dockerignore` 把 `rust/target`（GB 级）与各 `node_modules` 都排掉了 ——
# 别删它，否则每次构建都要把几百 MB 送到 builder。

FROM alpine:latest

ARG VERSION
ARG TARGETARCH
ARG TARGETVARIANT
# `1` = 不带内嵌界面（前后端分离部署）。⚠️ 缺省 0 与改动前一致。
ARG NOUI=0

LABEL org.opencontainers.image.title="clip9" \
      clip9.noui="${NOUI}"

# 运行时依赖（与 Go 镜像一致）
RUN apk add --no-cache ca-certificates netcat-openbsd git tzdata \
    && apk add --repository=https://dl-cdn.alpinelinux.org/alpine/edge/testing mkcert

WORKDIR /app/server-node

COPY entrypoint.sh /app/entrypoint.sh

# 按平台映射 Release 归档名并解压出二进制。
# ⚠️★ 映射出来的是**产物名里那个短标签**（`linux-x86_64` 那种），**不是** cargo 的
# 三元组 —— 发布出去的文件名就是 `<平台>-<架构>`（见 release.yml 的产物清单）。
# ⚠️ armv7 时 TARGETARCH=arm 且 TARGETVARIANT=v7 —— **两个都要看**，只看 arch 会把
# 32 位设备喂给 64 位的包。
# ⚠️ 包里的二进制在 `clip9-cli-v<版本>-<平台>-<架构>/` 下（发布时就这么打的 ——
# 那个顶层目录名**与归档文件名同名**，所以 `VERSION` 一变这里也要跟着变），
# 所以解到 /tmp 再搬到目标位置；不用 `--strip-components`（busybox 的 tar 没有这个 GNU 选项）。
# 末尾那下 `-v` 是**构建期**的核对：跑不起来（架构不对 / 不是静态）就当场编不出来，
# 而不是等容器起来了才发现。
RUN chmod +x /app/entrypoint.sh \
 && case "${TARGETARCH}-${TARGETVARIANT}" in \
      amd64-*) B="linux-x86_64";; \
      arm64-*) B="linux-aarch64";; \
      arm-v7)  B="linux-armv7";; \
      *) echo "不支持的平台: ${TARGETARCH}-${TARGETVARIANT}"; exit 1;; \
    esac \
 && if [ "$NOUI" = "1" ]; then PKG="clip9-cli-noui"; else PKG="clip9-cli"; fi \
 && wget -q -O - "https://github.com/Jonnyan404/clip9/releases/download/${VERSION}/${PKG}-${VERSION}-${B}.tar.gz" \
      | tar -xz -C /tmp "${PKG}-${VERSION}-${B}/${PKG}" \
 && mv "/tmp/${PKG}-${VERSION}-${B}/${PKG}" /app/server-node/clip9-cli \
 && rm -rf "/tmp/${PKG}-${VERSION}-${B}" \
 && chmod +x /app/server-node/clip9-cli \
 && /app/server-node/clip9-cli -v

# 暴露端口
EXPOSE 9501

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=10s \
    CMD nc -z 127.0.0.1 "${LISTEN_PORT:-9501}" || exit 1

# 运行应用
ENTRYPOINT ["/app/entrypoint.sh"]
