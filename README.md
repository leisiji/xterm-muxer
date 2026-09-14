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
| 标签页 | 顶部标签栏（高度 = 字体大小 × 行高，随字号设置自动调整；新建 / 关闭 / 循环切换 / 未读输出圆点）；Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PageUp·PageDown 循环 |
| 启动 | 默认**不打开任何 pane**，显示空状态；用 `Ctrl+Shift+T` / 标签栏 `+` 开本地终端，`Ctrl+Shift+S` 连 SSH |
| 分屏 | 上下/左右分屏（对齐 wezterm Windows 默认键位）、拖拽分隔条调比例、Alt+方向键切换焦点、Ctrl+Shift+Z 放大当前 pane；同一 tab 内非焦点 pane 自动变暗（dim） |
| Leader 键 | 类似 tmux 的 prefix：`Alt+N` 进入 leader 模式，`-` 上下分屏（vertical）、`Shift+-` 左右分屏（horizontal）、`c` 新建标签页、`x` 关闭当前 pane、`z` 放大/还原 pane、`,` 重命名当前标签页、`n`/`p` 下一个/上一个标签页、`1`-`9` 跳到第 N 个标签页、`h`/`j`/`k`/`l` 切换 pane 焦点、`r` 进入 resize 模式（再用 `h/j/k/l` 调整 pane 大小），2s 无后续按键自动退出 |
| 快捷键（对齐 wezterm 配置） | `Alt+m` 切回上一个标签页（`ActivateLastTab`）、`Alt+p` 切换到下一个 pane（`ActivatePaneDirection("Next")`）、`Alt+方向键` 按方向切换 pane |
| 复制粘贴 | 选中自动复制（`copyOnSelect`，默认开启）、Ctrl+Shift+C/V、右键/中键粘贴；支持 **OSC 52**（tmux `set-clipboard on`、nvim `clipboard=osc52`、SSH 远端复制到本地剪贴板），始终开启，仅实现写方向 —— `?` 读取请求会被拒绝，避免远端反过来取走本地剪贴板。**Windows 本地会话下 ConPTY 会丢弃该序列**，SSH 会话不受影响，见「ConPTY 与转义序列」 |
| 搜索 | Ctrl+Shift+F 打开浮动搜索框（Enter 下一个 / Shift+Enter 上一个，无底部状态栏） |
| SSH | Ctrl+Shift+S 打开连接对话框；支持 `user@host[:port]`、`~/.ssh/config`（Host 通配、Include、Match、%token 展开）、known_hosts 校验（含哈希条目）、SHA256 指纹、publickey/password/keyboard-interactive 认证、ServerAlive 保活 |
| 保存 SSH 配置 | 对话框内可勾选 “Save this connection” 保存 host/user/port/identity 为连接配置；下次打开对话框即列出，一键回填/连接，可删除（密码永不写入磁盘） |
| SSH 会话继承 | 在 SSH pane 上新建分屏/标签页会复用**同一个已认证的 SSH 连接**（对齐 wezterm `RemoteSshDomain`：一个连接、每个 pane 一条 channel），因此不会再次要求输入密码，并**落在当前 pane 所在的远端目录**；配置 `ssh.defaultTarget` 后，启动/新建默认走 SSH 而非本地 shell |
| 退出行为 | 会话退出 / SSH 断开时按 `exitBehavior` 自动关闭 pane（默认 `closeOnCleanExit`：正常退出或已连接的会话断开则关闭，连接失败则保留错误信息），最后个 pane 关闭时窗口自动关闭 |
| 标题 | OSC 0/1/2 标题 + 回退标签（进程名 / user@host），窗口标题 `[idx/count] title` |
| 窗口 | Windows/Linux 移除原生 File/Edit/View/Window 菜单栏（避免与 Alt 快捷键冲突；macOS 保留标准 app menu）；`Alt+Enter` 切换全屏（隐藏系统标题栏） |
| cwd 继承 | OSC 7 捕获，新标签/分屏继承当前 pane 的目录；**SSH 也支持**（见下方「SSH 目录继承」），本地会话在 Windows 下受 ConPTY 限制 |
| 滚动条 | 由 `@xterm/xterm` 6 内置提供（VS Code 的 SmoothScrollableElement），悬浮覆盖、滚动/悬停时自动显隐，配色取主题前景色。宽度固定在 14px，可用终端选项 `overviewRuler.width` 调整（注意该选项会一并启用 overview ruler）。**不占用右侧宽度**：终端铺满整宽（见 `fitFullWidth`） |
| Copy mode | `Alt+X` 进入（对标 wezterm copy_mode / vim）：`hjkl` 移动、`w/b/e` 词移动（`Alt+w/b/e` 步进 5 次）、`H/L/^` 行首/行尾/首个非空、`g/G` 缓冲首/尾、`Ctrl+u/d` 翻页、`v/V/Ctrl+v` 字符/行/块选择、`y` 复制并退出、`/` 搜索、`n/N` 下/上一个匹配、`q`/`Esc` 退出；底部显示 COPY HUD |
| Quick select | `Alt+I`（wezterm `QuickSelectArgs`）：扫描可见区域，为匹配项叠加字母标签（URL / 路径 / `[\w./-]+`，对齐 wezterm 内置 pattern），输入标签即复制该项并退出，`Esc`/`Ctrl+C` 取消 |
| 鼠标跟随焦点 | `pane_focus_follows_mouse`：鼠标移入哪个 pane 就聚焦它（设置对话框可开关，默认开） |
| 内联图片 | `@xterm/addon-image`（iTerm IIP + SIXEL），每 pane 32MB 缓存，始终开启。本地会话设 `TERM_PROGRAM=vscode`（yazi 据此选 IIP，否则回退 chafa 无真图），SSH 会话以 env request 尽力传递（受服务端 `AcceptEnv` 限制）。**注意 Windows 本地会话受限**：ConPTY 会丢弃它不实现的转义序列，见下方「ConPTY 与转义序列」 |
| 配置 | `userData/config.json`（字体、主题、滚动历史、shell、键位、copyOnSelect、focusFollowsMouse、tabBar.position）；`Ctrl+,` 打开设置对话框可实时调整字体/字号/**history limit**/鼠标跟随焦点/标签栏位置（默认 **Maple Mono NF CN**、10000 行、标签栏在顶部） |

