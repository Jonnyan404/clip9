import { PageToolbar } from '@/components/AppShell/PageToolbar';

// ⚠️ Phase 3 占位组件（外壳已完成，模式本体待迁移）。
// 待迁移：web-vue3/src/views/modes/StickyWall.vue（便签墙 + 拖放 + 自动滚顶）。
// 计划：dev-docs/specs/react-migration-plan.md §7 Phase 5。
export default function StickyWall() {
    return (
        <>
            <PageToolbar variant="sticky" />
            <div style={{ padding: 16 }}>StickyWall（待迁移）</div>
        </>
    );
}
