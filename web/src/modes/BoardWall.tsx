import { PageToolbar } from '@/components/AppShell/PageToolbar';

// ⚠️ Phase 3 占位组件（外壳已完成，模式本体待迁移）。
// 待迁移：web-vue3/src/views/modes/BoardWall.vue（三列看板 + HTML5 拖放 + 「移到」菜单）。
// 计划：dev-docs/specs/react-migration-plan.md §7 Phase 5。
export default function BoardWall() {
    return (
        <>
            <PageToolbar variant="board" />
            <div style={{ padding: 16 }}>BoardWall（待迁移）</div>
        </>
    );
}