## 架构

```
Electron main ── IPC ── renderer (React)
  ├─ SessionManager (对标 wezterm Mux)
  │    ├─ LocalSession  (node-pty, ConPTY on Windows)
  │    └─ SshSession    (ssh2 纯 JS, 对标 wezterm-ssh)
  │         ├─ ssh-connection.ts  按目标复用的连接池 (对标 RemoteSshDomain)
  │         ├─ ssh-config.ts   ssh_config(5) 解析/匹配
  │         ├─ ssh-auth.ts     authHandler 交互式认证
  │         └─ known-hosts.ts  主机密钥校验/写入
  └─ renderer: tabs → pane 二叉树 → xterm.js 实例
        ├─ mux-model.ts / mux-reducer.ts   (Tab/Pane 状态机)
        ├─ split-view / terminal-pane / tab-bar / ssh-dialog / settings-dialog / overlays（底部状态栏已移除）
        ├─ copy-mode.ts  (vim/wezterm copy mode 纯逻辑，Alt+X)
        ├─ quick-select.ts (wezterm QuickSelect 匹配/标签纯逻辑，Alt+I)
        └─ osc52.ts  (OSC 52 剪贴板 payload 解码纯逻辑)
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

> **镜像源**：两个镜像 key 分处两地，因为消费时机不同。
> `electron_mirror`（npmmirror）留在 `.npmrc`：它在 `npm install` 阶段由 **electron 包自己的 postinstall** 读取，而 npm 只为「正在运行脚本的那个包」注入 `npm_package_config_*`，放进本仓库 package.json 的 `config` 读不到，会静默退回 GitHub。
> `electron_builder_binaries_mirror` 则放在 package.json 的 `config` 里：它由 `npm run dist:*` 这个根脚本读取，`npm_package_config_*` 是有的。
> npm 目前对 `.npmrc` 里的 `electron_mirror` 会报一条 "Unknown project config" 警告，下个大版本将失效；届时改用 `ELECTRON_MIRROR` 环境变量（`@electron/get` 同样识别）。

> **原生编译**：node-pty 需要按 Electron ABI 编译。`scripts/rebuild-native.js` 会自动探测 **zig**（`ZIG_PATH`、`~/zig160/zig`）与 Python（`PYTHON` / `NODE_GYP_FORCE_PYTHON`，或常见安装路径）—— 都不在 `.npmrc` 里配。找不到 zig 就回退默认工具链；此时需要系统编译器支持 C++20（Windows + VS Build Tools 或 Linux + gcc ≥ 9）。

## 默认键位（对齐 wezterm Windows 默认）

| 动作 | 键位 |
|---|---|
| 新标签页 | `Ctrl+Shift+T` |
| 新 SSH 连接 | `Ctrl+Shift+S` |
| 上下分屏（top/bottom） | `Ctrl+Shift+Alt+'`（即 `"`） |
| 左右分屏（left/right） | `Ctrl+Shift+Alt+5`（即 `%`） |
| 关闭焦点 pane（末个则关标签页） | `Ctrl+Shift+W` |
| 上一个 / 下一个标签页 | `Ctrl+PageUp` / `Ctrl+PageDown`，`Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 焦点移动 | `Alt+方向键`；`Alt+p` 下一个 pane；`Alt+N` 然后 `h`/`j`/`k`/`l` 按方向切换 pane |
| 切回上一个标签页 | `Alt+m` |
| 放大当前 pane | `Ctrl+Shift+Z` |
| 复制 / 粘贴 | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| 搜索 | `Ctrl+Shift+F` |
| Copy mode | `Alt+X` 进入 / 退出当 pane 的 copy mode |
| Quick select | `Alt+I` 进入 quick select，输入字母标签复制对应内容 |
| 设置（字体/字号） | `Ctrl+,` |
| 全屏（隐藏系统标题栏） | `Alt+Enter` |
| **Leader 键** | `Alt+N` 进入 leader 模式（屏幕底部浮层显示可用命令，2s 超时） |
| ├ vertical pane（上下分屏） | `Alt+N` 然后 `-`（tmux `split-window -v`） |
| ├ horizontal pane（左右分屏） | `Alt+N` 然后 `Shift+-`（tmux `split-window -h`） |
| ├ 新标签页 | `Alt+N` 然后 `c` |
| ├ 关闭当前 pane | `Alt+N` 然后 `x` |
| ├ 放大 / 还原当前 pane | `Alt+N` 然后 `z`（wezterm `TogglePaneZoomState`） |
| ├ 重命名当前标签页 | `Alt+N` 然后 `,`（wezterm `PromptInputLine`，留空恢复自动标题） |
| ├ 下一个 / 上一个标签页 | `Alt+N` 然后 `n` / `p` |
| ├ 按方向切换 pane | `Alt+N` 然后 `h`/`j`/`k`/`l`（`ActivatePaneDirection`） |
| ├ 调整 pane 大小 | `Alt+N` 然后 `r` 进入 resize 模式，再用 `h`/`j`/`k`/`l` 调整（`Esc` 或 1s 后退出） |
| └ 跳到第 N 个标签页 | `Alt+N` 然后 `1`..`9`（wezterm `LEADER+1..9` → `ActivateTab`） |

## 配置

`config.json` 位于 `app.getPath('userData')`（Windows: `%APPDATA%\XtermMuxer\config.json`），深合并默认值：

```jsonc
{
  "shell": { "path": "powershell.exe", "args": ["-NoLogo"] }, // 默认 Windows=%ComSpec%(cmd.exe)
  "font": { "family": "Maple Mono NF CN", "size": 14, "lineHeight": 1.15 }, // 也可用 Ctrl+, 图形化调整
  "theme": { "mode": "system" }, // system | light | dark，可自定义 colors
  "scrollback": 10000, // 滚动历史行数（history limit），也可用 Ctrl+, 调整
  "window": { "width": 1100, "height": 700, "title": "XtermMuxer" },
  // 标签栏位置：top（默认，窗口顶部）| bottom（窗口底部），也可用 Ctrl+, 调整。
  "tabBar": { "position": "top" },
  // 鼠标选中即自动复制到剪贴板（默认 true）；设为 false 则只能用 Ctrl+Shift+C 复制。
  "copyOnSelect": true,
  // 鼠标移入即聚焦该 pane（wezterm pane_focus_follows_mouse，默认 true）。
  "focusFollowsMouse": true,
  // 会话退出 / SSH 断开时的行为：close | closeOnCleanExit | hold（默认 closeOnCleanExit）
  //   close            总是关闭 pane
  //   closeOnCleanExit 正常退出(code 0)或曾连接过的会话断开时关闭；
  //                    连接/认证失败（从未连上）则保留 pane 显示错误
  //   hold             从不自动关闭，保留 pane 显示 “Session ended”
  // 关闭最后一个 pane 时会同时关闭窗口。
  "exitBehavior": "closeOnCleanExit",
  // 通过 SSH 对话框保存的连接（password 不落盘）
  "ssh": {
    // 设置后，新建标签页 / 分屏 / 启动时的 session 默认走 SSH（而不是本地 shell）。
    // 值可以是 user@host[:port]、主机名或 ~/.ssh/config 里的 Host 别名。
    "defaultTarget": "deploy@prod.example.com",
    "hosts": [
      { "id": "…", "name": "web", "host": "example.com", "user": "root", "port": 2222, "identity": "~/.ssh/id_ed25519" }
    ]
  }
}
```

SSH 参数优先读取 `~/.ssh/config`；`ConnectTimeout`、`ServerAliveInterval/CountMax` 等指令被解析并映射到 ssh2 对应选项（对齐 wezterm-ssh）。与 wezterm 一致，**不实现 ProxyJump**。

**新建 pane/tab 的会话继承规则**：

1. 当前 pane 是 SSH → 新 pane/tab 继承同一 SSH 连接（同一 host/identity）；
2. 否则若配置了 `ssh.defaultTarget` → 使用该默认 SSH 目标；
3. 否则使用本地 shell。

同一个 SSH 目标（user/host/port/identity 相同）只会建立**一条**连接：首次 pane 完成主机密钥确认与认证后，后续继承出的分屏/标签页直接在该连接上打开新的 shell channel，**不再要求输入密码或重新校验主机密钥**（对齐 wezterm 的 `RemoteSshDomain`，见 `mux/src/ssh.rs` 的 `spawn_pane`）。连接断开后，下一个新 pane 会重新连接并再次认证（同 wezterm）。

通过 SSH 对话框输入的密码仍会在**内存中保留本次运行期间**，供连接重建时自动重认证（不写入磁盘）；若未提供密码，则由 ssh-agent / 密钥或终端内联提示完成认证。

**SSH 目录继承**：SSH pane 同样跟踪当前目录，在它上面分屏/新建标签页会落在同一目录 —— 与本地一致，
应用只**消费** OSC 7，不向远端会话注入任何东西（同 wezterm / Windows Terminal：目录由 shell 侧上报，
终端侧不碰远端 shell）。

- **上报在远端**：需要远端 shell 自己发 OSC 7。这是 shell 侧的配置，**不是本应用做的** —— 可以用现成的，
  也可以自己加一行：
  ```sh
  # ~/.bashrc（远端）
  __osc7() { printf '\033]7;file://%s%s\033\\' "${HOSTNAME-}" "$PWD"; }
  PROMPT_COMMAND="__osc7${PROMPT_COMMAND:+;${PROMPT_COMMAND[*]}}"
  ```
  zsh 把第二行换成 `precmd_functions+=(__osc7)`；fish / 提示符框架大多自带。也可以直接把
  [wezterm.sh](https://github.com/wezterm/wezterm/blob/main/assets/shell-integration/wezterm.sh)
  拷到远端 `source`（没有 `wezterm` 二进制时它自动回退到纯 `printf`，不依赖远端装 wezterm）。
  验证：远端 `__osc7 | cat -v` 应打出一段 `^[]7;file://<host>/<cwd>^[\`（序列本身不可见）；在本应用里
  远端 `cd` 之后分屏，新 pane 落在当前目录即可。
