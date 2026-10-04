import { PageToolbar } from '@/components/AppShell/PageToolbar';

// ⚠️ Phase 3 占位组件（外壳已完成，模式本体待迁移）。
// 待迁移：web-vue3/src/views/modes/GlanceWall.vue（主从两栏 + 键盘上下导航 + 全屏预览弹窗）。
// 计划：dev-docs/specs/react-migration-plan.md §7 Phase 5。
export default function GlanceWall() {
    return (
        <>
            <PageToolbar variant="glance" />
            <div style={{ padding: 16 }}>GlanceWall（待迁移）</div>
        </>
    );
}
