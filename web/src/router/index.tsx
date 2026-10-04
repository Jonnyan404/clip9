import { createBrowserRouter } from 'react-router';
import { APP_BASE } from '@/lib/base';
import { routes } from './routes';

/**
 * 路由器实例 —— 对应 web-vue3/src/router/index.js 的 `createWebHistory(APP_BASE)`。
 *
 * ⚠️★ base 取**运行时**推导出来的 `APP_BASE`（服务端注入的 `<base>` / 文档目录），
 *    不是构建期的 `import.meta.env.BASE_URL`：prefix 是部署时配的，
 *    同一个产物要能落在任意子路径下。
 *
 * ⚠️ React Router 的 `basename` **不带结尾斜杠**（根路径 `/` 除外），而 `APP_BASE` 是
 *    `/clip/` 这种带斜杠的形态 —— 这里去掉尾斜杠，否则 `/clip/` 这种 basename 会让
 *    子路由匹配异常。
 */
const basename = APP_BASE === '/' ? '/' : APP_BASE.replace(/\/$/, '');

export const router = createBrowserRouter(routes, { basename });
