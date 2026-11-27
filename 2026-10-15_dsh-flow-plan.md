# DSH-Flow 执行计划书（React Flow 12 表面层）

> 生成：2026-10-15。**本文是唯一执行基准**，写给新会话：读完本文即可开工，无需其他对话上下文。
> 总原则：**引擎开箱 + 示例照抄 + FastGPT 当参考书** —— React Flow 生态里省事的最优解。

---

## 0. 一句话任务

把 DSH 宿主右栏的「DSH Canvas · Leafer」占位标签替换为 **React Flow 12 画布**，入口与标签改名 **DSH-Flow**，实现 8 项基本操作 + Project Graph 丝滑手感参数。Excalidraw 主标签（「DSH Canvas」）**不在本计划范围，一行都不动**。

## 1. 背景与决策链（30 秒版）

- dsh-canvas 是 DSH 宿主的画布插件（esbuild 打包 client.js 注入右栏标签）。
- 表面引擎选型 2026-10-15 定稿：**React Flow 12（@xyflow/react，MIT）**。
  - 淘汰 Leafer：交互全自建太费，已拆除归档（**git tag v0.1.0** 可完整回退，提交 df561a7）。
  - 淘汰 Project Graph 整包移植：app 是 GPL-3.0（传染），且 Canvas2D 放不了活体 DOM。只抄它的**交互参数**（见 §7）。
  - 淘汰 AntV X6：中文/内置件强，但会造成双引擎并存；React Flow 与内面系统（未来会话节点画布）同库归一。
- React Flow 已在 DSH 客户端实证可跑（dsh-runflow 用 @xyflow/react ^12.8.4 跑通），环境风险低。

## 2. 现状盘点（动手前先读代码确认）

项目：`dsh-canvas`（git 仓库，有 v0.1.0 回退点）

| 文件 | 现状 | 处理 |
|---|---|---|
| `src/client.jsx`（262 行） | L37 `LEAFER_TAB_ID='dsh-canvas:canvas-leafer'`；L43-61 Excalidraw require+样式注入（**不动**）；L96 `CanvasBody`=Excalidraw 主标签（**不动**）；L178-239 **Leafer 占位标签注册块**（LeaferPlaceholderBody + disposeLeaferType/Body/Title）→ **替换目标**；`apply()`/主题/图标/`toggleWorkspace` 保留 | 改 |
| `src/keyboard.js`（170 行） | 纯逻辑键位引擎：注册表 `{id,defaultKey,onPress,onRelease?,when,isContinuous?}` + 序列键匹配 + 按住连续 + 守卫族，**零 Leafer 依赖** | **复用** |
| `src/workspace-swap.js` | 中右栏互换，与画布无关 | 不动（注释提及 Leafer 可顺带改） |
| `scripts/build-client.mjs` | esbuild 打包；L21-22,37 是 Excalidraw 资产路径注入（**不动**） | 不动 |
| `package.json` | dependencies：`@excalidraw/excalidraw`、`react-dom`。**@excalidraw 不卸**（主标签在用） | +新依赖 |
| `tests/` | `harness-interactions.mjs`=CDP 测试基建（保留改造）；`diag-*`/`in-shell-*`=Leafer 时代脚本 | 见 §10 |
| 旧文档 | 见 §10 清理项 | 参数已迁 §7，可删 |

⚠️ **铁律：换 bundle 后必须重启 DSH 宿主、禁清缓存**，否则浏览器加载旧 client.js 白测。

## 3. 改造点

1. **依赖**：`npm i @xyflow/react html-to-image`（后者仅 PNG 导出用，MIT）
2. **client.jsx**：删除 L37 + L178-239 的 Leafer 占位块，新注册 DSH-Flow 标签：
   - 入口卡标题、标签页 title、description 全部显示 **「DSH-Flow」**（原来显示「DSH Canvas · Leafer」的两处 + 指南卡入口一处）
   - 内部 id 建议 `'dsh-canvas:flow'`（旧 id 带 leafer 字样有误导；占位阶段无持久化关联，改 id 零风险）
   - tab body 指向新的 `<CanvasFlow />`
