/**
 * 外壳 → SPA 的入口（`window.clip9Share`）。
 *
 * 契约、取舍与「为什么 `sendFiles` 还没做」都在 `docs/specs/android-client.md` §4。
 * ⚠️★ 这是**跨端契约**：下面那三个方法名与 [SHARE_REASONS] 里的键，
 * **另一侧（Android/Kotlin）是按字面量用的** —— 那边没有编译器替我们检查，
 * 对不上的症状是「什么都没发生」（`undefined is not a function` 会被 WebView 吞掉）。
 * 所以 `tools/share-bridge-smoke.mjs` 逐字对这两处；改名字要一起改它和 Android 侧。
 *
 * ⚠️★ 为什么不让外壳直接调 REST（`POST /text`）：那需要外壳自己持有地址与凭据，
 * 等于把「登录态」实现两遍 —— SPA 那份在 `sessionStorage['roomAuthCache']`，
 * 它是契约（见项目笔记）。走这个桥，鉴权这件事只有一处。
 */
import { postText } from '@/send.js';
import { errorMessage } from '@/util.js';
import { useWebSocketStore } from '@/store/websocket';
import router from '@/router';

/**
 * 失败原因的**稳定键**（机器读的，不是给人看的句子）。
 *
 * ⚠️★ 故意回键而不是译文：外壳要把原因显示出来，而译文只有 SPA 这边有
 * （`locales/{zh,zh-TW,en,ja}.json`）。回句子就等于把译文复制进 App 的 `strings.xml`，
 * 两份一定会漂。外壳拿键去查自己的那一份。
 * ⚠️ 外壳**遇到不认识的键要把它原样显示出来**（不要静默成一句「发送失败」）——
 * 那样以后加键时至少看得见。
 */
export const SHARE_REASONS = Object.freeze({
    /** 页面还没连上服务端（WS 还没连上），现在投递会丢。 */
    NOT_READY: 'not-ready',
    /** 连上了但还没选房间（分享页 `/s/<token>` 就是这个状态）。 */
    NO_ROOM: 'no-room',
    /** 分享过来的是空文本。 */
    EMPTY: 'empty',
    /** 分享文件那条路**还没做**（见 §4），回一个明确的理由而不是静默失败。 */
    FILES_UNSUPPORTED: 'files-unsupported',
    /** 服务端拒了。`message` 里带它的原话（已按界面语言给好）。 */
    SERVER_ERROR: 'server-error',
});

/**
 * 把桥挂到 `window.clip9Share` 上，并把对象返回（方便调试与测试）。
 *
 * ⚠️ 必须在 `app.use(pinia)` **之后**调 —— 里面要用 pinia store。
 * ⚠️ 分享页（`/s/<token>`）**也照挂**：那里 `room` 是空的，`sendText` 会老实回
 * `no-room`。比「对象不存在」好排查得多（后者在 WebView 里只有一句看不见的
 * `undefined is not a function`）。
 *
 * @returns {{ isReady: () => boolean, sendText: (text: string) => Promise<object>, sendFiles: (files: unknown) => Promise<object> }}
 */
export function installShareBridge() {
    const ws = useWebSocketStore();

    const bridge = {
        /**
         * 页面准备好了没有。
         *
         * ⚠️★ `onPageFinished` **不代表**这个为真：Vue 挂载、WS 连上都在它之后。
         * 外壳必须**轮询到这里为真**再投递，否则分享过来那一瞬间内容就丢了。
         *
         * ⚠️★ **只看 WS 在不在** —— `ws.room` 是**空串**的时候表示「公共房间」（default），
         * 那是**合法状态**，不能当「没选房间」。原来的
         * `Boolean(ws.websocket && ws.room)` 在公共房间里**永远是 false**，
         * 于是冷启动分享的 20 秒就绪探测必超时、分享必丢
         * （2026-09-30 真机验收抓到，§7-6）。判据改成与「输入框可不可用」同源：
         * WS 连着 = 房间有效 —— 分享页不建 WS（`main.js` 对 sharePage 不 connect），
         * 所以「WS 在」就蕴含「在正主页面的某个房间里」。
         */
        isReady() {
            return Boolean(ws.websocket);
        },

        /**
         * 发一段文本，等价于「在界面里粘贴一段文本然后点发送」。
         *
         * @param {string} text
         * @returns {Promise<{ok: true} | {ok: false, reason: string, message?: string}>}
         */
        async sendText(text) {
            const body = typeof text === 'string' ? text : '';
            // ⚠️ 空判断与输入框一致（`!app.send.text`）：**不 trim**，
            // 那样「只发了几个空格」这种在两边是同一个结果。
            if (!body) {
                return { ok: false, reason: SHARE_REASONS.EMPTY };
            }
            // ⚠️★ 「没选房间」的判据是**分享页**，不是「room 为空」——
            //    空串 = 公共房间（上面的 isReady 注释）。分享页不建 WS，
            //    本来也发不出去，这里先给它一个说得清的理由。
            if (router.currentRoute.value.meta?.sharePage) {
                return { ok: false, reason: SHARE_REASONS.NO_ROOM };
            }
            if (!ws.websocket) {
                return { ok: false, reason: SHARE_REASONS.NOT_READY };
            }
            try {
                // ⚠️ 这里**不**自己判 `app.config.text.limit`：那条上限由服务端裁决，
                // 超了会回一句明确的错，`message` 直接带给用户。再抄一份等于把
                // 「上限是多少」变成两处定义（项目里已有过三次「配了不生效」）。
                // ⚠️ `room: ws.room` 在公共房间里是**空串**——与三个 composer
                // （UnifiedComposer / StickyComposer / BenchWall）传的**同一个值**，
                // 服务端把空 room 归一成 default。别在这里补 `|| 'default'`：
                // 那会变成第二处定义「空串是什么意思」。
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
         *
         * 为什么不是「把 uri 传进来就行」：WebView 里拿不到文件系统的路径，
         * 而 SPA 的上传路径要的是真正的 `File`（`formData.set('file', file)`、
         * `file.slice(...)`）。壳与页面之间唯一的通道是**字符串**，所以文件得由外壳
         * 读成字节再以 base64（或换更现代的通道）递进来。这条路怎么走还没定，
         * 候选与取舍记在 `docs/specs/android-client.md` §4。
         */
        async sendFiles() {
            return { ok: false, reason: SHARE_REASONS.FILES_UNSUPPORTED };
        },
    };

    window.clip9Share = bridge;
    return bridge;
}
