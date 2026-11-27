# dsh-canvas

[English](README.md) | 中文

一个 [DeepSeek Harness（DSH）](https://deepseek-harness.github.io/deepseek-harness)插件：在原生右侧栏加入 **DSH Canvas**（Excalidraw 白板）标签，并可一键把整个外壳切换成「画布为主」的布局。

## 功能

- **DSH Canvas 标签** —— 右侧栏「开始」面板里的「DSH Canvas」卡片；点击卡片或按 <kbd>Alt</kbd>+<kbd>\`</kbd> 打开 Excalidraw 白板（内嵌 `@excalidraw/excalidraw`，界面中文）。
- **画布管理** —— 左上角菜单「新建画布 / 画布列表 / 删除当前画布」；多画布各自持久化到 localStorage，关标签、重启都不丢。
- **右键拖动画箭头** —— 按住**右键**拖动直接画箭头（免快捷键）：尾部=按下点、头部=松手点，两端自动吸附元素；拖到空白处松手会新建字块并让箭头与它元素级绑定。右键轻点仍是原生菜单，Ctrl/Alt+右键保留给会话绑定菜单。
- **会话绑定** —— Ctrl+右键字块弹出菜单（创建会话并绑定 / 绑定已有会话… / 取消绑定），绑定写入官方 `element.link`（`dsh-session://<id>`，随元素复制/导出）；**Ctrl+单击字块 = 切换到绑定的会话**（走客户端 `sessions.create` + `uiWorkspace.openSession` 官方服务）。注意：跳转后右栏标签随会话切换而关闭，重开即恢复。
- **Ctrl+S 记住保存路径** —— 保存 `.excalidraw` 文件后，文件句柄存入 IndexedDB，每个画布各记各的路径，重启后 Ctrl+S 直接覆盖原文件（图片导出路径故意不记，防止误覆盖）。
- **空格=选择工具** —— 按住 <kbd>Space</kbd> 切到选择工具（替换原生的按住空格平移）；打字、查看模式下不干扰。
- **滚轮互换** —— 滚轮 = 光标锚点缩放，Ctrl+滚轮 = 滚动（与 Excalidraw 默认行为相反），捕获层拦截 + `updateScene` 实现。
- **工作区互换** —— 打开画布标签：中间栏（对话）与整个右侧栏互换位置，画布和侧栏面板占据中间、对话停靠右缘；关闭标签还原原布局。

## 互换原理

DSH 外壳的 `AppFrame` 是一个三轨道 CSS Grid，列宽由 JS 实时计算并内联写入 `grid-template-columns`。因此互换方案是：

1. 用 CSS `grid-area` **显式摆放**三个列（中栏 → 第 3 轨道、右栏 → 第 2 轨道、左栏 → 第 1 轨道），并把外壳的 `[data-shell-bottom]` 底部行钉在第 2 行。必须显式摆放、**不能用 `order`**：0.2.1 起 AppFrame 多了一个底部行 grid item，`order` 会重排 auto-placement，把互换后的两列挤进隐式的第三行。
2. **镜像外壳自己的内联声明**（第 2、3 段文本对调）写入 CSS 变量并以 `!important` 应用——所有数值仍归外壳所有，拖拽、缩放、收起等重算实时跟随。
3. 通过稳定属性 `[data-rightbar-col]` 定位框架，再从元素 className 提取 css-module 哈希前缀——引擎升级会更换哈希（0.1.7 `pI_x6G_` → 0.2.0/0.2.1 `BynINW_`），这里没有任何硬编码。
4. 分界线拖拽时在捕获层把 `clientX` 绕拖拽起点镜像后转发，把外壳「右锚定」的宽度拖拽还原成自然的「左锚定」手感。
5. 失败即降级：若互换后框架行数超过已知的两行，互换自动关闭，退回原生的可用布局。

右栏轨道消失（收起/覆盖模式）时互换自动让位，轨道恢复后自动续上。

## 其它插件如何复用换列

整套机制都在 [`src/shell-column-swap.js`](src/shell-column-swap.js)——零依赖、无 React。任何往原生右侧栏挂内容的插件都能直接用：

```js
import { installShellColumnSwap } from './shell-column-swap.js'

// 你的面板挂载期间，中栏与右栏互换。命名按插件隔离，多插件可共存。
const dispose = installShellColumnSwap({
  attribute: 'data-myplugin-swap', // <html> 上的开关属性（默认 data-shell-swap）
  varPrefix: 'myplugin-swap',      // --myplugin-swap-cols / -handle（默认 shell-swap）
  tagId: 'my-plugin',              // 注入 <style> 的标记
  logPrefix: 'my-plugin',          // console 警告前缀
})

// 所有退出路径（关标签、快捷键、切标签）都要调用——还原原生布局：
dispose()
```

免费附带的整套行为：显式 `grid-area` 摆放（0.2.1 安全）、外壳列宽实时镜像、右轨道收起自动让位、自然方向的分界线拖拽、行数守卫失败即降级回原生布局。

## 安装

```sh
dsh plugin --profile desktop add <本地路径或 github:owner/repo>
```

安装后重启 DSH 桌面版。需要 Web 客户端——已在桌面版引擎 **0.2.1-rc.1** 实测（兼容 0.2.0 布局）。

## 构建

```sh
npm install
npm run build   # esbuild → lib/client.js（浏览器半边）+ lib/index.js（宿主半边）
```

## 测试

验收用例通过 CDP（端口 9222）驱动**真实 DSH 桌面端**——用任意 `--remote-debugging-port=9222` 方式启动应用后：

```sh
npm test             # 统一 CDP 回归入口（harness-interactions.mjs）
npm run test:phase4  # Excalidraw 四特性：画布管理 · 滚轮互换 · 原生双击 · 会话绑定
node tests/verify-021-adaptation.mjs   # 0.2.1 布局回归：互换网格 · 收起/展开 · 全屏 · 拖拽 · 会话 pin
node tests/verify-save-handle.mjs      # Ctrl+S 保存句柄持久化
```

⚠️ 重新构建 bundle 后必须**重启 DSH 应用**再测试——浏览器保留的是它启动时的 bundle。切勿用 CDP 的 `Network.clearBrowserCache` 刷新：会把应用引导永久打挂。

注意（0.2.x 桌面版）：可配置快捷键（如 <kbd>Alt</kbd>+<kbd>\`</kbd>）由 Windows 原生键盘经受信 preload 桥分发，CDP 合成的按键事件无法触发；测试改用插件自带的测试桥打开标签。

## 结构

| 路径 | 职责 |
|---|---|
| `src/index.js` | 宿主半边——空操作，让装载器能挂载本包 |
| `src/client.jsx` | 浏览器半边——标签注册、<kbd>Alt</kbd>+<kbd>\`</kbd> 快捷键、工作区互换、CDP 测试桥 |
| `src/canvas/excalidraw-canvas-store.js` | 多画布管理与 localStorage 持久化 |
| `src/canvas/right-drag-arrow.js` | 右键拖动画箭头（端点吸附 + 空白松手建字块并绑定） |
| `src/canvas/file-handle-store.js` | Ctrl+S 保存句柄的 IndexedDB 持久化 |
| `src/canvas/space-to-select.js` | 空格切选择工具 |
| `src/canvas/marquee-direction.js` | 框选方向手感修正 |
| `src/canvas/frame-erase-rescue.js` | 框架擦除抢救 |
| `src/canvas/command-executor.js` | 画布命令执行（CDP 测试桥用） |
| `src/keyboard.js` | 键位引擎（组合键、序列键、按住连续、`when` 守卫） |
| `src/workspace-swap.js` | 中右栏互换——dsh-canvas 的薄封装（命名 + React hook） |
| `src/shell-column-swap.js` | 可复用、零依赖的外壳换列工具（`installShellColumnSwap`），任何右侧栏插件可直接用 |
| `scripts/build-client.mjs` | 把浏览器半边打包成 DSH 模块加载器格式 |
| `scripts/asar-tool.mjs` | 只读 ASAR 列表/提取工具（查看已安装引擎的 bundle） |
| `tests/harness-interactions.mjs` | 统一 CDP 回归入口（`npm test`） |
| `tests/verify-021-adaptation.mjs` | 0.2.1 外壳布局适配套件 |
| `lib/` | 构建产物（随仓库交付，即安装运行的包体） |

## 许可

MIT