3. **新建 `src/canvas/`**（不引 Tailwind，样式手写 CSS）：
   - `CanvasFlow.jsx` — ReactFlow 主体：`<Background variant="dots">` + `<MiniMap>` + `<Controls>` + 自定义 nodeTypes/edgeTypes + 受控模式（onNodesChange/onEdgesChange/onConnect）
   - `TextNode.jsx` — 文本节点：标题+摘要两行、双击进 textarea 编辑（blur/Enter 保存）、5 色板换色
   - `useUndoRedo.js` — 快照栈撤销（抄官方示例，Ctrl+Z / Ctrl+Shift+Z）
   - `ContextMenu.jsx` — 右键菜单（节点上：换色/删除；空白：新建节点；Esc/点击外部关闭）
   - `canvas.css` — 节点/菜单样式 + **必须引入 `@xyflow/react/dist/style.css`**
   - 持久化：localStorage 防抖保存 nodes+edges+viewport（`toObject()` 一行拿全量；key 用 `dsh-flow:v1`，勿复用旧 leafer key）
4. **keyboard.js 接线**：注册 WASD 连续平移、Delete 删除（when=有选中且非编辑中）、Esc 清选；编辑聚焦时全引擎静默（守卫已内建）

## 4. 实施阶段与验收标准（每阶段一个 commit）

**Phase 1 · 最小画布跑通宿主（核心风险点）**
- 装依赖 → CanvasFlow 最小版（网格背景/缩放/平移/双击空白建节点/拖连线/localStorage 保存）→ 替换占位 + 改名 DSH-Flow → 重启宿主实测
- ✅ 验收：DSH 宿主打开 DSH-Flow 标签——双击建节点、拖 handle 连线、滚轮缩放（鼠标锚点）、拖空白平移、刷新后数据还在；入口卡与标签标题均显示 DSH-Flow；Excalidraw 主标签不受影响

**Phase 2 · 8 项基本操作补齐**
- 右键菜单、Delete 删除、撤销/重做、PNG 导出（html-to-image 抄官方 download-image 示例）
- ✅ 验收：§5 清单逐条过

**Phase 3 · Project Graph 手感（§7 参数）**
- ✅ 验收：用户真机手感拍板（丝滑度主观验收）

**Phase 4 · 测试与收口**
- CDP 回归用例（改造 harness-interactions.mjs）、README 双语更新、§10 清理项
- ✅ 验收：测试全绿后才交用户验收（工作协议：计划定稿即执行→测试循环到全绿→才交验收）

## 5. 8 项基本操作 → 实现来源

| # | 操作 | 来源 |
|---|---|---|
| 1 | 建文本节点 | 自写 TextNode + 双击空白 onPaneClick/双击（几十行） |
| 2 | 连线节点 | **内置**：onConnect + 自定义带箭头 edge（markerEnd） |
| 3 | 移动节点 | **内置**拖拽 |
| 4 | 缩放/平移 | **内置** d3-zoom（滚轮缩放+鼠标锚点、拖空白平移） |
| 5 | 保存 | **内置** `toObject()` → localStorage 防抖 |
| 6 | 输出 PNG | 抄官方示例 `download-image`（html-to-image） |
| 7 | 右键删除 | onNodeContextMenu + 自写菜单（内置 deleteKeyCode 作补充） |
| 8 | 撤销/恢复 | 抄官方示例 `undo-redo` 快照栈（~50 行） |

## 6. 完成定义（总验收）

1. DSH-Flow 标签在宿主内完整可用：8 项操作全过 + 刷新持久
2. 手感三件套生效：×1.05 缩放步进、lerp 平滑、WASD 按住连续平移
3. Excalidraw 主标签与 workspace-swap 功能零回归
4. CDP 用例全绿、README 更新、旧物清理完成

