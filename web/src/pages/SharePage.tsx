import { useParams } from 'react-router';

// ⚠️ Phase 1 占位页面。
// 待迁移：web-vue3/src/views/ShareView.vue（token 取 info / 密码 / raw↔md / 媒体预览 /
// 预览令牌 / 访问上报 / token 变化重载）。计划：react-migration-plan.md §7 Phase 6。
//
// ⚠️ 这一页由**服务端外壳**（rust/crates/server/src/spa_shell.rs）注入 OG 后下发，
//    抓取程序与真人拿的是同一份 HTML、同一个地址（`<prefix>/s/<token>`）。
export default function SharePage() {
    const { token } = useParams<{ token?: string }>();
    return <div style={{ padding: 16 }}>SharePage（待迁移）—— token: {token || '(none)'}</div>;
}
