# 更新日志

clip9 的版本历史。**按版本倒序**（最新的在最上面），内容用中文，与 GitHub Release
上的发布说明**是同一份**（https://github.com/Jonnyan404/clip9/releases）。

⚠️★ 版本号**只住在 tag 里** —— 仓库里没有版本号文件，`rust/Cargo.toml` 那份
`[workspace.package] version` 只在「手动触发、没填 tag」时兜底
（见 `tools/release-version.mjs`）。所以**发版时没有文件需要改**，要动的只有这份日志：

1. 往顶上加一条**空的版本记录**（只有版本号与日期，变动留空），commit 它；
2. 打 tag、发 Release；
3. 回来把变动补上，commit。

⚠️★ 第 1 步**先空着也要提交**的理由：**tag 指向的那个提交必须能在本文件里查到自己**。
不然 checkout 到某个 tag 上，翻遍 CHANGELOG 也找不到「这一版是什么」——而这正是
`git log` 帮不了你的那一件事（它只有英文的提交信息）。

⚠️ 完整的发版流程（含要勾的选项）见 `.github/RELEASE_TEMPLATE.md`。

<!-- ↓↓↓ 新的一条加在这一行的下面 ↓↓↓ -->

## v0.1.0-beta4 · 2026-09-29（待发布）

（变动留空 —— 这是那条**空的版本记录**。发版时照 `.github/RELEASE_TEMPLATE.md` 的
骨架写中文说明，写完把这一段换掉。⚠️ 版本号与日期按**实际发布**的那一版/那一天改：
这里填的是占位，不是发版日。）
