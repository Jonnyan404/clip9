import type { ReceivedItem } from '@/stores/appStore';
import { filePreviewKind, isFileEntry, isImageName, looksLikeTable, looksLikeTaskList } from '@/lib/util';

/**
 * 时间线模式的**分类**判定 —— 单点。
 *
 * ⚠️ 分类与筛选**不是** `item.type`：文件条目的 `type` 是 MIME 派生的（`image` / `document` …），
 *    而文本条目里的任务列表 / 表格是 **markdown 结构**。判定一律走 `lib/util` 的
 *    `isFileEntry` / `isImageName` / `looksLikeTaskList` / `looksLikeTable`（全站唯一实现），
 *    这里只做「归类」这一件事。
 *
 * ⚠️ `text` 是**父类**：任务列表和表格都是文本，所以「文本」筛选要同时命中它们
 *    （见 `filterMatches`）。分类条上的计数也是这么算的。
 */
export type TimelineCategory = 'text' | 'image' | 'file' | 'task' | 'table';
export type TimelineFilter = 'all' | TimelineCategory;

/** 筛选条的顺序 —— 与标准模式 / 速览保持一致（用户切模式时不该重新找位置）。 */
export const TIMELINE_FILTERS: Array<{ key: TimelineFilter; labelKey: string; icon: string }> = [
    { key: 'all', labelKey: 'filterAll', icon: 'mdi-timeline' },
    { key: 'text', labelKey: 'filterText', icon: 'mdi-text-box-outline' },
    { key: 'image', labelKey: 'filterImage', icon: 'mdi-image-outline' },
    { key: 'file', labelKey: 'filterFile', icon: 'mdi-file-outline' },
    { key: 'task', labelKey: 'filterTaskList', icon: 'mdi-checkbox-marked-outline' },
    { key: 'table', labelKey: 'filterTable', icon: 'mdi-table' },
];

export function categoryOf(item: ReceivedItem): TimelineCategory {
    if (isFileEntry(item)) {
        return isImageName(item.name) ? 'image' : 'file';
    }
    const text = String(item.content || '');
    if (looksLikeTaskList(text)) return 'task';
    if (looksLikeTable(text)) return 'table';
    return 'text';
}

/** 一次算完一批条目的分类 —— 筛选、计数、日头摘要都读这一份，别对每条重复判型。 */
export function categoriesOf(items: ReceivedItem[]): Map<string, TimelineCategory> {
    const map = new Map<string, TimelineCategory>();
    for (const item of items) {
        map.set(item.id, categoryOf(item));
    }
    return map;
}

/** 「文本」筛选包含任务列表与表格 —— 它们本来就是文本，只是带了结构。 */
export function filterMatches(category: TimelineCategory, filter: TimelineFilter): boolean {
    if (filter === 'all') return true;
    if (filter === 'text') return category === 'text' || category === 'task' || category === 'table';
    return category === filter;
}

export function categoryLabelKey(category: TimelineCategory): string {
    switch (category) {
        case 'image': return 'filterImage';
        case 'file': return 'filterFile';
        case 'task': return 'filterTaskList';
        case 'table': return 'filterTable';
        default: return 'filterText';
    }
}

/** 行首那个小图标。文件再按可预览类型细分（视频 / 音频 / 其它）。 */
export function categoryIcon(category: TimelineCategory, name?: string): string {
    switch (category) {
        case 'image': return 'mdi-image-outline';
        case 'task': return 'mdi-checkbox-marked-outline';
        case 'table': return 'mdi-table';
        case 'file': {
            const kind = filePreviewKind(name);
            if (kind === 'video') return 'mdi-movie-outline';
            if (kind === 'audio') return 'mdi-music-note';
            return 'mdi-file-outline';
        }
        default: return 'mdi-text-box-outline';
    }
}
