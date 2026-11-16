# 棱镜工坊 PrismStudio · 多语言代码实验与科研文档工作台

源码仓库：[shu-huangjunjie/md-pdf-viewer](https://github.com/shu-huangjunjie/md-pdf-viewer)。

基于 **Tauri v2 + React 18 + TypeScript + Tailwind CSS + Rust** 构建的极速多语言代码开发运行与科研文档双栏工作台（安装包仅 ~15MB，冷启动毫秒级，远比 Electron / VS Code 轻巧）。

## 一键启动

直接双击项目根目录下的 **`启动应用.bat`**（自动启动 `releases\desktop\PrismStudio.exe`）。

## 核心特性

1. **单窗口「多工作空间 0ms 秒切 + 并列工作路径挂载」**：
   - **顶部多工作空间秒切栏 (`Alt+1..9` / `Ctrl+Shift+O`)**：单窗口可同时开启多个独立工作空间（每个空间拥有独立的目录树、已打开标签组与左右分屏状态），Keep-Alive 内存保活切换 `0ms` 瞬达，彻底告别反复打开多个窗口；支持双击重命名空间与重启后自动恢复会话；
   - **单空间内多路径并列挂载 (`Ctrl+Alt+O`)**：支持在同一个工作空间内 **「+并列」追加第二个/第三个项目目录**，左侧资源树同时展开多个工程，并支持跨所有并列路径统一执行 `Ctrl+P` 文件速开与 `Ctrl+Shift+F` 全文检索；
   - **智能跟随工作目录 + 终端一键切换**：按 `F5` 运行脚本或在底部终端执行命令时，工作目录（CWD）与 `PYTHONPATH` 自动跟随当前聚焦文件所属的挂载根路径，同时支持在终端栏下拉手动锁定指定路径。
2. **轻量级多语言代码编辑与实时运行（类 VS Code 精简工作台）**：
   - **多语言开箱即跑**：原生支持浏览、语法高亮编辑与一键运行 **Python (`.py`)、JavaScript (`.js`)、TypeScript (`.ts`)、PowerShell (`.ps1`)、Batch (`.bat`/`.cmd`)、Rust (`.rs`)**，同时支持编辑 `.json` / `.toml` / `.yaml` / `.cpp` / `.sql` / `.txt`；
   - **智能缩进识别与一键格式化 (`Shift+Alt+F`)**：自动识别文件 2 空格 / 4 空格缩进并绘制纵向缩进对齐参考线；内置 AST 级 Python PEP-8 自动排版引擎（打开紧凑 1 空格 / 单行分号代码也会自动无损展开），并支持 JSON / JS / TS / Rust / C++ 缩进规范化；
   - **代码与 JSON 符号大纲联动**：右侧大纲面板同时支持 Markdown 章节 (`H1~H4`) 与 Python / JS / TS / Rust 类函数 (`class` / `def` / `fn`) 及 JSON 顶层字段跳转；
   - **自动探测本地 Python 环境**：自动识别工作区 `.venv`、`D:\huangjunjie\.env\train_env`（自动注入 PyTorch/CUDA DLL 路径与 UTF-8 无缓冲流式输出）、`hjj_env`、Conda 等解释器，可在工具栏或底栏一键切换；
   - **可交互终端控制台 (`Ctrl+\``)**：底部可拖拽控制台既实时展示脚本运行输出（UTF-8 / GBK 双编码自动识别，一键终止进程树），又支持在底部 `PS >` 输入框直接执行任意命令（`↑`/`↓` 翻阅历史）。
2. **现代资源管理器与全局快速检索**：
   - **快速打开与命令面板 (`Ctrl+P` / `Ctrl+Shift+P`)**：模糊检索工作区任意文件秒开（`Ctrl+Enter` 右侧分屏打开），输入 `>` 即可快速切换主题、分屏、控制台等命令；
   - **工作区全文检索 (`Ctrl+Shift+F`)**：Rust 多线程极速扫描整个工作区文档与代码，点击匹配行直接打开文件并精准跳转到对应行号；
   - **右键文件管理与细分筛选**：左侧栏可自由拖拽宽度，将脚本代码 (`PY`/`JS`/`TS`/`RS`/`PS1`) 与配置文件 (`JSON`/`CFG`/`TXT`) 清晰分离，支持新建文件/文件夹、重命名、删除、一键全部展开/折叠。
3. **科研级 Markdown 全语法离线渲染与阅读增强**：
   - **LaTeX 数学公式 & Mermaid 图表 & GitHub 提示框**：内置离线 KaTeX 引擎与懒加载 Mermaid SVG 缓存；代码块自带 **`▶ 运行代码`** 按钮；
   - **阅读体验升级**：顶部阅读进度细条、字数与预计阅读时长统计、`Ctrl+F` 页内无损高亮查找、一键打印/导出 PDF、源码编辑与预览一键互切。
4. **科研级 PDF 批注工作台 & 一键 PDF 转 Markdown**：
   - 支持连续跨行文本高亮、波浪下划线、图表/公式框选截图批注、图钉批注、5 色标签、多轮评论回复与已解决状态过滤（批注自动持久化至本地 `.annotations.json`）；
   - 支持 **「PDF 转 MD」** 一键提取文档标题层级、列表、代码块与批注摘要并在右侧分屏实时预览保存。
5. **可调比例双栏同屏对照 & 全局自由缩放**：
   - 开启 **「双栏对照」** 后可自由拖拽中间分界线调整左右比例（双击恢复 50% 等宽）；支持 **`Ctrl + 鼠标滚轮`** 无级放大缩小文字与界面。
6. **与 Context Vault (`AI Session Tools`) 双向深度互通 (`Ctrl+Shift+A`)**：
   - **侧栏「AI 会话」面板**：自动关联当前工作空间（含所有并列挂载目录）对应的 Antigravity / Claude / Codex 历史会话，支持 FTS5 全文搜索、一键以 LaTeX / Mermaid 精排笔记打开或右侧双栏对照研读，并可一键唤醒 `Context-Vault.exe` 定位到对应会话或项目；
   - **单实例跨应用极速桥接**：从 `Context Vault` 打开工程、点击 `file:///...#L42` 行号链接、一键送入代码块运行或精排整段会话时，自动通过本地鉴权回环通道复用已运行的 `PrismStudio` 单窗口（自动新建空间或并列挂载目录），绝不重复弹出多余窗口。

## 常用快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + Shift + O` | 在「新工作空间」中打开文件夹（保留当前空间与标签页） |
| `Ctrl + Alt + O` | 向当前工作空间「追加并列文件夹」（同屏对照多工程） |
| `Ctrl + Shift + A` | 打开当前工程关联的 AI 历史会话面板（Context Vault 联动） |
| `Alt + 1..9` / `Ctrl + Alt + ←/→` | 0ms 秒切不同工作空间会话 |
| `Ctrl + P` | 跨所有挂载路径模糊搜索并打开文件（`Ctrl+Enter` 分屏打开） |
| `Ctrl + Shift + P` | 打开快捷命令面板（切换主题、分屏、新建代码等） |
| `Ctrl + Shift + F` | 在整个工作区所有文档与代码中全文搜索 |
| `Ctrl + F` | 当前代码页查找替换 / Markdown 讲义页内关键词查找 |
| `F5` / `Ctrl + Enter` | 立即运行当前编辑器中的代码 |
| `Shift + Alt + F` | 一键规范缩进与代码格式化 |
| `Alt + Z` | 切换代码编辑器自动换行 |
| `Ctrl + S` | 保存当前代码或 Markdown 文件 |
| `Ctrl + N` | 新建轻量 Python 临时代码页 |
| `Ctrl + W` / `鼠标中键` | 关闭当前标签页 |
| `Ctrl + Tab` | 循环切换已打开的标签页 |
| ``Ctrl + ` `` | 展开 / 收起底部运行与命令终端 |
| `Ctrl + 鼠标滚轮` / `Ctrl + 0` | 全局自由放大缩小 / 重置为 100% |
| `Ctrl + B` | 展开 / 收起左侧资源与搜索栏 |

## 开发与重新编译命令

```powershell
# 运行前端单元测试
$env:Path = "D:\huangjunjie\.env\web_node;$env:Path"
npm.cmd test

# 启动热重载桌面开发模式
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1

# 一键编译桌面版与便携版 EXE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
```
