/**
 * 文档 → Markdown（`POST /convert/{uuid}`，见 `rust/crates/server/src/convert.rs`）。
 *
 * ⚠️★ 这条链路上**只有一次**格式判定，在服务端的 `clip9_actions::doc` 里
 * （内容优先、扩展名兜底）。前端**不许**再判一次 —— 判得不一样时，症状是
 * 「同一个文件在两条路上转出不同结果」，而那正是这个项目最怕的静默不一致。
 * 所以这里连「这个扩展名能不能转」都不判，只把服务端的话转达给用户。
 */
import axios from 'axios';
import { writeParams } from './http';

/** `GET /server` 里 `convert` 那一段的形状。 */
/**
 * 「为什么用不了」→ i18n key。
 *
 * ⚠️★ 放这里而不是散在两个组件里：`reason` 是**服务端给的**，
 * 解释它属于「读响应」这件事，不属于界面。两处各写一遍必然漂 ——
 * 而漂的表现是「白板里说的原因和转 Markdown 页说的不一样」。
 */
export function convertUnsupportedKey(reason: ConvertCapability['reason']): string {
    if (reason === 'not_built') return 'canvasUnsupportedNotBuilt';
    if (reason === 'unsupported') return 'canvasUnsupportedDeployment';
    // ⚠️ 不知道就说不知道，**不兜成 `not_built`** —— 那正是这次要修的毛病。
    return 'canvasUnsupportedUnknown';
}

export interface ConvertCapability {
    /** 这台部署带不带转换能力（= 服务端编译时有没有 `doc` feature）。 */
    enabled: boolean;
    /** 认得的扩展名（小写、不带点）。⚠️ 只是**提示**，给 `<input accept>` 用。 */
    extensions: string[];    /**
     * **为什么不可用** —— 服务端说了算，前端不许猜。
     *
     * ⚠️★ 2026-10-12 加。以前前端只看 `enabled: false`，于是**一律**说
     * 「构建时缺 `doc`」。在 Cloudflare Worker 上那是**错的** ——
     * 那边压根没有文档解析器，谈不上「没编 doc」，用户会去翻构建配置白费功夫。
     *
     * - `'not_built'` —— 这是个 Rust 服务端，但构建时没带 `doc` feature → 重新构建
     * - `'unsupported'` —— 这个后端不提供文档转换（Cloudflare Worker）→ 换后端
     * - `null` —— 可用，或服务端没给（老版本）
     */
    reason: 'not_built' | 'unsupported' | null;
}

/** 文档里的一张内嵌图片。 */
export interface DocumentImage {
    /** MIME，例如 `image/png`。 */
    mime: string;
    /** 原始字节的 **base64**（不带 `data:` 前缀 —— 那层由前端拼）。 */
    data: string;
    bytes: number;
}

/**
 * 文档里的图片集合。
 *
 * ⚠️★ **`null` 不是「没有图」，是「这个格式读不出来」。**
 *
 * `anydoc` 的 `to_document` 对 **PDF 不支持**（PDF 直接出 Markdown、没有文档模型形态），
 * 所以服务端对 PDF 回 `null`。把 `null` 当 0 显示，等于对一份满是插图的 PDF
 * 说「这份文档没有图片」—— 那是**编造事实**。界面必须把两者分开说。
 */
export interface DocumentImages {
    /** **找到的**图片总数。可能大于 `items.length`（见 `truncated`）。 */
    total: number;
    /** 超出服务端的响应预算，只带回了一部分。 */
    truncated: boolean;
    items: DocumentImage[];
}

export interface ConvertResult {
    markdown: string;
    /** 原文件名 —— 溯源要用（白板元素上的 `clip9FileId` 指回这条文件）。 */
    name: string;
    /** Markdown 的**字符数**（不是字节数）。 */
    chars: number;
    /** 内嵌图片。见 [`DocumentImages`] 关于 `null` 的说明。 */
    images: DocumentImages | null;
    /** PDF 的版面分析。⚠️ `null` = **不是 PDF**（不是「没有多栏」）。 */
    pdf: PdfLayout | null;
}

/**
 * PDF 的版面分析。
 *
 * ⚠️★ 它存在的唯一理由是**把静默错误变成显式警告**：
 * PDF 是打印格式、只有绝对坐标、没有「栏」的概念，所以一份**双栏**排版
 * （现在的中文简历大半是这样）抽出来是**左右交错**的 ——
 * 句子被拦腰截断后交叉在一起，而**输出看起来像正常文字**。
 * 2026-10-12 实测：一份双栏简历转出来 `## 工作经历` 跑到了最前面。
 *
 * ⚠️ 上游**可能漏报**（实测：间距较大的双栏没被认出来）——
 * 所以界面上的文案**不许**承诺「没警告就一定没错行」。
 */
