# XtermMuxer

一个基于 **xterm.js + Electron** 的终端模拟器与**本地 terminal multiplexer**，参考 [wezterm](https://github.com/wezterm/wezterm) 的架构与交互实现：

- 多标签页 + 分屏（pane 二叉树，默认 50/50）
- 本地 shell 会话（node-pty，Windows 走 ConPTY）
- **SSH 连接**（类似 `wezterm ssh`）：内联连接进度、主机密钥 TOFU 确认、交互式认证，全部渲染在终端内
- 明确**不实现** `wezterm connect` / mux-server 等 tmux 式远程复用功能
- 优先支持 Windows；用 Electron 打包

## 功能

| 能力 | 说明 |
|---|---|
| 标签页 | 新建 / 关闭 / 循环切换 / Alt+1..9（未实现跳转，可用 Ctrl+Tab 循环）、未读输出圆点 |
| 分屏 | 上下/左右分屏（对齐 wezterm Windows 默认键位）、拖拽分隔条调比例、Alt+方向键切换焦点、Ctrl+Shift+Z 放大当前 pane |
| 复制粘贴 | 选择自动复制、Ctrl+Shift+C/V、右键/中键粘贴 |
| 搜索 | Ctrl+Shift+F 打开内联搜索框（Enter 下一个 / Shift+Enter 上一个） |
| SSH | Ctrl+Shift+S 打开连接对话框；支持 `user@host[:port]`、`~/.ssh/config`（Host 通配、Include、Match、%token 展开）、known_hosts 校验（含哈希条目）、SHA256 指纹、publickey/password/keyboard-interactive 认证、ServerAlive 保活 |
| 标题 | OSC 0/1/2 标题 + 回退标签（进程名 / user@host），窗口标题 `[idx/count] title` |
| cwd 继承 | OSC 7 捕获，新本地标签/分屏继承当前 pane 目录 |
| 配置 | `userData/config.json`（字体、主题、滚动、shell、键位） |

## 架构

```
Electron main ── IPC ── renderer (React)
  ├─ SessionManager (对标 wezterm Mux)
  │    ├─ LocalSession  (node-pty, ConPTY on Windows)
  │    └─ SshSession    (ssh2 纯 JS, 对标 wezterm-ssh)
  │         ├─ ssh-config.ts   ssh_config(5) 解析/匹配
  │         ├─ ssh-auth.ts     authHandler 交互式认证
  │         └─ known-hosts.ts  主机密钥校验/写入
  └─ renderer: tabs → pane 二叉树 → xterm.js 实例
        ├─ mux-model.ts / mux-reducer.ts   (Tab/Pane 状态机)
        ├─ split-view / terminal-pane / tab-bar / status-bar / ssh-dialog
        └─ prompt-input（内联提示行编辑, 对标 wezterm LineEditor）
```

数据流：`node-pty / ssh2 流 → session:output → xterm.write()`；键盘 `xterm.onData → session:write`；resize 经 `session:resize`。SSH 的认证/主机密钥提示通过 `session:prompt` 走终端内联输入。

## 开发

```bash
npm install        # 安装依赖；postinstall 会为 Electron 重建原生模块
npm run dev        # electron-vite 开发模式
npm run typecheck  # 类型检查
npm test           # 类型检查 + 单元测试（mux 树）+ 会话层测试
npm run build      # 构建产物到 out/
```

> **代理**：本仓库开发机走代理，`.npmrc` 已配置 `proxy=http://10.31.0.22:8888` 与 `electron_mirror`（npmmirror）。

> **原生编译**：node-pty 需要按 Electron ABI 编译。本开发机系统 g++（7.5）不支持 C++20，`.npmrc` 配置了便携版 Python 3.11 与 **zig** 工具链（`scripts/rebuild-native.js` 自动选用）。在普通开发机（Windows + VS Build Tools / Linux + gcc ≥ 9）上，去掉 zig 相关配置后 `npm run rebuild` 即可。

## 默认键位（对齐 wezterm Windows 默认）

| 动作 | 键位 |
|---|---|
| 新标签页 | `Ctrl+Shift+T` |
| 新 SSH 连接 | `Ctrl+Shift+S` |
| 上下分屏（top/bottom） | `Ctrl+Shift+Alt+'`（即 `"`） |
| 左右分屏（left/right） | `Ctrl+Shift+Alt+5`（即 `%`） |
| 关闭焦点 pane（末个则关标签页） | `Ctrl+Shift+W` |
| 上一个 / 下一个标签页 | `Ctrl+PageUp` / `Ctrl+PageDown`，`Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 焦点移动 | `Alt+方向键` |
| 放大当前 pane | `Ctrl+Shift+Z` |
| 复制 / 粘贴 | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| 搜索 | `Ctrl+Shift+F` |

## 配置

`config.json` 位于 `app.getPath('userData')`（Windows: `%APPDATA%\XtermMuxer\config.json`），深合并默认值：

```jsonc
{
  "shell": { "path": "powershell.exe", "args": ["-NoLogo"] }, // 默认 Windows=%ComSpec%(cmd.exe)
  "font": { "family": "Cascadia Mono", "size": 14, "lineHeight": 1.15 },
  "theme": { "mode": "system" }, // system | light | dark，可自定义 colors
  "scrollback": 10000,
  "window": { "width": 1100, "height": 700, "title": "XtermMuxer" }
}
```

SSH 参数优先读取 `~/.ssh/config`；`ConnectTimeout`、`ServerAliveInterval/CountMax` 等指令被解析并映射到 ssh2 对应选项（对齐 wezterm-ssh）。与 wezterm 一致，**不实现 ProxyJump**。

## 打包

```bash
npm run pack          # electron-vite build + electron-builder --dir（本机平台）
npm run dist:win      # 在 Windows 上产出 NSIS 安装包
npm run dist:linux    # 本机产出 AppImage
```

- Windows 安装包需在 **Windows 机器**上构建（node-pty 的 Windows 二进制必须针对 Electron ABI 在目标平台编译；`electron-builder.yml` 已配 `npmRebuild: true`）。
- 图标由 `scripts/make-icon.js` 生成到 `build/icon.png`，electron-builder 自动派生 .ico。

## 测试

- `npm run test:unit`：mux 树/ reducer 纯 JS 单测（分屏、折叠、焦点导航、标签生命周期）。
- `npm run test:sessions`：在 Electron（无窗口）下跑 ssh_config 解析、known_hosts（含哈希条目）、node-pty 本地会话、SSH 端到端流程（主机密钥 TOFU + 认证提示 + 错误路径，连接本机 sshd 验证）。

## 已知限制

- 不做 tmux 式远程复用（`wezterm connect` / mux-server）。
- `Match exec` / `canonical` 不实现（同 wezterm-ssh）；`ProxyJump` 不实现（同 wezterm）。
- 搜索为当前 pane 内搜索，未做跨会话。
- 无自定义键位覆盖 UI（`keys` 配置项预留）。
