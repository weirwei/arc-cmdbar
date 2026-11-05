# Arc Cmdbar

给 Chrome 补一个 Arc 式的命令栏（Arc 的 ⌘T）：一个搜索框，同时搜打开的标签页、最近关闭的标签页、书签、历史记录和常用命令，全键盘操作。

```
┌──────────────────────────────────────────────┐
│ ⌕  zbnt                                      │
├──────────────────────────────────────────────┤
│ ▸ Zebra Notes                       标签页   │  ← 已打开的标签页优先
│   127.0.0.1/zebra                            │
│   Zebra crossing rules              历史     │
│   搜索“zbnt”                        搜索     │
├──────────────────────────────────────────────┤
│ ↑↓ 选择  ↵ 打开  ⇧↵ 在当前标签打开  ⌘⇧⌫ 关闭  │
└──────────────────────────────────────────────┘
```

## 功能

- **一个框搜所有**：打开的标签页（所有窗口）、最近关闭（最多 25 个，含关闭的窗口）、书签（含文件夹名）、历史记录（打开时载入最近 1500 条，输入 2 个字以上时再向 Chrome 历史查 100 条）。同一个网址只显示一次，优先级：标签页 > 书签 > 最近关闭 > 历史。
- **模糊匹配**：`zbnt` 能找到「Zebra Notes」，`gcal` 能找到「Google Calendar」；连续字符、词首、网址开头（输入 `gith` 优先 github.com）得分更高，最近用过、常访问的靠前。多个词用空格分开，每个词都要命中。匹配到的字母会高亮。
- **命令**（直接和搜索结果混在一起，输入中英文或拼音都行，如 `close` / `关闭` / `guanbi`）：新建标签页、关闭当前标签页、复制当前网址、复制为 Markdown 链接、固定 / 取消固定、**重置标签页**（固定标签回到固定时的网址，同 Arc）、创建副本、重新加载、静音 / 取消静音、移到新窗口、重新打开刚关闭的标签页。
- **网址和搜索**：输入像网址的内容（`github.com`、`localhost:3000`）第一行是「打开」；其他文字最后一行是「搜索」，用 Chrome 的默认搜索引擎。`javascript:`、`data:` 等不会被当成网址。
- **打开方式**：回车切到已打开的标签页、恢复已关闭的标签页；书签 / 历史 / 网址在当前标签右边新开（当前是新标签页时直接用它）。⇧↵ 在当前标签打开。
- **键盘**：↑↓ 或 Ctrl+N / Ctrl+P 选择（首尾循环），↵ 执行，⇧↵ 在当前标签打开，⌘⇧⌫（Windows/Linux 为 Ctrl+Shift+Backspace）关闭选中的标签页结果，Esc 关闭。
- **深色 / 浅色**跟随系统；支持屏幕阅读器（combobox + listbox + aria-activedescendant，结果数量用 live region 播报）。

## 快捷键

默认建议 `Alt+Shift+K`（Mac 上是 ⌥⇧K）。可在 `chrome://extensions/shortcuts` 改成别的。

Chrome 不允许插件占用 ⌘T / Ctrl+T，建议的快捷键必须带 Ctrl 或 Alt。可以手动绑成 ⌘K、⌘⇧Space 之类没被 Chrome 占用的组合。

## 权限

`tabs`、`sessions`、`bookmarks`、`history`、`favicon`、`storage`、`search`、`clipboardWrite`。

- 没有任何网站权限（没有 `<all_urls>`，没有内容脚本），插件读不到、也改不了网页内容。
- 界面是工具栏弹出框（popup），所以 `chrome://` 页面、应用商店页面里也能用。
- 不联网，没有统计。数据只在弹出框打开时从 Chrome 读取，不保存。唯一保存的是「固定标签页 → 固定时的网址」，存在 `chrome.storage.session`（浏览器退出即清空）。

## 安装（开发版）

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择本目录。
3. 按 `Alt+Shift+K`，或点工具栏图标。

## 开发

```bash
npm test                                                          # 单元测试：匹配、排序、去重、网址识别、命令
CHROME_BIN="/path/to/Google Chrome for Testing" npm run e2e       # 真浏览器端到端
npm run zip                                                       # 打包
```

正式版 Chrome 不支持 `--load-extension`，e2e 需要 [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)。e2e 用临时用户目录和本地 HTTP 页面，不联网（「搜索」那一项会打开 Google 搜索页但只检查网址），结束后删除临时目录。

e2e 把 `src/popup.html?target=<标签页 id>` 当普通标签页打开来驱动：`target` 指定命令作用的标签页，执行后页面不自动关闭。不带参数时和真正的弹出框行为一样（执行完关闭自己）。

## 目录

```
manifest.json
src/rank.js        纯函数：模糊匹配、打分、去重、网址识别、排序（node --test 测）
src/sources.js     把 chrome.tabs / sessions / bookmarks / history 的结果转成搜索项
src/actions.js     命令列表
src/popup.*        界面
src/background.js  记录标签页被固定时的网址（给「重置标签页」用）
```

## 已知限制

- 是工具栏弹出框，不是 Arc 那样页面中间的浮层：位置固定在工具栏下方，宽 640px。要做页面浮层就需要在所有网站注入脚本（`<all_urls>`），本插件刻意不这样做。
- 「重置标签页」只对本次浏览器会话里固定的标签有效：插件安装前、或浏览器重启前就固定的标签，记下的是插件第一次看到它时的网址。重启后 Chrome 恢复的固定标签同理。
- 模糊匹配比较宽松，长标题里分散的字母也能命中，排在后面。
- 历史记录只预载最近 1500 条；更早的条目靠 Chrome 自带的历史搜索补充（按词匹配，不是模糊匹配）。
- 不支持拼音搜索中文标题（命令除外，命令带了拼音关键词）。
- 隐身窗口未测试（Chrome 默认不在隐身模式运行插件）。
