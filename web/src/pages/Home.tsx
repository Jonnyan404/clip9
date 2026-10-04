import { useAppStore } from '@/stores/appStore';
import { resolveModeComponent } from '@/modes/registry';

/**
 * 模式分发器 —— 对应 web-vue3/src/views/Home.vue。
 *
 * 现有实现用 `<component :is="viewComponent">`；React 侧等价物是「查表拿组件、再渲染」。
 * ⚠️ 模式状态在 store 里（不是组件局部状态），所以模式切换不会丢状态 —— 这也是 Vue 侧
 *    给 Home 挂 `keepAlive` 的原因，在 React 里天然成立（Home 常驻，只有内部组件在换）。
 */
export default function Home() {
    const uiMode = useAppStore((s) => s.uiMode);
    const ModeComponent = resolveModeComponent(uiMode);

    return (
        <div className="mode-root">
            <ModeComponent />
        </div>
    );
}
