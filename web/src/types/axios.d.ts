import 'axios';

// `__skipRoomAuthHandling` 是本项目给 axios 配置加的自定义标记：
// 命中 401 时**不**触发「房间鉴权弹窗」（分享页的 401 是预期内的，要密码）。
// 在 web-vue3 里这是普通对象字段；TS 下需要显式声明，否则传参会报未知属性。
declare module 'axios' {
    export interface AxiosRequestConfig {
        __skipRoomAuthHandling?: boolean;
    }
}
