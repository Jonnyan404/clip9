/**
 * 「发一条文本」这条路的**唯一**实现 —— 从 web-vue3/src/send.js 移植。
 *
 * ⚠️★ 这条 POST 原来在两个 composer 里各写了一份，而两份**长得不一样**（一份漏了 `?client=`）。
 * 于是「照着界面发一条文本」这件事在两种模式下并不等价。抽取之后只有一个实现。
 *
 * ⚠️★ `?client=` **必须带** —— 服务端用它算「哪条是我自己发的」。缺了它，前端就永远分不出。
 *
 * ⚠️ 别在这里加 `try/catch` 把它变成 `{ok:false}`：调用方（两个 composer、分享桥）对失败的
 * **表达方式**不一样 —— composer 要弹 toast，分享桥要回 reason 给外壳。让异常往上穿。
 */
import axios from 'axios';
import { getClientId } from '@/lib/util';

export interface PostTextOptions {
    /** 房间名（`wsStore.room`，已归一化过的那份） */
    room: string;
    /** 正文原样发送 —— ⚠️ **不 trim**，与界面里点发送完全一致 */
    text: string;
    /** 客户端 ID，默认本机那个 */
    client?: string;
}

export function postText({ room, text, client = getClientId() }: PostTextOptions) {
    return axios.post('text', text, {
        params: new URLSearchParams([['room', room], ['client', client]]),
        headers: {
            'Content-Type': 'text/plain',
        },
    });
}
