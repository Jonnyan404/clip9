# 截图放这里

README 的「界面截图」那一节与落地页（`docs/pages/`）都引用这三个文件：

| 文件 | 是什么 | 怎么重拍 |
|---|---|---|
| `desktop.png` | 桌面端（Tauri 壳） | 渲染 `rust/crates/desktop/ui/index.html` + 喂一份快照 |
| `web.png` | 网页端，宽屏 1440×900 | 真服务端 + 真前端，无头 Chrome 截图 |
| `mobile.png` | 网页端，手机 390×844 | 同上，换视口 |

⚠️ **不要用生成的图**：这几张是**无头 Chrome 截的真界面** —— 宣传图与产品不一致
是这类项目最常见的信任损耗，而重拍一次只要一分钟。

⚠️ 名字必须与上面一致，否则 README 里那条相对链接会断 ——
`tools/docs-links-smoke.mjs` 会逐个核对目标是否存在，断了就是 CI 红。