- **落地在本应用**：`cd` 由 exec 包装进程完成，而不是往交互式 shell 里敲命令 —— ssh2 的 `shell`/`exec`
  都不接受 cwd 参数，所以带 cwd 的新 pane 走 `exec` 通道运行 `cd -- '<cwd>' 2>/dev/null; exec "$SHELL" -l`
  （对标 wezterm-ssh 的 `cd && exec` 做法）。这行 `cd` 因此既不出现在终端里，也不进远端 history；
  `-l` 复现 sshd 对普通 shell channel 的登录 shell 语义（`/etc/profile`、`~/.bash_profile` 照常执行）。
  服务端拒绝 exec 请求时回退为普通 shell + 敲入 `cd`（降级路径，这一行会可见）。
- **没有上报时会怎样**：远端不发 OSC 7 时 pane 的 cwd 一直是未知，继承不出任何东西 —— 新 pane 的创建路径
  与 `ssh host` **逐字节相同**（普通 shell channel，不敲任何命令、不改远端环境），落点就是登录目录。

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
- `npm run test:sessions`：在 Electron（无窗口）下跑 ssh_config 解析、known_hosts（含哈希条目）、node-pty 本地会话、SSH 端到端流程（主机密钥 TOFU + 认证提示 + 错误路径，连接本机 sshd 验证）、cwd 继承（exec 包装落地 + 服务端拒绝 exec 时的回退，用内置 ssh2 假服务端验证：命令串里的 `cd` 带正确转义，且包装路径**不向会话写入任何内容**）。

