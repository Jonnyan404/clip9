/**
 * 「发一条文本」这条路的**唯一**实现。
 *
 * ⚠️★ 为什么要有这个文件：这条 POST 原来在两个 composer 里各写了一份
 * （`UnifiedComposer.vue` 与 `sticky/StickyComposer.vue`），而两份**长得不一样** ——
 * 便签那份带了 `?client=`，标准模式那份没带。于是「照着界面发一条文本」这件事
 * 在两种模式下并不等价，`window.clip9Share.sendText`（外壳分享进来的那条路）
 * 也就无从「和界面一致」。
 *
 * ⚠️★ `?client=` **必须带** —— 服务端 `handlers.rs` 的 `sender_base` 注释写得很清楚：
 * 「设备名来自 `?name=`…；客户端 ID 来自 `?client=`，用于**气泡收发归属**
 * （判断哪条是我自己发的）」。缺了它，服务端存下来的 `sender_client_id` 是空串，
 * 前端就永远分不出「我发的」。
 * ⚠️ 这里**只补上了漏掉的那个参数，没有别的行为变化**：服务端目前对 `sender_client_id`
 * 只做**存储与下发**，不做「不回显给发送者」之类的过滤（核过：全仓库只有
 * `desktop/src/model.rs` 读它来算 `mine`），所以补上它不可能改变「消息送没送到」。
 *
 * ⚠️ 别在这里加 `try/catch` 把它变成 `{ok:false}`：调用方（两个 composer、分享桥）
 * 对失败的**表达方式**不一样 —— composer 要弹 toast，分享桥要回 reason 给外壳。
 * 让异常往上穿，由各自的调用点决定怎么说。
 */
import axios from 'axios';
import { getClientId } from '@/util.js';

/**
 * 把一段文本发进某个房间。
 *
 * ⚠️ 走的是**相对路径** `text`（不带前导斜杠）：`main.js` 给 axios 设过绝对 baseURL
 * （= 外壳的基准目录，见 `base.js`），带前导斜杠会绕过它、在子路径部署下 404。
 *
 * @param {object} options
 * @param {string} options.room 房间名（`ws.room`，已归一化过的那份）
 * @param {string} options.text 正文原样发送 —— ⚠️ **不 trim**，与界面里点发送完全一致
 * @param {string} [options.client] 客户端 ID，默认本机那个（见文件头）
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export function postText({ room, text, client = getClientId() }) {
    return axios.post('text', text, {
        params: new URLSearchParams([['room', room], ['client', client]]),
        headers: {
            'Content-Type': 'text/plain',
        },
    });
}
