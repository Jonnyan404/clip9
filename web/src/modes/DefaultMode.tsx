import { PageToolbar } from '@/components/AppShell/PageToolbar';

// ⚠️ Phase 3 占位组件（外壳已完成，模式本体待迁移）。
// 待迁移：web-vue3/src/views/modes/DefaultMode.vue（时间流 + 分类过滤 + 搜索 + 自动滚顶）。
// 计划：dev-docs/specs/react-migration-plan.md §7 Phase 4。
export default function DefaultMode() {
    return (
        <>
            <PageToolbar variant="default" />
            <div style={{ padding: 16 }}>DefaultMode（待迁移）</div>
        </>
    );
}