## 已知限制

- 不做 tmux 式远程复用（`wezterm connect` / mux-server）。
- `Match exec` / `canonical` 不实现（同 wezterm-ssh）；`ProxyJump` 不实现（同 wezterm）。
- 搜索为当前 pane 内搜索，未做跨会话。
- 无自定义键位覆盖 UI（`keys` 配置项预留）。

### ConPTY 与转义序列（Windows 本地会话）

ConPTY 不是一根透传字节的管子：conhost 自己解析子进程的 VT 输出、渲染进屏幕缓冲区，再把「它自己的渲染结果」发给终端。因此**它实现的序列会被规范化后重发，它不实现的序列会被直接丢弃**。

在本机（Windows 10 LTSC 2019 / 17763）用真实 ConPTY 实测：子进程写出的 `OSC 7`（cwd）、`OSC 52`（剪贴板）、`OSC 1337`（iTerm 图片）、`CSI 16t`（单元格尺寸查询）、kitty graphics APC 全部**到达终端时已消失**；`SGR`（如 `ESC[31m`）则以规范化形式 `ESC[0;31m` 重发；`OSC 0/1/2`（标题）由 conhost 实现，能正常透出。`useConpty: false`（winpty）结果相同，`useConptyDll: true`（node-pty 自带 ConPTY 1.23）实测仍未改变——透传还需客户端侧协商。

影响与对策：

- **Windows 本地会话**：任何依赖上述序列的功能都失效 —— yazi 图片预览、OSC 52、以及工具主动上报 cwd。这与应用代码无关，是平台层限制。
- **SSH 会话不受影响**：字节流走 libssh2，不经过 ConPTY，`OSC 1337`/`OSC 52`/`OSC 7` 都能原样到达。远端 yazi 出图是可行的（前提是服务端 `AcceptEnv` 放行 `TERM_PROGRAM`）。
- **Linux / macOS**：无 ConPTY，不受此限。
- 参考：[mintty#1192](https://github.com/mintty/mintty/issues/1192)（结论是「ConPTY 支持 passthrough 之前无解」）、[windows/terminal#19926](https://github.com/microsoft/terminal/issues/19926)（透传带来的光标漂移问题）、[Rio 的 Windows 说明](https://rioterm.com/ko/docs/install/windows)。透传需要 ConPTY 1.22+（Windows Terminal 项目版本），且要由终端侧协商启用。
