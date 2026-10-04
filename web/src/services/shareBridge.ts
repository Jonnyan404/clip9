/**
 * 外壳 → SPA 的入口（`window.clip9Share`）—— 从 web-vue3/src/share.js 移植。
 *
 * ⚠️★ 这是**跨端契约**：下面那三个方法名与 [SHARE_REASONS] 里的键，
 * **另一侧（Android/Kotlin）是按字面量用的** —— 那边没有编译器替我们检查，
 * 对不上的症状是「什么都没发生」（`undefined is not a function` 会被 WebView 吞掉）。
 * 所以 `tools/share-bridge-smoke.mjs` 逐字对这两处；改名字要一起改它和 Android 侧。
 *
 * ⚠️★ 为什么不让外壳直接调 REST（`POST /text`）：那需要外壳自己持有地址与凭据，
 * 等于把「登录态」实现两遍。走这个桥，鉴权这件事只有一处。
 */
import { postText } from '@/services/send';
import { errorMessage } from '@/lib/util';
import { useWebSocketStore } from '@/stores/wsStore';
import { isShareRoute } from '@/router';

/**
 * 失败原因的**稳定键**（机器读的，不是给人看的句子）。
 * ⚠️★ 故意回键而不是译文：外壳要把原因显示出来，而译文只有 SPA 这边有。
 */
export const SHARE_REASONS = Object.freeze({
    /** 页面还没连上服务端（WS 还没连上），现在投递会丢。 */
    NOT_READY: 'not-ready',
    /** 连上了但还没选房间（分享页 `/s/<token>` 就是这个状态）。 */
    NO_ROOM: 'no-room',
    /** 分享过来的是空文本。 */
    EMPTY: 'empty',
    /** 分享文件那条路**还没做**，回一个明确的理由而不是静默失败。 */
    FILES_UNSUPPORTED: 'files-unsupported',
    /** 服务端拒了。`message` 里带它的原话（已按界面语言给好）。 */
    SERVER_ERROR: 'server-error',
});

export type ShareResult = { ok: true } | { ok: false; reason: string; message?: string };

export interface Clip9ShareBridge {
    isReady: () => boolean;
    sendText: (text: unknown) => Promise<ShareResult>;
    sendFiles: (files?: unknown) => Promise<ShareResult>;
}

/**
 * 把桥挂到 `window.clip9Share` 上，并把对象返回（方便调试与测试）。
 *
 * ⚠️ 必须在 store 可用之后调。
 * ⚠️ 分享页（`/s/<token>`）**也照挂**：那里 `room` 是空的，`sendText` 会老实回 `no-room`。
 */
export function installShareBridge(): Clip9ShareBridge {
    const bridge: Clip9ShareBridge = {
        /**
         * 页面准备好了没有。
         * ⚠️★ **只看 WS 在不在** —— `ws.room` 是**空串**的时候表示「公共房间」（default），
         * 那是**合法状态**，不能当「没选房间」。
         */
        isReady() {
            return Boolean(useWebSocketStore.getState().websocket);
        },

        async sendText(text: unknown) {
            const body = typeof text === 'string' ? text : '';
            // ⚠️ 空判断与输入框一致（`!app.send.text`）：**不 trim**。
            if (!body) {
                return { ok: false, reason: SHARE_REASONS.EMPTY };
            }
            // ⚠️★ 「没选房间」的判据是**分享页**，不是「room 为空」—— 空串 = 公共房间。
            if (isShareRoute()) {
                return { ok: false, reason: SHARE_REASONS.NO_ROOM };
            }
            const ws = useWebSocketStore.getState();
            if (!ws.websocket) {
                return { ok: false, reason: SHARE_REASONS.NOT_READY };
            }
            try {
                // ⚠️ 不自己判 `app.config.text.limit`：那条上限由服务端裁决，超了会回明确错误。
                // ⚠️ `room: ws.room` 在公共房间里是**空串** —— 与三个 composer 传的同一个值。
                await postText({ room: ws.room, text: body });
                return { ok: true };
            } catch (error) {
                return {
                    ok: false,
                    reason: SHARE_REASONS.SERVER_ERROR,
                    message: errorMessage(error),
                };
            }
        },

        /**
         * 发文件。⚠️★ **还没做** —— 回一个明确的理由，别静默失败。
         * WebView 里拿不到文件系统路径，而 SPA 的上传路径要的是真正的 `File`；
         * 壳与页面之间唯一的通道是**字符串**。这条路怎么走还没定。
         */
        async sendFiles() {
            return { ok: false, reason: SHARE_REASONS.FILES_UNSUPPORTED };
        },
    };

    (window as unknown as { clip9Share: Clip9ShareBridge }).clip9Share = bridge;
    return bridge;
}