## 7. Project Graph 手感参数（自拆解文档迁移，2026-10-15 源码实测）

**相机物理（丝滑核心）**
- 缩放：`targetScale` 目标值 + **每帧 lerp 到达**；滚轮/按键只改 target，不直接改 scale
- 键盘缩放步进 **×1.05 / ×0.95 每帧**；滚轮保持「滚轮=缩放、光标为锚点」现状
- 平移同 target+lerp；WASD 按住连续（isContinuous），松手收尾（onRelease 存盘）

**React Flow 落地方式**
- 滚轮缩放步进：`zoomIn/zoomOut({ duration:~150 })` 或监听 onMoveBadRequest 自控 target；勿用默认瞬跳
- lerp：`useReactFlow().setViewport` 在 rAF 循环里向 target 插值（或 `fitView` 动画参数）
- WASD：keyboard.js 引擎注册 isContinuous 键位 → 每帧 `panBy({x,y})`

**键位蓝本（优先级排序，Phase 3 装）**
| 键 | 功能 |
|---|---|
| WASD（按住） | 相机四向平移 |
| `[` / `]`（按住） | 缩小/放大（×0.95/×1.05 每帧，target+lerp） |
| Tab | 选中节点 → 生成子节点并进入编辑（深度生长，招牌交互，可选做） |
| A-方向（×4） | 从选中节点向该方向新建文本节点（可选） |
| Enter / F2 | 进入编辑（**Space 进编辑必须绑 keyup**——绑 down 会导致退出编辑后框选/点击失灵，原作者实测的坑） |
| Esc | 取消编辑/清空选择 |

**避坑四条**
① Space 绑 keyup（同上）；② preventDefault 与输入框竞态用 setTimeout(1) 解；③ 同键多义必须配 when 守卫；④ 键盘优先必须有反馈（操作成功=节点微高亮，键位无效=节点抖动），无反馈记不住键。

## 8. 参考资源

- React Flow 文档：https://reactflow.dev （API/示例全在这）
- 撤销恢复：https://reactflow.dev/examples/interaction/undo-redo
- 保存恢复：https://reactflow.dev/examples/interaction/save-and-restore
- PNG 导出：https://reactflow.dev/examples/export/download-image（html-to-image）
- FastGPT（中文生产实现，参考右键菜单/节点交互工程化）：https://github.com/labring/FastGPT
- 生态事实：扣子/Dify/Langflow 的画布都是 React Flow；官方 UI 组件 reactflow.dev/ui 需 Tailwind（本项目不用，仅可参考样式）

## 9. 风险表

| 风险 | 等级 | 对策 |
|---|---|---|
| React Flow 样式与 DSH 宿主冲突 | 中 | style.css 作用域较独立，Phase 1 实测；冲突则加容器 class 前缀隔离 |
| bundle 增量 ~1.2MB | 低 | 可接受（esbuild 打包单文件） |
| 改 bundle 后宿主缓存旧版 | 高频坑 | **每次换 bundle：重启宿主 + 禁清缓存** |
| localStorage 旧 leafer 数据残留 | 低 | 新 key `dsh-flow:v1`，旧数据不迁移（已拆除） |

## 10. 清理项（Phase 4 最后做，删前确认参数已在本文件 §7）

- `../2026-10-15_drawnix-interactions-for-leafer.md`（仓库外参考稿）
- `../2026-10-15_project-graph-interactions-for-leafer.md`（源码浅克隆 `%TEMP%\project-graph` 与仓库外 `project-graph\` 一并确认后删）
- `dsh-canvas\2026-10-15_leafer-roadmap.md`、`dsh-canvas\2026-10-15_double-click-edit-debug.md`
- `tests/diag-*`（6 个）、`tests/in-shell-*`（5 个，Leafer 时代用例）、`tests/out/`（旧截图）
- 保留：`tests/harness-interactions.mjs`（改造复用）、`src/workspace-swap.js`、全部 Excalidraw 相关