export interface PdfLayout {
    pageCount: number;
    /** **多栏排版的页**（1 起）。空数组 = 没检测到多栏。 */
    multiColumnPages: number[];
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
        // ⚠️ 认不出的取值一律 `null`（当「不知道」），**不兜成 `'not_built'`** ——
        // 那正是这次要修的那个「把猜测当事实」。
        reason:
            convert?.reason === 'not_built' || convert?.reason === 'unsupported'
                ? convert.reason
                : null,
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
            // ⚠️ `null` 原样带出去，**不**兜成 `{total:0,...}` —— 那会把
            // 「读不出来」伪装成「没有图」，见 `DocumentImages` 的注释。
            pdf:
                data.pdf && typeof data.pdf === 'object'
                    ? {
                          pageCount: Number(data.pdf.pageCount ?? 0),
                          multiColumnPages: Array.isArray(data.pdf.multiColumnPages)
                              ? data.pdf.multiColumnPages.map(Number)
                              : [],
                      }
                    : null,
            images:
                data.images && typeof data.images === 'object'
                    ? {
                          total: Number(data.images.total ?? 0),
                          truncated: data.images.truncated === true,
                          items: Array.isArray(data.images.items)
                              ? data.images.items.filter(
                                    (item: unknown): item is DocumentImage =>
                                        !!item &&
                                        typeof (item as DocumentImage).mime === 'string' &&
                                        typeof (item as DocumentImage).data === 'string',
                                )
                              : [],
                      }
                    : null,
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
/**
 * ⚠️★ 单次上传的**客户端**上限。
 *
 * 服务端的 `UPLOAD_BODY_HARD_CAP` 是 **16 MiB**，而它拒绝时走的是框架层 ——
 * 返回的 body **不是契约形状**（不是 `{code,error,message}`），客户端只能吐一句
 * 没有数字的错。所以这里先拦一道，把「太大」变成一句人话。
 *
 * ⚠️ 留 1 MiB 余量：multipart 的边界、每个部分的头、以及文件名都算在请求体里，
 * 不留的话「正好 16 MiB」的内容会被莫名其妙地拒掉。
 */
const UPLOAD_SAFE_MAX = 15 * 1024 * 1024;

/** 给界面看的 MiB 数 —— 提示里要写「上限多少」，别让每个调用点各算一遍。 */
export const UPLOAD_SAFE_MAX_MIB = UPLOAD_SAFE_MAX / 1024 / 1024;

/** 内容超过单次上传上限时抛的。调用方据此提示「拆小一点」而不是「上传失败」。 */
export class UploadTooLarge extends Error {
    constructor(readonly bytes: number) {
        super('upload payload too large');
        this.name = 'UploadTooLarge';
    }
}

/**
 * 上传一份文件，回它的 uuid。
 *
 * ⚠️★ **走分片那条路（初始化 → 一个分片 → 收尾），不是 `POST /upload`。**
 *
 * 为什么不用更简单的 `POST /upload`：它的响应是 `{url, id, type}`，而那个 `url` 是
 * **内容 URL**（`/content/<id>`，见服务端 `handlers::content_url`）——
 * **uuid 根本不在里面**。2026-10-10 真浏览器实测才发现：拿 `/file/([^/]+)` 去抠
 * 永远抠不到，于是「导入文档」在**上传成功之后**静默中止
 * （文件条目都建好了，画布却什么都没有）。
 *
 * 而 `POST /upload/chunk`（**初始化**）的响应里**直接就有 uuid**（`{result:{uuid}}`）。
 * 服务端对单个分片的大小**没有**约束（只累加查 `file.limit`），所以「一个分片装完整份」
 * 是合法的 —— 这也是为什么这里不需要自己切 slice。
 *
 * ⚠️ 三条都成功才算上传完成：初始化建登记、分片写字节、收尾才入库 + 广播。
 * 少了收尾，房间里的其他设备**看不到**这条文件。
 *
 * ⚠️ 超过 [`UPLOAD_SAFE_MAX`] 的直接拒（见那里的注释）：单次请求体有 16 MiB 硬上限，
 * 超了服务端会以**非契约形状**回错，客户端只能吐一句没有数字的话。
 */
export async function uploadDocument(params: {
    file: File;
    room: string;
}): Promise<{ uuid: string; name: string }> {
    if (params.file.size > UPLOAD_SAFE_MAX) {
        throw new UploadTooLarge(params.file.size);
    }
    // ① 初始化：body 是**文件名**，回 uuid（这一路不落盘，只登记）
    const init = await axios.post('upload/chunk', params.file.name, {
        headers: { 'Content-Type': 'text/plain' },
        params: writeParams(params.room),
    });
    const uuid: unknown = init.data?.result?.uuid;
    if (typeof uuid !== 'string' || !uuid) {
        throw new ConvertRejected('bad_response', '上传初始化没有返回文件标识，无法继续');
    }

    // ② 一个分片装完整份
    await axios.post(`upload/chunk/${uuid}`, params.file, {
        headers: { 'Content-Type': 'application/octet-stream' },
        params: writeParams(params.room),
    });

    // ③ 收尾：登记消息 + 广播给房间里的其他设备
    await axios.post(`upload/finish/${uuid}`, null, { params: writeParams(params.room) });

    return { uuid, name: params.file.name };
}

