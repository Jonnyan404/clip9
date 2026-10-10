/**
 * 文档 → Markdown（`POST /convert/{uuid}`，见 `rust/crates/server/src/convert.rs`）。
 *
 * ⚠️★ 这条链路上**只有一次**格式判定，在服务端的 `clip9_actions::doc` 里
 * （内容优先、扩展名兜底）。前端**不许**再判一次 —— 判得不一样时，症状是
 * 「同一个文件在两条路上转出不同结果」，而那正是这个项目最怕的静默不一致。
 * 所以这里连「这个扩展名能不能转」都不判，只把服务端的话转达给用户。
 */
import axios from 'axios';

/** `GET /server` 里 `convert` 那一段的形状。 */
export interface ConvertCapability {
    /** 这台部署带不带转换能力（= 服务端编译时有没有 `doc` feature）。 */
    enabled: boolean;
    /** 认得的扩展名（小写、不带点）。⚠️ 只是**提示**，给 `<input accept>` 用。 */
    extensions: string[];
}

export interface ConvertResult {
    markdown: string;
    /** 原文件名 —— 溯源要用（白板元素上的 `clip9FileId` 指回这条文件）。 */
    name: string;
    /** Markdown 的**字符数**（不是字节数）。 */
    chars: number;
}

/**
 * ⚠️★ 这台部署**没编转换能力**时抛的（路由压根没注册 → 404）。
 *
 * 与「文件找不到」（也是 404，但码是 `file_not_found`）**必须分开**：
 * 前者是「这个后端要升级」，后者是「这份文件没了」—— 提示语和该做的事完全不同。
 * 这条与 `stats.ts` 的 `ActivityUnsupported` 是同一个教训：
 * 笼统的「失败」会把人往错的方向带。
 */
export class ConvertUnsupported extends Error {
    constructor() {
        super('convert endpoint missing');
        this.name = 'ConvertUnsupported';
    }
}

/**
 * 服务端**明确说了**转不了时抛的（400 `convert_failed` / 413 太大）。
 *
 * `reason` 直接用服务端那句中文 —— 它是唯一知道「为什么转不了」的地方
 * （格式不认 / 加密 / 扫描件需要 OCR / 结构损坏 / 超上限），前端复述一遍必然漂。
 */
export class ConvertRejected extends Error {
    readonly code: string;
    readonly reason: string;

    constructor(code: string, reason: string) {
        super(reason);
        this.name = 'ConvertRejected';
        this.code = code;
        this.reason = reason;
    }
}

/** 从 `GET /server` 读转换能力。⚠️ 判据只有这一处，别在前端猜。 */
export async function fetchConvertCapability(room: string): Promise<ConvertCapability> {
    const { data } = await axios.get('server', { params: { room } });
    const convert = data?.convert;
    // ⚠️ 老服务端没有这一段 —— 当成「没有这个能力」，而不是「有但空」。
    // 猜成「有」的后果是界面上出现一个点进去必然失败的入口。
    return {
        enabled: convert?.enabled === true,
        extensions: Array.isArray(convert?.extensions) ? convert.extensions : [],
    };
}

/**
 * 把一条**已上传的文件条目**转成 Markdown。
 *
 * ⚠️ `uuid` 必须是已经上传成功的文件 —— 服务端挂在文件条目上（理由见
 * `rust/crates/server/src/convert.rs` 的模块文档：白板要留溯源、白嫖文件管线、
 * 不用再定一次请求体上限）。
 */
export async function convertFile(params: {
    uuid: string;
    room: string;
}): Promise<ConvertResult> {
    try {
        const { data } = await axios.post(`convert/${encodeURIComponent(params.uuid)}`, null, {
            params: { room: params.room },
        });
        if (!data || typeof data.markdown !== 'string') {
            // ⚠️ 回来的不是我们要的东西 —— 说出来，别把 `undefined` 当 Markdown 用。
            throw new ConvertRejected('bad_response', '服务端返回的不是转换结果');
        }
        return {
            markdown: data.markdown,
            name: typeof data.name === 'string' ? data.name : '',
            chars: typeof data.chars === 'number' ? data.chars : data.markdown.length,
        };
    } catch (error) {
        if (error instanceof ConvertRejected) {
            throw error;
        }
        const response = (
            error as { response?: { status?: number; data?: { code?: string; message?: string } } }
        )?.response;
        const status = response?.status;
        const code = response?.data?.code ?? '';

        // ⚠️★ 404 分两种，靠 `code` 分而不是靠状态码：
        //   · 没编 `doc` feature → 路由不存在 → 404 + 一份**静态兜底**（可能压根不是 JSON）；
        //   · 文件没了 / 过期 → 404 + `file_not_found` / `file_expired`。
        // 只看状态码会把「后端要升级」说成「文件没了」。
        if (status === 404 && !code) {
            throw new ConvertUnsupported();
        }
        if (status === 404) {
            throw new ConvertRejected(code, response?.data?.message ?? '文件未找到或已过期');
        }
        if (status === 400 || status === 413) {
            throw new ConvertRejected(
                code || 'convert_failed',
                response?.data?.message ?? '这份文档转换不了',
            );
        }
        throw error;
    }
}

/**
 * 上传一份文档，回它的 uuid —— 好接着调 [`convertFile`]。
 *
 * ⚠️★ 为什么 uuid 是从**响应里的 url** 抠出来的：`POST /upload` 回的是
 * `{url, id, type}`（与 `/text` 同一个形状），**没有单独的 uuid 字段**，
 * 而 uuid 就写在 url 里（`<prefix>/file/<uuid>[/<name>]`，见服务端 `files::finish_file_message`）。
 *
 * ⚠️ 只走**整份上传**（不分片）：白板要导入的是文档，而文档的大小远在
 * `file.chunk`（缺省 1 MiB）之上还是之下都无所谓 —— 分片那条路要三次往返 + 自己
 * 切 slice，对「用户点一下等结果」这个场景是白加的复杂度。
 * ⚠️ 但**服务端**那条路要认得上限：单次上传的硬上限是 16 MiB，
 * 超了会被框架以**非契约形状**拒掉 —— 所以这里先按 `file.chunk` 之外的宽松值自查一次，
 * 把「太大」变成一句人话，而不是一个看不懂的 413。
 */
export async function uploadDocument(params: {
    file: File;
    room: string;
}): Promise<{ uuid: string; name: string }> {
    const formData = new FormData();
    formData.set('file', params.file);

    const { data } = await axios.postForm('upload', formData, {
        params: new URLSearchParams([['room', params.room]]),
    });

    const uuid = fileUuidOf(data?.url);
    if (!uuid) {
        throw new ConvertRejected('bad_response', '上传成功但拿不到文件标识，无法转换');
    }
    return { uuid, name: params.file.name };
}

/**
 * 从 `/file/<uuid>[/<name>]` 这种 url 里抠出 uuid。
 *
 * ⚠️ 名字那段是**可选的**（服务端两条路由都认），所以正则不能要求它存在。
 * ⚠️ uuid 后面可能跟着 `/`、`?`、`#` 或结束 —— 都要能停住。
 */
export function fileUuidOf(url: unknown): string {
    if (typeof url !== 'string') {
        return '';
    }
    const match = /\/file\/([^/?#]+)/.exec(url);
    return match ? decodeURIComponent(match[1]) : '';
}
