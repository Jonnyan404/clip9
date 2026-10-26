/* ==========================================================================
   时间线模式原型 —— 数据与渲染
   纯静态、无依赖；只服务于 docs/design/timeline-mode-options.html。
   ========================================================================== */
(function () {
    'use strict';

    /* ── 图标 ─────────────────────────────────────────────────────── */
    const ICONS = {
        text: '<path d="M4 6h16M4 12h10M4 18h14"/>',
        code: '<path d="m9 18-6-6 6-6M15 6l6 6-6 6"/>',
        task: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
        file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4M12 2v13"/>',
        trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
        chevron: '<path d="m9 18 6-6-6-6"/>',
        chevronDown: '<path d="m6 9 6 6 6-6"/>',
        phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M12 18h.01"/>',
        monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
        calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
        external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
        timeline: '<path d="M3 12h4l2 6 4-14 2 8h6"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
        pin: '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
        slash: '<path d="M17 3 7 21"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
        spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    };
    const ic = (name, size = 14) =>
        `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

    const esc = (s) =>
        String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    /* ── 演示数据 ─────────────────────────────────────────────────── */
    const DAYS = [
        { date: '2026-10-25', label: '10月25日', week: '周日', today: true },
        { date: '2026-10-24', label: '10月24日', week: '周六' },
        { date: '2026-10-23', label: '10月23日', week: '周五' },
    ];

    const KIND_LABEL = { text: '文本', code: '代码', task: '任务', table: '表格', link: '链接', image: '图片', file: '文件' };
    const KIND_ICON = { text: 'text', code: 'code', task: 'task', table: 'table', link: 'link', image: 'image', file: 'file' };
    const kindLabel = (k) => KIND_LABEL[k] || '文本';
    const kindIcon = (k) => KIND_ICON[k] || 'text';

    const ITEMS = [
        {
            id: 14, day: '2026-10-25', time: '16:42', type: 'text', kind: 'text',
            device: 'MacBook Pro', deviceType: 'desktop',
            preview: '周会纪要：下周三前把接口文档补完，@小李 负责登录那一节。',
            rich: `
                <h4>周会纪要 · 10/25</h4>
                <p>下周三前把接口文档补完，<strong>@小李</strong> 负责登录那一节。</p>
                <ul>
                    <li>同步协议改成 v2：WS 只推实时，历史走 HTTP 分页</li>
                    <li>时间线模式这周定稿，先做 A / B 两个方向</li>
                    <li>移动端剪贴板权限走系统提示，不再静默失败</li>
                </ul>
                <blockquote>本周不做主题皮肤，先把时间线定下来。</blockquote>`,
        },
        {
            id: 13, day: '2026-10-25', time: '16:12', type: 'file', kind: 'image',
            device: 'Pixel 8', deviceType: 'mobile',
            name: '屏幕截图 2026-10-25 16.12.03.png', size: '1.4 MB', dims: '2560 × 1440', ext: 'PNG',
            preview: '屏幕截图 2026-10-25 16.12.03.png',
        },
        {
            id: 12, day: '2026-10-25', time: '15:58', type: 'text', kind: 'code',
            device: 'MacBook Pro', deviceType: 'desktop',
            previewHtml: '<code>curl -s http://127.0.0.1:9501/api/health | jq .</code>',
            preview: 'curl -s http://127.0.0.1:9501/api/health | jq .',
            rich: `
                <p>健康检查返回正常，房间和客户端数都对得上：</p>
                <pre><code>$ curl -s http://127.0.0.1:9501/api/health | jq .
{
  "status": "ok",
  "uptime": 13842,
  "rooms": 3,
  "clients": 5
}</code></pre>`,
        },
        {
            id: 11, day: '2026-10-25', time: '14:20', type: 'text', kind: 'table',
            device: 'iPad Pro', deviceType: 'mobile',
            preview: '同步耗时：MacBook Pro 48 ms / Pixel 8 120 ms / OpenWrt 210 ms',
            rich: `
                <table>
                    <thead><tr><th>设备</th><th>冷启动</th><th>增量同步</th></tr></thead>
                    <tbody>
                        <tr><td>MacBook Pro</td><td>1.2 s</td><td>48 ms</td></tr>
                        <tr><td>Pixel 8</td><td>2.4 s</td><td>120 ms</td></tr>
                        <tr><td>OpenWrt</td><td>3.1 s</td><td>210 ms</td></tr>
                    </tbody>
                </table>`,
        },
        {
            id: 10, day: '2026-10-25', time: '13:03', type: 'text', kind: 'task',
            device: 'MacBook Pro', deviceType: 'desktop',
            preview: '发布前检查项：替换签名证书、跑 check、更新 CHANGELOG…',
            rich: `
                <ul class="tasklist">
                    <li class="done"><span>替换 release 签名证书</span></li>
                    <li class="done"><span>跑 <code>npm run check</code></span></li>
                    <li><span>更新 CHANGELOG 与版本号</span></li>
                    <li><span>打 tag 并推 Docker 镜像</span></li>
                </ul>`,
        },
        {
            id: 9, day: '2026-10-25', time: '13:03', type: 'text', kind: 'text',
            device: 'MacBook Pro', deviceType: 'desktop',
            preview: '把服务器的监听端口改成 9501，然后重启一下。',
            rich: `
                <p>把服务器的监听端口改成 <code>9501</code>，然后重启一下。</p>
                <pre><code>clip9 --port 9501 --data /var/lib/clip9</code></pre>`,
        },
        {
            id: 8, day: '2026-10-25', time: '12:40', type: 'file', kind: 'file',
            device: 'MacBook Pro', deviceType: 'desktop',
            name: '部署清单 v2.pdf', size: '820 KB', ext: 'PDF',
            preview: '部署清单 v2.pdf',
        },
        {
            id: 7, day: '2026-10-25', time: '11:05', type: 'text', kind: 'link',
            device: 'MacBook Pro', deviceType: 'desktop',
            preview: 'github.com/Jonnyan404/clip9/releases/latest',
            rich: `
                <p>最新一版发在 Releases，桌面端三平台都齐了：</p>
                <p><a href="#" data-link>github.com/Jonnyan404/clip9/releases/latest</a></p>`,
        },
        {
            id: 6, day: '2026-10-25', time: '09:31', type: 'text', kind: 'text',
            device: 'CI Runner', deviceType: 'desktop', scheduled: true, late: true,
            preview: '每日构建：3 个平台全部通过，产物已上传。',
            rich: `
                <p><strong>每日构建</strong>：三个平台全部通过，产物已上传到 <code>releases/nightly</code>。</p>
                <ul>
                    <li>linux-x64 ✅</li>
                    <li>macos-arm64 ✅</li>
                    <li>android-arm64 ✅</li>
                </ul>`,
        },
        {
            id: 5, day: '2026-10-24', time: '22:10', type: 'text', kind: 'code',
            device: 'MacBook Pro', deviceType: 'desktop',
            previewHtml: '<code>{"name":"clip9","port":9501,"room":"public"}</code>',
            preview: '{"name":"clip9","port":9501,"room":"public"}',
            rich: `<pre><code>{"name":"clip9","port":9501,"room":"public","maxHistory":50}</code></pre>`,
        },
        {
            id: 4, day: '2026-10-24', time: '20:33', type: 'file', kind: 'image',
            device: 'iPad Pro', deviceType: 'mobile',
            name: '白板草图.png', size: '640 KB', dims: '1920 × 1080', ext: 'PNG',
            preview: '白板草图.png',
        },
        {
            id: 3, day: '2026-10-24', time: '18:05', type: 'text', kind: 'text',
            device: 'MacBook Pro', deviceType: 'desktop',
            preview: '发版前记得先跑一遍 npm run check，契约检查不过就别打包。',
            rich: `
                <p>发版前记得先跑一遍 <code>npm run check</code>，契约检查不过就别打包。</p>
                <ul>
                    <li>桌面端：macOS / Windows 各打一份</li>
                    <li>Android：只出 arm64</li>
                    <li>Web：<code>npm run build</code> 后同步 <code>dist/</code></li>
                </ul>`,
        },
        {
            id: 2, day: '2026-10-23', time: '10:15', type: 'file', kind: 'file',
            device: 'MacBook Pro', deviceType: 'desktop',
            name: 'clips-archive.zip', size: '12.6 MB', ext: 'ZIP',
            preview: 'clips-archive.zip',
        },
        {
            id: 1, day: '2026-10-23', time: '08:02', type: 'text', kind: 'text',
            device: 'OpenWrt', deviceType: 'desktop',
            preview: '昨晚 23:40 之后没再收到心跳，路由那边重启过一次。',
            rich: `<p>昨晚 <strong>23:40</strong> 之后没再收到心跳，路由那边重启过一次，现在恢复了。</p>`,
        },
    ];

    const CHIPS = [
        { key: 'all', label: '全部', icon: 'timeline' },
        { key: 'text', label: '文本', icon: 'text' },
        { key: 'image', label: '图片', icon: 'image' },
        { key: 'file', label: '文件', icon: 'file' },
        { key: 'task', label: '任务', icon: 'task' },
        { key: 'table', label: '表格', icon: 'table' },
    ];

    /* ── 说明面板文案 ─────────────────────────────────────────────── */
    const NOTES = {
        a: {
            key: '方案 A',
            title: '轨道时间线',
            lead: '一根贯穿的轴把「什么时候」变成结构本身：时间在轴左侧，内容在右侧，日期作为吸顶大标题。',
            rows: [
                ['结构', '46px 时间列 + 28px 轴 + 自适应卡片；日期头吸顶，轴的起点/终点弱化。'],
                ['优势', '时间感最强，日期和小时分界一眼可见；卡片接近复用现有 Text / File 组件，迁移成本最低。'],
                ['代价', '横向吃掉约 72px，手机上更明显；一屏只有 5–6 条；内容很短时轴显得空。'],
                ['实现', '新外壳 + 复用卡片，约 1 天。窄屏把轴收到 20px，时间挪进卡片 meta。'],
                ['对比标准模式', '标准模式是「卡片往下堆」；A 把时间提到轴外，并让日期一直吸在顶部。'],
            ],
            tags: ['复用现有卡片', '日期吸顶', '最稳'],
            effort: 1,
        },
        b: {
            key: '方案 B',
            title: '日志流',
            lead: '像翻日志：一行一条，时间、类型、摘要、来源排成固定列，鼠标扫过去就能读完一天。',
            rows: [
                ['结构', '按日分块，块头带小时分布柱；行内固定列对齐，展开后原地长出富文本。'],
                ['优势', '密度最高（一屏 10–12 条）；短内容不用展开；复制/删除等动作可做成快捷键，最贴合剪贴板的核心动作。'],
                ['代价', '要写新的紧凑行组件，不能直接复用卡片；图片只能给 46px 小缩略图；视觉记忆点偏弱。'],
                ['实现', '约 1.5 天（新组件 + 展开态 + 日块折叠）。'],
                ['对比标准模式', '同一屏能多读一倍条目；短内容不展开也能判断要不要复制，这是和标准模式最大的差别。'],
            ],
            tags: ['密度最高', '扫读最快', '适合重度使用'],
            effort: 2,
        },
        c: {
            key: '方案 C',
            title: '双栏编织',
            lead: '中轴贯穿，卡片左右交替，时间点变成轴上的小气泡 —— 最像「时间线」这个词本身。',
            rows: [
                ['结构', '1fr / 66px / 1fr 三列网格，日期胶囊压在轴上；窄屏退化为单列（等同 A 的简化版）。'],
                ['优势', '视觉最抓眼，宽屏空间利用充分，适合演示和截图传播。'],
                ['代价', '阅读路径是之字形，连续扫读慢；同屏条数最少；窄屏必须维护第二套布局。'],
                ['实现', '约 1 天，但移动端要多维护一套样式。'],
                ['对比标准模式', '标准模式只有一条单列；C 把时间空间化，宽屏左右各一列。'],
            ],
            tags: ['展示感强', '只建议大屏', '两套布局'],
            effort: 2,
        },
        d: {
            key: '方案 D',
            title: '时段带',
            lead: '顶部一条 24 小时尺，先看「今天什么时候最忙」，再按小时往下展开；空档明确标出来。',
            rows: [
                ['结构', '吸顶时间尺（按小时的堆叠柱 + 当前时刻线）+ 按小时分组；历史日用 accordion 收起。'],
                ['优势', '时间节奏一眼可见，点尺子能直接跳到那个小时；和看板/速览的差异最大。'],
                ['代价', '实现最重：尺子、分组、滚动联动都要调；空小时需要折叠，否则尺子比内容还高。'],
                ['实现', '约 2 天（尺子 + 小时分组 + 跳转联动 + 历史折叠）。'],
                ['对比标准模式', '标准模式只回答「来了什么」；D 先回答「今天什么时候最忙」，再往下钻。'],
            ],
            tags: ['差异最大', '时间节奏', '实现最重'],
            effort: 3,
        },
    };

    /* ── 状态 ─────────────────────────────────────────────────────── */
    const state = {
        variant: 'a',
        filter: 'all',
        query: '',
        expanded: new Set(),
        foldedDays: new Set(),
    };

    const view = document.getElementById('view');
    const frame = document.getElementById('frame');
    const chipsEl = document.getElementById('chips');
    const countEl = document.getElementById('count');
    const notesEl = document.getElementById('notes');
    const searchEl = document.getElementById('searchInput');
    const toastEl = document.getElementById('toast');

    /* ── 工具 ─────────────────────────────────────────────────────── */
    const matchesFilter = (i) => {
        switch (state.filter) {
            case 'all': return true;
            case 'text': return i.type === 'text';
            case 'image': return i.kind === 'image';
            case 'file': return i.type === 'file' && i.kind !== 'image';
            case 'task': return i.kind === 'task';
            case 'table': return i.kind === 'table';
            default: return true;
        }
    };

    const matchesQuery = (i) => {
        const q = state.query.trim().toLowerCase();
        if (!q) return true;
        return [i.preview, i.name, i.rich, i.device, KIND_LABEL[i.kind]]
            .filter(Boolean).join(' ').toLowerCase().includes(q);
    };

    const visible = () => ITEMS.filter((i) => matchesFilter(i) && matchesQuery(i));

    const grouped = (list) => DAYS.map((d) => ({
        ...d,
        items: list.filter((i) => i.day === d.date).sort((x, y) => (x.time < y.time ? 1 : -1)),
    })).filter((d) => d.items.length);

    const metaLine = (i, opts = {}) => {
        const bits = [];
        if (opts.time) bits.push(`<span class="meta">${i.time}</span>`);
        bits.push(`<span class="meta"><span class="meta__id">#${i.id}</span></span>`);
        bits.push(`<span class="meta">${ic(i.deviceType === 'mobile' ? 'phone' : 'monitor', 11)}${esc(i.device)}</span>`);
        return bits.join('<span class="dotsep"></span>');
    };

    const badges = (i) => [
        i.scheduled ? `<span class="pill pill--auto">${ic('clock', 10)}定时</span>` : '',
        i.late ? `<span class="pill pill--warn">${ic('clock', 10)}延迟</span>` : '',
    ].join('');

    const actions = () => `
        <span class="acts">
            <button class="act" data-copy title="复制">${ic('copy', 14)}</button>
            <button class="act" data-share title="分享">${ic('share', 14)}</button>
            <button class="act act--danger" data-del title="删除">${ic('trash', 14)}</button>
        </span>`;

    const thumb = (big) => `
        <span class="thumb${big ? ' thumb--big' : ''}" aria-hidden="true">
            <span class="thumb__bar"><i></i><i></i><i></i></span>
            <span class="thumb__body"></span>
        </span>`;

    function fileBody(i) {
        if (i.kind === 'image') {
            return `<div class="fbody">${thumb(false)}<span><span class="fname">${esc(i.name)}</span><span class="fmeta">${i.size} · ${i.dims}</span></span></div>`;
        }
        return `<div class="fbody"><span class="ftile">${i.ext}</span><span><span class="fname">${esc(i.name)}</span><span class="fmeta">${i.size} · 文件</span></span></div>`;
    }

    function fileExtra(i) {
        const preview = i.kind === 'image'
            ? `<div class="imgprev">${thumb(true)}<div class="imgprev__meta">${i.dims} · ${i.size}</div></div>`
            : '';
        return `${preview}
            <div class="rowbtns">
                <button class="btn btn--sm" data-copy>${ic('download', 12)} 下载</button>
                <button class="btn btn--sm" data-share>${ic('share', 12)} 分享链接</button>
            </div>`;
    }

    const emptyState = () => `
        <div class="empty">
            ${ic('search', 22)}
            <div style="margin-top:8px">没有匹配的条目</div>
            <div style="margin-top:4px;font-size:11px;opacity:.8">换个分类，或者清空搜索词</div>
        </div>`;

    /* ── 方案 A ───────────────────────────────────────────────────── */
    function cardA(i) {
        const open = state.expanded.has(i.id);
        const isFile = i.type === 'file';
        return `
        <div class="arow" data-kind="${i.kind}" data-id="${i.id}">
            <div class="a-time"><b>${i.time.slice(0, 2)}</b>:${i.time.slice(3)}</div>
            <div class="a-axis"><span class="a-dot"></span></div>
            <article class="acard${open ? ' is-open' : ''}">
                <header class="acard__head" data-toggle="${i.id}">
                    <span class="pill">${ic(kindIcon(i.kind), 11)}${kindLabel(i.kind)}</span>
                    ${badges(i)}
                    <span class="acard__meta">${metaLine(i)}</span>
                    <span class="acard__spacer"></span>
                    ${actions()}
                    <span class="chev acard__chev">${ic('chevron', 13)}</span>
                </header>
                <div class="acard__body" data-toggle="${i.id}">
                    ${isFile ? fileBody(i) : `<p class="prev">${i.previewHtml || esc(i.preview)}</p>`}
                    ${open ? `<div class="rich">${i.rich || ''}</div>${isFile ? fileExtra(i) : ''}` : ''}
                </div>
            </article>
        </div>`;
    }

    function renderA(groups) {
        if (!groups.length) return emptyState();
        return groups.map((g) => `
            <section class="a-day">
                <div class="a-head">
                    <span class="a-date">${g.label}</span>
                    <span class="a-week">${g.week}</span>
                    ${g.today ? '<span class="a-today">今天</span>' : ''}
                    <span class="a-count">${g.items.length} 条</span>
                </div>
                <div class="a-body">${g.items.map(cardA).join('')}</div>
            </section>`).join('');
    }

    /* ── 方案 B ───────────────────────────────────────────────────── */
    function compactRow(i, mode) {
        const open = state.expanded.has(i.id);
        const isFile = i.type === 'file';
        return `
        <div class="crow${mode === 'd' ? ' crow--d' : ''}${open ? ' is-open' : ''}" data-kind="${i.kind}" data-id="${i.id}">
            <button class="crow__main${mode === 'd' ? ' crow__main--hour' : ''}" data-toggle="${i.id}">
                ${mode === 'd' ? '' : `<span class="crow__time">${i.time}</span>`}
                <span class="crow__ico">${ic(kindIcon(i.kind), 14)}</span>
                <span class="crow__text">
                    <span class="crow__prev">${i.previewHtml || esc(i.preview)}</span>
                    <span class="crow__meta">${kindLabel(i.kind)}<span class="dotsep"></span>${metaLine(i, { time: mode === 'd' })} ${badges(i)}</span>
                </span>
                ${i.kind === 'image' ? thumb(false).replace('class="thumb"', 'class="thumb crow__thumb"') : ''}
                <span class="crow__chev">${ic('chevron', 13)}</span>
            </button>
            ${actions()}
            ${open ? `<div class="crow__full">${i.rich ? `<div class="rich">${i.rich}</div>` : ''}${isFile ? fileExtra(i) : ''}</div>` : ''}
        </div>`;
    }

    function hist(items) {
        if (!items.length) return { bars: [], range: '' };
        const counts = {};
        items.forEach((i) => {
            const h = Number(i.time.slice(0, 2));
            counts[h] = (counts[h] || 0) + 1;
        });
        const hs = Object.keys(counts).map(Number).sort((a, b) => a - b);
        const max = Math.max(...hs.map((h) => counts[h]));
        const bars = hs.map((h) => ({
            hour: h,
            n: counts[h],
            h: Math.max(4, Math.round((counts[h] / max) * 18)),
        }));
        const pad = (n) => String(n).padStart(2, '0');
        return { bars, range: `${pad(hs[0])}–${pad(hs[hs.length - 1])} 时` };
    }

    const typePills = (items) => {
        const counts = {};
        items.forEach((i) => { counts[i.kind] = (counts[i.kind] || 0) + 1; });
        const keys = Object.keys(counts);
        const shown = keys.slice(0, 4).map((k) =>
            `<span class="pill" data-kind="${k}">${kindLabel(k)} ${counts[k]}</span>`).join('');
        const rest = keys.length - 4;
        return shown + (rest > 0 ? `<span class="pill pill--soft">+${rest}</span>` : '');
    };

    function renderB(groups) {
        if (!groups.length) return emptyState();
        return `<div class="b-wrap">${groups.map((g) => {
            const { bars, range } = hist(g.items);
            return `
            <section class="b-block${state.foldedDays.has(g.date) ? ' is-folded' : ''}">
                <header class="b-head" data-collapse="${g.date}">
                    <span class="b-date">${g.label}</span>
                    <span class="b-week">${g.week}</span>
                    ${g.today ? '<span class="b-today">今天</span>' : ''}
                    <span class="b-histwrap">
                        <span class="b-hist">${bars.map((b) =>
                            `<i style="height:${b.h}px" title="${b.hour}:00 · ${b.n} 条"></i>`).join('')}</span>
                        <small>${range}</small>
                    </span>
                    <span class="b-types">${typePills(g.items)}</span>
                    <span class="b-count">${g.items.length} 条</span>
                    <svg class="ic b-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS.chevronDown}</svg>
                </header>
                <div class="b-list">${g.items.map((i) => compactRow(i, 'b')).join('')}</div>
            </section>`;
        }).join('')}</div>`;
    }

    /* ── 方案 C ───────────────────────────────────────────────────── */
    function cardC(i, side) {
        const open = state.expanded.has(i.id);
        const isFile = i.type === 'file';
        return `
        <div class="c-row c-row--${side}" data-kind="${i.kind}" data-id="${i.id}">
            <div class="c-time"><span class="dot"></span>${i.time}</div>
            <article class="c-card${open ? ' is-open' : ''}" data-toggle="${i.id}">
                <div class="c-card__head">
                    <span class="pill">${ic(kindIcon(i.kind), 11)}${kindLabel(i.kind)}</span>
                    ${badges(i)}
                    <span class="c-card__spacer"></span>
                    ${actions()}
                    <span class="chev">${ic('chevron', 13)}</span>
                </div>
                <div class="c-card__body">
                    ${isFile ? fileBody(i) : `<p class="prev">${i.previewHtml || esc(i.preview)}</p>`}
                    ${open ? `<div class="rich">${i.rich || ''}</div>${isFile ? fileExtra(i) : ''}` : ''}
                    <div class="crow__meta" style="margin-top:6px">${metaLine(i)}</div>
                </div>
            </article>
        </div>`;
    }

    function renderC(groups) {
        if (!groups.length) return emptyState();
        return `<div class="c-wrap">${groups.map((g) => `
            <div class="c-date">
                <span class="c-datepill">
                    <b>${g.label}</b> ${g.week}
                    ${g.today ? '<span class="b-today">今天</span>' : ''}
                    <span class="n">${g.items.length} 条</span>
                </span>
            </div>
            ${g.items.map((i, idx) => cardC(i, idx % 2 === 0 ? 'l' : 'r')).join('')}`).join('')}</div>`;
    }

    /* ── 方案 D ───────────────────────────────────────────────────── */
    function hourGroups(items) {
        const byHour = {};
        items.forEach((i) => {
            const h = Number(i.time.slice(0, 2));
            (byHour[h] = byHour[h] || []).push(i);
        });
        const hours = Object.keys(byHour).map(Number).sort((a, b) => b - a);
        let out = '';
        hours.forEach((h, idx) => {
            const prev = hours[idx - 1];
            if (idx > 0 && prev - h > 1) {
                out += `<div class="d-gap">${prev - h - 1} 小时无记录</div>`;
            }
            out += `
            <div class="d-group" id="d-h-${h}" data-hour="${h}">
                <div class="d-hour">${String(h).padStart(2, '0')}<span>${byHour[h].length} 条</span></div>
                <div class="d-group__body">${byHour[h].map((i) => compactRow(i, 'd')).join('')}</div>
            </div>`;
        });
        return out;
    }

    function dayBars(items) {
        const byHour = {};
        items.forEach((i) => {
            const h = Number(i.time.slice(0, 2));
            (byHour[h] = byHour[h] || []).push(i);
        });
        return Object.keys(byHour).map(Number).sort((a, b) => a - b).map((h) => {
            const list = byHour[h];
            return `<div class="d-hourbar" style="left:calc(${(h / 24) * 100}% + 1px)"
                        data-hour="${h}" title="${String(h).padStart(2, '0')}:00 · ${list.length} 条">
                        ${list.map((i) => `<i data-kind="${i.kind}"></i>`).join('')}
                    </div>`;
        }).join('');
    }

    function renderD(groups) {
        if (!groups.length) return emptyState();
        const today = groups[0];
        const older = groups.slice(1);
        const nowPct = ((16 * 60 + 47) / 1440) * 100;
        return `
        <div class="d-ruler">
            <div class="d-ruler__head">
                <b>${today.label}</b>
                <span class="muted">${today.week} · ${today.items.length} 条</span>
                <span class="d-now">现在 16:47</span>
                <div class="d-nav">
                    <button class="is-on" data-day="today">今天</button>
                    ${older.map((g) => `<button data-day="${g.date}">${g.label.replace('10月', '10/')}</button>`).join('')}
                </div>
            </div>
            <div class="d-scale">
                <div class="d-scale__grid"></div>
                <div class="d-scale__bars">${dayBars(today.items)}</div>
                <div class="d-nowline" style="left:${nowPct}%"></div>
            </div>
            <div class="d-axis">
                ${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span>${String(h).padStart(2, '0')}</span>`).join('')}
            </div>
        </div>
        <div class="d-groups">${hourGroups(today.items)}</div>
        ${older.map((g) => `
            <details class="d-dayfold" id="d-day-${g.date}"${state.expanded.has('day-' + g.date) ? ' open' : ''}>
                <summary data-day-open="${g.date}">
                    ${g.label} · ${g.week}
                    <span class="b-count" style="margin-left:2px">${g.items.length} 条</span>
                    <svg class="ic b-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS.chevron}</svg>
                </summary>
                <div class="d-groups">${hourGroups(g.items)}</div>
            </details>`).join('')}`;
    }

    const RENDERERS = { a: renderA, b: renderB, c: renderC, d: renderD };

    /* ── 页面渲染 ─────────────────────────────────────────────────── */
    function updateChrome() {
        const list = visible();
        chipsEl.innerHTML = CHIPS.map((c) => {
            const n = c.key === 'all' ? ITEMS.length : ITEMS.filter((i) => {
                const prev = state.filter;
                state.filter = c.key;
                const ok = matchesFilter(i);
                state.filter = prev;
                return ok;
            }).length;
            return `<button class="chip${state.filter === c.key ? ' is-on' : ''}" data-filter="${c.key}">
                ${ic(c.icon, 12)}<span>${c.label}</span><span class="chip__n">${n}</span>
            </button>`;
        }).join('');
        countEl.textContent = `${list.length} / ${ITEMS.length}`;
    }

    function updateNotes() {
        const n = NOTES[state.variant];
        notesEl.innerHTML = `
            <div class="notes__kicker">${n.key}</div>
            <h3>${n.title}</h3>
            <p class="notes__lead">${n.lead}</p>
            <dl>${n.rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
            <div class="notes__meter">
                工作量
                <span class="dots">${[1, 2, 3, 4].map((i) => `<i class="${i <= n.effort ? 'on' : ''}"></i>`).join('')}</span>
                <span>${n.effort === 1 ? '约 1 天' : n.effort === 2 ? '约 1.5 天' : '约 2 天'}</span>
            </div>
            <div class="notes__tags">${n.tags.map((t) => `<span>${t}</span>`).join('')}</div>`;
    }

    function paint() {
        const list = visible();
        const groups = grouped(list);
        const keep = view.scrollTop;

        view.dataset.variant = state.variant;
        view.innerHTML = RENDERERS[state.variant](groups);
        view.scrollTop = keep;

        requestAnimationFrame(() => {
            view.scrollTop = Math.min(keep, view.scrollHeight);
            const ruler = view.querySelector('.d-ruler');
            if (ruler) {
                view.style.setProperty('--ruler-h', ruler.offsetHeight + 'px');
            } else {
                view.style.removeProperty('--ruler-h');
            }
        });
    }

    function render() {
        updateChrome();
        updateNotes();
        paint();
    }

    /* ── 交互 ─────────────────────────────────────────────────────── */
    function toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('is-on');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toastEl.classList.remove('is-on'), 1600);
    }

    function toggle(rawId) {
        const id = Number(rawId);
        if (state.expanded.has(id)) state.expanded.delete(id);
        else state.expanded.add(id);
        const keep = view.scrollTop;
        paint();
        view.scrollTop = keep;
    }

    document.getElementById('picker').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-variant]');
        if (!btn) return;
        state.variant = btn.dataset.variant;
        document.querySelectorAll('.opt').forEach((o) => o.classList.toggle('is-on', o === btn));
        view.scrollTop = 0;
        render();
    });

    document.getElementById('widthSeg').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-width]');
        if (!btn) return;
        document.querySelectorAll('#widthSeg button').forEach((b) => b.classList.toggle('is-on', b === btn));
        frame.style.maxWidth = btn.dataset.width === 'mobile' ? '430px' : '100%';
        view.scrollTop = 0;
        requestAnimationFrame(() => {
            const ruler = view.querySelector('.d-ruler');
            if (ruler) view.style.setProperty('--ruler-h', ruler.offsetHeight + 'px');
        });
    });

    document.getElementById('themeBtn').addEventListener('click', () => {
        const root = document.documentElement;
        const wasDark = root.dataset.theme === 'dark';
        root.dataset.theme = wasDark ? 'light' : 'dark';
        document.getElementById('themeIcon').innerHTML = wasDark
            ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>'
            : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    });

    chipsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-filter]');
        if (!btn) return;
        state.filter = btn.dataset.filter;
        view.scrollTop = 0;
        render();
    });

    searchEl.addEventListener('input', () => {
        state.query = searchEl.value;
        view.scrollTop = 0;
        render();
    });

    view.addEventListener('click', (e) => {
        const act = e.target.closest('[data-copy], [data-share], [data-del]');
        if (act) {
            e.preventDefault();
            e.stopPropagation();
            toast(act.hasAttribute('data-copy') ? '已复制（演示）'
                : act.hasAttribute('data-share') ? '分享链接已生成（演示）'
                : '已删除（演示）');
            return;
        }
        if (e.target.closest('a[href="#"]')) e.preventDefault();

        const link = e.target.closest('[data-link]');
        if (link) { e.preventDefault(); toast('将在新标签页打开（演示）'); return; }

        const collapse = e.target.closest('[data-collapse]');
        if (collapse) {
            const date = collapse.dataset.collapse;
            if (state.foldedDays.has(date)) state.foldedDays.delete(date);
            else state.foldedDays.add(date);
            const block = collapse.closest('.b-block');
            block.classList.toggle('is-folded');
            return;
        }

        const hourBar = e.target.closest('.d-hourbar');
        if (hourBar) {
            const target = view.querySelector(`#d-h-${hourBar.dataset.hour}`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }

        const dayBtn = e.target.closest('[data-day]');
        if (dayBtn) {
            if (dayBtn.dataset.day === 'today') {
                view.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                const box = view.querySelector(`#d-day-${dayBtn.dataset.day}`);
                if (box) {
                    box.open = true;
                    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
            view.querySelectorAll('.d-nav button').forEach((b) => b.classList.toggle('is-on', b === dayBtn));
            return;
        }

        const toggleEl = e.target.closest('[data-toggle]');
        if (toggleEl) {
            e.preventDefault();
            toggle(toggleEl.dataset.toggle);
        }
    });

    document.addEventListener('keydown', (e) => {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.matches('input, textarea'))) return;
        const map = { 1: 'a', 2: 'b', 3: 'c', 4: 'd' };
        const v = map[e.key];
        if (!v || e.metaKey || e.ctrlKey || e.altKey) return;
        state.variant = v;
        document.querySelectorAll('.opt').forEach((o) => o.classList.toggle('is-on', o.dataset.variant === v));
        view.scrollTop = 0;
        render();
    });

    /* 预置状态：方便分享某个方案 / 直接截深色图，例如
       timeline-mode-options.html?v=b&theme=dark&width=mobile */
    (function applyParams() {
        const q = new URLSearchParams(location.search);
        const v = q.get('v');
        if (v && RENDERERS[v]) {
            state.variant = v;
            document.querySelectorAll('.opt').forEach((o) => o.classList.toggle('is-on', o.dataset.variant === v));
        }
        if (q.get('theme') === 'dark') {
            document.documentElement.dataset.theme = 'dark';
            document.getElementById('themeIcon').innerHTML =
                '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>';
        }
        const open = q.get('open');
        if (open) {
            open.split(',').forEach((id) => {
                const n = Number(id);
                if (n) state.expanded.add(n);
            });
        }
        if (q.get('width') === 'mobile') {
            frame.style.maxWidth = '430px';
            document.querySelectorAll('#widthSeg button').forEach((b) =>
                b.classList.toggle('is-on', b.dataset.width === 'mobile'));
        }
    })();

    render();
})();
