# dsh-canvas

[English](README.md) | 中文

一个 [DeepSeek Harness（DSH）](https://deepseek-harness.github.io/deepseek-harness)插件：在原生右侧栏加入两个画布工作区标签——**DSH Canvas**（Excalidraw 白板）与 **DSH-Flow**（React Flow 节点画布），并可一键把整个外壳切换成「画布为主」的布局。

## 功能

- **DSH Canvas 标签** —— 右侧栏「开始」面板里的「DSH Canvas」卡片；点击卡片或按 <kbd>Alt</kbd>+<kbd>\`</kbd> 打开 Excalidraw 白板。
- **DSH-Flow 标签** —— 「DSH-Flow」卡片打开 [React Flow 12](https://reactflow.dev) 节点画布：文本节点、箭头连线、Project Graph 风格的相机手感（键位见下表）。画板持久化到 `localStorage`，重启不丢。
- **工作区互换** —— 打开任一画布标签：中间栏（对话）与整个右侧栏互换位置，画布和侧栏面板占据中间、对话停靠右缘；关闭标签还原原布局。
- **原生手感** —— 分界线可见、可拖拽且方向自然；列宽实时跟随窗口缩放；任何退出路径（快捷键、关标签、切标签）都完整还原原布局。

## DSH-Flow 键位与交互

| 输入 | 动作 |
|---|---|
| 双击空白画布 | 新建文本节点 |
| 双击标题 / 摘要行 | 原地编辑（<kbd>Enter</kbd> 提交，<kbd>Esc</kbd> 取消） |
| 拖拽节点挂点 | 连出箭头边 |
| 右键节点 | 换色（5 色板）/ 删除 |
| 右键画布 | 新建节点 / 导出 PNG |
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>（按住） | 相机平移（连续、缓动） |
| <kbd>]</kbd> / <kbd>[</kbd>（按住） | 放大 / 缩小——每帧 ×1.05 / ×0.95，缓动 |
| <kbd>Enter</kbd> / <kbd>F2</kbd> | 编辑选中节点的标题 |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | 撤销 / 重做（快照栈） |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | 删除选中 |
| <kbd>Esc</kbd> | 清空选择 / 关闭菜单 |

滚轮缩放以光标为锚点；拖空白平移。键盘相机只改**目标值**，rAF 循环把真实视口向目标插值（Project Graph 手感）；滚轮和拖拽保持 d3-zoom 的直接控制。节点编辑器打开或焦点在可编辑元素时，键位引擎整体静默。

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

验收用例通过 CDP（端口 9222）驱动**真实 DSH 桌面端**——用项目外部的 `DSH-debug.bat` 启动器（或任意 `--remote-debugging-port=9222`）启动应用：

```sh
npm test             # 依次跑全部四套件
npm run test:phase1  # 挂载/互换 · 建节点 · 连线 · 缩放锚点 · 平移 · 持久化
npm run test:phase2  # 编辑 · 色板 · 右键菜单 · 撤销重做 · 删除 · PNG 导出
npm run test:phase3  # 相机手感：WASD · [] 缩放 · lerp · Enter/F2 · 编辑守卫
npm run test:phase4  # Excalidraw 四特性：画布管理 · 滚轮互换 · 原生双击 · 会话绑定
node tests/verify-021-adaptation.mjs   # 0.2.1 布局回归：互换网格 · 收起/展开 · 全屏 · 拖拽 · 会话 pin
```

⚠️ 重新构建 bundle 后必须**重启 DSH 应用**再测试——浏览器保留的是它启动时的 bundle。切勿用 CDP 的 `Network.clearBrowserCache` 刷新：会把应用引导永久打挂。

注意（0.2.x 桌面版）：可配置快捷键（如 <kbd>Alt</kbd>+<kbd>\`</kbd>）由 Windows 原生键盘经受信 preload 桥分发，CDP 合成的按键事件无法触发；测试改用插件自带的测试桥打开标签。

## Excalidraw 画布特性

内嵌 `@excalidraw/excalidraw`（界面中文 `langCode: 'zh-CN'`），并做了四项增强：

- **画布管理**：`onChange` 防抖持久化到 localStorage（关标签/重启恢复）；左上角菜单「新建画布 / 画布列表 / 删除当前画布」。
- **滚轮互换**：滚轮 = 光标锚点缩放，Ctrl+滚轮 = 滚动（与默认行为相反），捕获层拦截 + `updateScene` 实现。
- **字块带框（默认关闭）**：开关 `src/client.jsx` 顶部 `BOXED_TEXT_DBLCLICK`——打开后空白处双击创建「矩形容器 + 绑定文字」（官方 bound-text 机制；0.18.1 的 `convertToExcalidrawElements` 会弄坏容器骨架，故分开转换、手工接线）；关闭时空白双击保持原生纯文本。
- **会话绑定**：Ctrl+右键字块弹出菜单（创建会话并绑定 / 绑定已有会话… / 取消绑定），绑定写入官方 `element.link`（`dsh-session://<id>`，随元素复制/导出）；**Ctrl+单击字块 = 切换到绑定的会话**（走客户端 `sessions.create` + `uiWorkspace.openSession` 官方服务）。注意：跳转后右栏标签随会话切换而关闭，重开即恢复。

## 结构

| 路径 | 职责 |
|---|---|
| `src/index.js` | 宿主半边——空操作，让装载器能挂载本包 |
| `src/client.jsx` | 浏览器半边——标签注册、<kbd>Alt</kbd>+<kbd>\`</kbd> 快捷键、工作区互换、CDP 测试桥 |
| `src/canvas/CanvasFlow.jsx` | DSH-Flow 画板——状态、相机（target+lerp）、持久化、PNG 导出 |
| `src/canvas/TextNode.jsx` | 文本节点（原地编辑） |
| `src/canvas/ContextMenu.jsx` | 右键菜单（换色/删除 · 新建/导出） |
| `src/canvas/useUndoRedo.js` | 快照撤销/重做栈 |
| `src/canvas/palette.js` | 5 色板 + 节点动作上下文 |
| `src/keyboard.js` | 键位引擎（组合键、序列键、按住连续、`when` 守卫） |
| `src/workspace-swap.js` | 中右栏互换——dsh-canvas 的薄封装（命名 + React hook） |
| `src/shell-column-swap.js` | 可复用、零依赖的外壳换列工具（`installShellColumnSwap`），任何右侧栏插件可直接用 |
| `scripts/build-client.mjs` | 把浏览器半边打包成 DSH 模块加载器格式 |
| `scripts/asar-tool.mjs` | 只读 ASAR 列表/提取工具（查看已安装引擎的 bundle） |
| `tests/harness-interactions.mjs` | 统一 CDP 回归入口（`npm test`） |
| `tests/verify-021-adaptation.mjs` | 0.2.1 外壳布局适配套件（互换/收起/全屏/拖拽/pin） |
| `tests/flow-phase*.mjs` | 三套验收用例 |
| `lib/` | 构建产物（随仓库交付，即安装运行的包体） |

## 许可

MIT
