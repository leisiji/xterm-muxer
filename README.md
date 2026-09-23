# XtermMuxer

A terminal emulator and **local terminal multiplexer** built on **xterm.js + Electron**, modelled
after [wezterm](https://github.com/wezterm/wezterm)'s architecture and interaction model.

- Tabs and splits (a binary pane tree, 50/50 by default)
- Local shell sessions through node-pty (ConPTY on Windows)
- **SSH connections** (like `wezterm ssh`): inline connection progress, host-key TOFU confirmation and
  interactive authentication, all rendered inside the terminal
- tmux-style **leader key** for mux commands
- vim-style **copy mode** and wezterm-style **quick select**
- Deliberately **not** implementing `wezterm connect` / mux-server style remote multiplexing
- Windows first; packaged with Electron

This document is the user manual. If you just want to get running, read
[Getting started](#getting-started) and the [key reference](#key-reference).

## Contents

- [Requirements](#requirements)
- [Installing](#installing)
- [Getting started](#getting-started)
- [Tabs](#tabs)
- [Panes and splits](#panes-and-splits)
- [Selecting, copying and pasting](#selecting-copying-and-pasting)
- [Searching](#searching)
- [Scrolling and scrollback](#scrolling-and-scrollback)
- [Copy mode](#copy-mode)
- [Quick select](#quick-select)
- [Word selection by double-click](#word-selection-by-double-click)
- [Mouse focus follows the pointer](#mouse-focus-follows-the-pointer)
- [Right-click and the pane menu](#right-click-and-the-pane-menu)
- [Inline images](#inline-images)
- [Font ligatures](#font-ligatures)
- [SSH connections](#ssh-connections)
- [Session exit behavior](#session-exit-behavior)
- [Windows and titles](#windows-and-titles)
- [Settings dialog](#settings-dialog)
- [Keybindings](#keybindings)
- [Configuration file](#configuration-file)
- [Key reference](#key-reference)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Appendix A: Architecture](#appendix-a-architecture)
- [Appendix B: Building, running and testing](#appendix-b-building-running-and-testing)

## Requirements

| | |
|---|---|
| OS | Windows 10/11 (primary), Linux, macOS |
| Runtime | Electron 44 (bundled; nothing to install for packaged builds) |
| Building from source | Node.js 20+, npm, and a C++20 compiler for node-pty (see [Native rebuilds](#native-rebuilds)) |
| SSH | A reachable `sshd`, or nothing at all if you only use local shells |

## Installing

There is no published installer yet. Build from source:

```bash
git clone <this repo> xterm-muxer
cd xterm-muxer
npm install        # postinstall rebuilds native modules for Electron
npm run dev        # launches the app in electron-vite dev mode
```

To produce a distributable package instead, see
[Packaging](#packaging).

## Getting started

### First launch

The app starts with **no panes open** — you get an empty state rather than an automatic shell.
Open something with one of:

| Action | Keys |
|---|---|
| New local terminal | `Ctrl+Shift+T`, or the `+` button in the tab bar |
| New SSH connection | `Ctrl+Shift+S` |

### Your first terminal

1. Press `Ctrl+Shift+T`. A local shell appears.
2. Press `Ctrl+Shift+Alt+'` to split the pane top/bottom, or `Ctrl+Shift+Alt+5` to split it
   left/right. The new pane inherits the current pane's working directory.
3. Press `Alt+Arrow` to move focus between panes. The focused pane is drawn at full brightness —
   unfocused panes in the same tab are dimmed.
4. Press `Ctrl+,` to open the settings dialog and change the font, font size, history limit,
   focus-follows-mouse and tab bar position. Changes apply live.

### Your first SSH connection

1. Press `Ctrl+Shift+S`. A connection dialog opens.
2. Type `user@host`, `user@host:port`, a bare hostname, or a `Host` alias from `~/.ssh/config`.
3. Tick **Save this connection** if you want it listed next time. Passwords are never written to
   disk.
4. Connect. Host-key confirmation, password prompts and keyboard-interactive challenges all appear
   **inline in the terminal**, not as native dialogs.

See [SSH connections](#ssh-connections) for the full story.

## Tabs

The tab bar sits at the top of the window by default (move it to the bottom in settings, or via
`tabBar.position`). Its height tracks the font size and line height.

- **New tab**: `Ctrl+Shift+T`, or the `+` button.
- **Close**: `Ctrl+Shift+W` closes the focused pane; when it is the last pane in the tab, the tab
  closes.
- **Switch**: `Ctrl+Tab` / `Ctrl+Shift+Tab`, or `Ctrl+PageDown` / `Ctrl+PageUp` — both cycle.
- **Jump to tab N**: `Alt+N` then `1`–`9`.
- **Last tab**: `Alt+m` returns to the tab you came from (`ActivateLastTab`).
- **Rename**: `Alt+N` then `,` (`PromptInputLine`). Leave it blank to restore the automatic title.
- **Unread output**: a dot appears on a tab that produced output while it was not focused.

Titles come from OSC 0/1/2 title escapes, falling back to the process name (local) or `user@host`
(SSH). The window title is `[idx/count] title`.

## Panes and splits

A tab holds a binary tree of panes. Splitting always divides the focused pane 50/50, and you can
drag the divider afterwards.

| Action | Keys |
|---|---|
| Split top/bottom | `Ctrl+Shift+Alt+'` (i.e. `"`), or `Alt+N` then `-` |
| Split left/right | `Ctrl+Shift+Alt+5` (i.e. `%`), or `Alt+N` then `Shift+-` |
| Move focus by direction | `Alt+Arrow` |
| Next pane | `Alt+p` (`ActivatePaneDirection("Next")`) |
| Focus by direction (leader) | `Alt+N` then `h`/`j`/`k`/`l` |
| Zoom / unzoom the pane | `Ctrl+Shift+Z`, or `Alt+N` then `z` |
| Resize | `Alt+N` then `r`, then `h`/`j`/`k`/`l` |
| Close the pane | `Ctrl+Shift+W`, or `Alt+N` then `x` |

**Moving focus by direction** picks the nearest pane that way, and remembers the move: pressing the
opposite direction straight after returns to the pane it came from. That matters wherever geometry
has no answer — with one pane on the left and two stacked on the right, both right-hand panes are the
same distance from the left one, so `left` and then `right` would otherwise land in whichever of the
two the tree happens to list first instead of the one you were in. The memory is narrow: it applies
only to the pane the move landed in, only in the opposite direction, and only while that pane is
still open. Any other focus change in between — a click, a tab switch, a split — makes it stale, and
the nearest pane wins again.

Resize mode exits on `Esc` or after one second without a keypress. Closing the last pane of the
last tab closes the window.

While a zoom is active, dividers are hidden and the zoomed pane fills the tab.

**Session inheritance for new panes and tabs** follows three rules, in order:

1. If the current pane is an SSH session, the new pane/tab reuses the same authenticated connection.
2. Otherwise, if `ssh.defaultTarget` is configured, the new pane uses that SSH target.
3. Otherwise, a local shell.

**Working directory inheritance**: new panes and tabs start in the current pane's directory. This
works for local sessions (where the shell reports it via OSC 7) and for SSH sessions — see
[SSH directory inheritance](#ssh-directory-inheritance).

**Sizing contract**: the pty size always equals the pane's character grid. For remote ptys, the
channel is opened at the grid size current at that moment (authentication can take seconds, and
fits during it are not lost); if the size changes again after the channel opens, a `window-change`
is sent. The renderer re-syncs once the session id is ready — so a pty never starts smaller than its
pane and catches up only by redrawing.

## Selecting, copying and pasting

| Action | Keys |
|---|---|
| Copy | `Ctrl+Shift+C` |
| Paste | `Ctrl+Shift+V` or middle-click |
| Copy on select | Automatic (on by default) |

**Copy on select** is controlled by `copyOnSelect` (default `true`). With it enabled, releasing the
mouse over a selection puts it straight on the clipboard. Set it to `false` if you prefer to copy
explicitly with `Ctrl+Shift+C`.

**OSC 52** let remote programs write to your local clipboard. It is always enabled and
**write-only**: a `?` read request is refused, so a remote host cannot pull your clipboard. This is
what makes tmux (`set-clipboard on`), nvim (`clipboard=osc52`) and remote copies work over SSH.

> On **Windows local sessions**, ConPTY silently drops OSC 52. SSH sessions are unaffected. See
> [ConPTY and escape sequences](#windows-local-sessions-conpty-and-escape-sequences).

## Searching

Press `Ctrl+Shift+F` for a floating search box. `Enter` jumps to the next match, `Shift+Enter` to
the previous one. There is no bottom status bar — search is scoped to the focused pane, not across
sessions.

## Scrolling and scrollback

Scrolling is provided by the `@xterm/xterm` 6 built-in scrollbar (VS Code's
`SmoothScrollableElement`): an overlay that appears on hover/scroll and hides itself again, tinted
from the theme's foreground color.

- **History limit**: `scrollback` in the config, default **10000** lines. Adjustable live in the
  settings dialog (`Ctrl+,`).
- **Width**: fixed at 14px by default. The terminal option `overviewRuler.width` can change it —
  but note that setting it also enables the overview ruler.
- The scrollbar **does not steal width** from the terminal; the terminal spans the full pane width
  (`fitFullWidth`).

## Copy mode

`Alt+X` enters copy mode for the focused pane (wezterm's `copy_mode`, vim-flavoured). While it is
active the pane owns every keystroke, so nothing leaks to the shell. `Alt+X` again leaves it. A
`COPY` HUD is shown at the bottom of the pane.

| Key | Action |
|---|---|
| `h` `j` `k` `l` | Move |
| `w` `b` `e` | Word motion (`Alt+w`/`b`/`e` steps 5 times) |
| `H` `L` `^` | Start of line / end of line / first non-blank |
| `g` `G` | Start / end of the scrollback buffer |
| `Ctrl+u` `Ctrl+d` | Page up / page down |
| `v` `V` `Ctrl+v` | Character / line / block selection |
| `y` | Copy the selection and exit |
| `/` | Search |
| `n` `N` | Next / previous match |
| `q` `Esc` | Exit |

## Quick select

`Alt+I` starts quick select (wezterm's `QuickSelectArgs`). The visible area is scanned and each
match is overlaid with a letter label. Type a label to copy that item and exit; `Esc` or `Ctrl+C`
cancels.

The built-in patterns mirror wezterm's: URLs, paths, and `[\w./-]+`. Word selection by double-click
uses the same pattern set (see below).

## Word selection by double-click

Double-clicking a "word" uses **the same tokenizer as quick select** (`matchAtColumn` reuses the
pattern from `findMatches`), so paths like `/usr/local/foo.cc`, URLs and `foo_bar` are selected
whole. `:` remains a separator, so the line number in `foo.cc:12` is a separate word. Double-clicking
whitespace finds no match and falls back to xterm's own behavior. If `copyOnSelect` is on, the word
is copied immediately.

## Mouse focus follows the pointer

`focusFollowsMouse` (default on, toggleable in the settings dialog) focuses whichever pane the
pointer **moves into** — wezterm's `pane_focus_follows_mouse`.

It follows *movement*, not *position*: when the window returns to the foreground (Alt+Tab back, or
clicking the taskbar) the browser re-emits a `mouseenter`/`mousemove` at the same coordinates. That
is not a move, so focus is not stolen from the pane you were typing in. Likewise a newly created
split that happens to appear under the cursor does not grab focus.

## Right-click and the pane menu

Right-click belongs to the **terminal application** whenever that application has asked for the
mouse, and to the **muxer** when it has not.

A program that enables mouse tracking (`CSI ? 1000 h` and friends — htop, lazygit, `vim` with
`set mouse=a`) is drawing its own interface and reads the right button as one of its inputs, so the
click is reported to it as a mouse event, exactly as a left-click is. An application that never
asked for the mouse has no use for the button, and right-clicking its pane opens a menu with the
pane commands:

| Entry | Same as |
|---|---|
| Zoom pane / Unzoom pane | `Ctrl+Shift+Z` |
| Close pane | `Ctrl+Shift+W` |
| Split left/right | `Ctrl+Shift+Alt+5` |
| Split top/bottom | `Ctrl+Shift+Alt+'` |

Hold **Shift** to get the menu from inside a mouse-aware application; that is the gesture xterm
already reserves for the local UI (its force-selection), and the one Windows Terminal uses for the
same purpose. `Esc` or a click anywhere outside closes the menu.

There is no right-click paste: the button is spoken for either by the application drawing the
screen or by the menu. Middle-click still pastes (`Ctrl+Shift+V` does too).

## Inline images

`@xterm/addon-image` provides iTerm IIP and SIXEL support, always on, with a 32MB cache per pane.

Local sessions set `TERM_PROGRAM=vscode` so that tools like yazi pick IIP rather than falling back
to chafa (which produces no real images). SSH sessions forward it via an env request, subject to the
server's `AcceptEnv`.

> **Windows local sessions are limited here.** ConPTY drops the escape sequences it does not
> implement, which includes the image protocols. See
> [ConPTY and escape sequences](#windows-local-sessions-conpty-and-escape-sequences).

## Font ligatures

Programming ligatures (the font's `calt` feature — `->`, `=>`, `!==`, `::`, `/*` and friends) are on
by default via `font.ligatures`. **Changing this setting requires a restart.**

Ligatures are a rendering-only feature:

- They **only work under the WebGL renderer**. Joined cells are a WebGL-only drawing path, so with
  `"webgl": false` ligatures silently stop appearing.
- Joins break at color boundaries: adjacent characters only ligate within a run of identical
  colors, so colored output breaks ligatures where the color changes (VS Code behaves the same way).
- A join is not rendered when the cursor falls inside the run or when selection state is
  inconsistent across it — this guarantees the cursor and selection are always drawn correctly.
- The buffer text is **never** modified. Copying, searching, copy mode, quick select and
  double-click word selection all read the buffer and are unaffected.

For how it works under the hood, see
[How ligatures are wired up](#how-ligatures-are-wired-up).

## SSH connections

### Connecting

Press `Ctrl+Shift+S`. The dialog accepts:

- `user@host`, `user@host:port`, or a bare hostname
- A `Host` alias, and any of the match/expansion semantics of `~/.ssh/config`

The connection is established with a pure-JS `ssh2` client (mirroring wezterm-ssh), not by shelling
out to `ssh`. Connection progress, host-key prompts and authentication prompts are rendered
**inside the terminal pane**.

`~/.ssh/config` is read and honoured, including `Host` wildcards, `Include`, `Match`, and `%token`
expansion. `ConnectTimeout` and `ServerAliveInterval` / `ServerAliveCountMax` are parsed and mapped
onto the corresponding ssh2 options. `Match exec` and `canonical` are not implemented (same as
wezterm-ssh), and **`ProxyJump` is not implemented** (same as wezterm).

### Host key verification

`known_hosts` is checked, including hashed entries. New hosts go through trust-on-first-use: the
SHA256 fingerprint is shown inline and you confirm it in the terminal. Confirmations are written
back to `known_hosts`.

### Authentication

Supported methods: `publickey`, `password`, and `keyboard-interactive` (interactive prompts are
rendered inline). If no password is supplied, authentication falls back to ssh-agent / key files, or
to the inline prompt.

Passwords typed into the SSH dialog are held **in memory for the lifetime of the run** so that a
reconnecting session can re-authenticate without asking again. They are **never written to disk**.

### Saved connections

Tick **Save this connection** in the dialog to store host/user/port/identity as a profile. Saved
profiles are listed the next time you open the dialog — click one to fill the fields or connect
directly — and can be deleted. Password are never persisted.

### Using SSH as the default

Set `ssh.defaultTarget` in the config and new tabs/panes (and the app's default session) will open
SSH instead of a local shell. The value can be `user@host[:port]`, a hostname, or a `~/.ssh/config`
`Host` alias.

### Session inheritance

One SSH target (same user/host/port/identity) gets **exactly one connection**. Once the first pane
has completed host-key confirmation and authentication, every pane or tab derived from it opens a
new shell channel on that same connection — **no password prompt and no host-key re-verification**.
This mirrors wezterm's `RemoteSshDomain` (see `mux/src/ssh.rs`, `spawn_pane`). If the connection
drops, the next new pane reconnects and re-authenticates, again like wezterm.

On the SSH side this is one connection per target and one channel per pane.

### SSH directory inheritance

An SSH pane tracks its current directory just like a local one, and splitting/tabbing from it lands
in the same directory. As with wezterm and Windows Terminal, the app only **consumes** OSC 7 — it
never injects anything into the remote session, and it never touches the remote shell.

**Reporting happens on the remote side.** The remote shell has to emit OSC 7 itself; that is shell
configuration, not something this app does. Use whatever your prompt framework already provides, or
add a line:

```sh
# ~/.bashrc (remote)
__osc7() { printf '\033]7;file://%s%s\033\\' "${HOSTNAME-}" "$PWD"; }
PROMPT_COMMAND="__osc7${PROMPT_COMMAND:+;${PROMPT_COMMAND[*]}}"
```

For zsh, replace the second line with `precmd_functions+=(__osc7)`; fish and most prompt frameworks
already do this. Alternatively, copy
[wezterm.sh](https://github.com/wezterm/wezterm/blob/main/assets/shell-integration/wezterm.sh) to
the remote host and `source` it — with no `wezterm` binary present it falls back to plain `printf`,
so nothing needs to be installed remotely.

To verify: on the remote host, `__osc7 | cat -v` should print `^[]7;file://<host>/<cwd>^[\` (the
sequence itself is invisible). Then, in the app, `cd` somewhere and split — the new pane should land
in that directory.

**Landing happens in this app.** The `cd` is performed by a wrapper process rather than by typing
into the interactive shell: ssh2's `shell`/`exec` accept no cwd parameter, so a new pane with a
known cwd uses an `exec` channel running
`cd -- '<cwd>' 2>/dev/null; exec "$SHELL" -l` (the same `cd && exec` approach as wezterm-ssh). That
`cd` never appears in the terminal and never lands in the remote history; `-l` reproduces the login
shell semantics sshd gives an ordinary shell channel, so `/etc/profile` and `~/.bash_profile` still
run. If the server refuses the exec request, the app falls back to a plain shell plus a typed `cd`
(a degraded path, where that one line is visible).

**When nothing is reported**, the pane's cwd stays unknown and nothing is inherited: the new pane is
created **byte-for-byte identically to `ssh host`** — a plain shell channel, no commands typed, no
remote environment changes — so it lands in the login directory.

## Session exit behavior

When a session's process exits or an SSH connection drops, `exitBehavior` decides what happens to
the pane:

| Value | Behavior |
|---|---|
| `close` | Always close the pane. |
| `closeOnCleanExit` (default) | Close on a clean exit (code 0), or when a session that had connected disconnects. Keep the pane showing the error when connecting/authenticating failed (never connected). |
| `hold` | Never close automatically; keep the pane showing "Session ended". |

Closing the last pane of the last tab closes the window.

## Windows and titles

- On Windows and Linux the native File/Edit/View/Window menu bar is removed, so it cannot conflict
  with `Alt`-based keybindings. macOS keeps its standard app menu.
- `Alt+Enter` toggles fullscreen, which hides the system title bar.
- The window title is `[idx/count] title`, where `title` comes from OSC 0/1/2 or the fallback
  described in [Tabs](#tabs).

## Settings dialog

`Ctrl+,` opens a dialog for live adjustment of:

- Font family, size, and line height
- History limit (scrollback)
- Focus follows mouse
- Tab bar position (top/bottom)

Everything it exposes is written to the config file, so the same settings can be edited by hand.

## Keybindings

`Ctrl+Shift+K`, or the **⌨** button in the tab bar, opens the Keybindings dialog.

Every global shortcut and every leader key command can be remapped. Click a chord, press the new
keys, then **Apply**.

- Clicking a chord chip starts **recording**. `Escape` cancels the recording (it does not close the
  dialog); `Backspace` clears the binding, leaving the action unbound — its old key then reaches the
  shell as ordinary input.
- **✕** clears one binding, **↺** restores that action's default *including every alternate spelling
  it has* (see [Chords](#chords)), and **Reset all** restores everything.
- A **Filter** box narrows the list, which is worth using at ~35 rows.

Recording refuses a key that would break something, and says why in the row:

| Refused | Why |
|---|---|
| A bare key with no `Ctrl` or `Alt` | Typing `t` in a shell must not open a tab. Function keys such as `F5` are fine without a modifier. |
| Bare modifiers, dead keys, keys pressed mid-IME-composition | Waiting for the rest of a chord must not record a half-finished one. |
| Leader commands on `Ctrl`/`Alt`, or on `1`–`9` | A leader key is a bare key by definition, and the digits are reserved for [jumping to a tab](#leader-key). |

### Conflicts

If two actions end up on the same chord, both rows turn red, a line names the colliding actions, and
**Apply is disabled** until you resolve it. Two chords count as the same even when they read
differently:

- `Ctrl+T` and `Cmd+T` — the two are one axis on every platform (see [Chords](#chords)).
- `Ctrl+Shift+5` and `Ctrl+Shift+%` — the same physical keypress, whether the layout reports the
  shifted glyph or the base key.

`Ctrl+T` and `Ctrl+Shift+T` are *not* the same chord and never conflict. Leader commands and global
shortcuts are compared separately, since a global `Ctrl+T` and a leader `t` happen at different
moments.

### What cannot be remapped

Copy mode's keys, quick select's keys, and the resize sub-mode's `h`/`j`/`k`/`l` are fixed — only the
chord that *enters* each mode is configurable. The leader `1`–`9` range is shown as a locked row for
the same reason: it is a range, not a single binding.

### Chords

A chord is written as modifiers plus a key: `Ctrl+Shift+T`, `Alt+ArrowUp`, `Ctrl+,`, `Shift+_`.
Modifier names are case-insensitive and accepted in any order.

**`Cmd` is recorded as `Ctrl`**, because the two are one axis: a binding that meant "Ctrl but not
Cmd" is not expressible across platforms.

Several defaults accept more than one spelling, because Shift produces a different character on
different layouts — `Ctrl+Shift+Alt+"` *and* `Ctrl+Shift+Alt+'` for **Split top/bottom**,
`Ctrl+Shift+Alt+5` *and* `Ctrl+Shift+Alt+%` for **Split left/right**, and both `Ctrl+Tab` and
`Ctrl+PageDown` for **Next tab**. Every accepted spelling is shown as its own chip; recording a new
chord replaces the whole set for that action.

Hand-editing [`keys`](#configuration-file) in `config.json` works as well, but the app reads the
config at startup, so **restart to pick up a hand edit**. Changes made in the dialog apply
immediately. Note that no settings file is watched: editing it while the app runs has no effect until
the next launch.

## Configuration file

The config lives at `app.getPath('userData')/config.json`. On Windows that is
`%APPDATA%\XtermMuxer\config.json`. It is deep-merged over the defaults, so you only need to write
the keys you want to change.

```jsonc
{
  "shell": { "path": "powershell.exe", "args": ["-NoLogo"] }, // Windows default: %ComSpec% (cmd.exe)
  // ligatures: programming ligatures (the font's calt feature). Default true.
  // Only effective under the WebGL renderer; changing it needs a restart.
  // family: leave blank for the platform monospace stack (Cascadia Mono/Consolas
  // on Windows). Any installed family name works, e.g. "JetBrains Mono".
  "font": { "family": "", "size": 14, "lineHeight": 1.15, "ligatures": true },
  "theme": { "mode": "system" }, // system | light | dark; may also carry custom colors
  "scrollback": 10000, // history limit in lines; also adjustable with Ctrl+,
  "window": { "width": 1100, "height": 700, "title": "XtermMuxer" },

  // Where the tab bar sits: "top" (default) or "bottom". Also adjustable with Ctrl+,.
  "tabBar": { "position": "top" },

  // Copy the selection to the clipboard as soon as it is made (default true).
  // Set false to copy only with Ctrl+Shift+C.
  "copyOnSelect": true,

  // Focus the pane the pointer moves into (wezterm pane_focus_follows_mouse, default true).
  // A re-emitted position (window returning to the foreground) is not a move; see pointer-move.ts.
  "focusFollowsMouse": true,

  // Render panes with WebGL (default true, needs a restart). Set false to fall back to the
  // DOM renderer when diagnosing rendering problems such as stale cells.
  "webgl": true,

  // What to do when a session exits / an SSH connection drops. Default closeOnCleanExit.
  //   close             always close the pane
  //   closeOnCleanExit  close on a clean exit (code 0), or when a connected session drops;
  //                     hold on connection/authentication failure (never connected)
  //   hold              never close automatically; keep the pane showing "Session ended"
  // Closing the last pane also closes the window.
  "exitBehavior": "closeOnCleanExit",

  // Keybinding overrides: action id -> list of chords. An empty list unbinds the action
  // and an absent id keeps its built-in default. Leader key table entries are namespaced
  // as "leader.<action>"; "leader-prefix" is the prefix chord itself. Several defaults
  // list more than one accepted spelling. Written by the Keybindings dialog (Ctrl+Shift+K).
  "keys": {
    "new-tab": ["Ctrl+J"],
    "toggle-zoom": [],
    "leader-prefix": ["Ctrl+A"]
  },

  // Connections saved from the SSH dialog (passwords are never persisted).
  "ssh": {
    // When set, new tabs / splits / the startup session default to SSH instead of a local shell.
    // Accepts user@host[:port], a hostname, or a Host alias from ~/.ssh/config.
    "defaultTarget": "deploy@prod.example.com",
    "hosts": [
      { "id": "…", "name": "web", "host": "example.com", "user": "root", "port": 2222, "identity": "~/.ssh/id_ed25519" }
    ]
  }
}
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `shell.path` / `shell.args` | string / string[] | `%ComSpec%` on Windows | Local shell to launch. |
| `font.family` | string | `""` (platform monospace stack) | |
| `font.size` | number | `14` | |
| `font.lineHeight` | number | `1.15` | |
| `font.ligatures` | boolean | `true` | WebGL-only; needs restart. |
| `theme.mode` | `system` \| `light` \| `dark` | `system` | Custom `colors` may be supplied. |
| `scrollback` | number | `10000` | History limit in lines. |
| `window.width` / `height` / `title` | number / number / string | `1100` / `700` / `XtermMuxer` | |
| `tabBar.position` | `top` \| `bottom` | `top` | |
| `copyOnSelect` | boolean | `true` | |
| `focusFollowsMouse` | boolean | `true` | |
| `webgl` | boolean | `true` | Needs restart. |
| `exitBehavior` | `close` \| `closeOnCleanExit` \| `hold` | `closeOnCleanExit` | |
| `ssh.defaultTarget` | string | — | Makes SSH the default session type. |
| `ssh.hosts` | array | `[]` | Saved profiles from the SSH dialog. |
| `ssh.connectTimeout`, `ssh.serverAliveInterval`, `ssh.serverAliveCountMax` | number | from `~/.ssh/config` | Mapped onto ssh2 options. |
| `keys` | object | `{}` | Keybinding overrides: action id → list of chords. `[]` unbinds, an absent id keeps its default, and a value that cannot be parsed is reported in the dialog and ignored. See [Keybindings](#keybindings). |

## Key reference

These tables list the **defaults**, which mirror wezterm's Windows defaults. Every binding in both
of them can be changed in the [Keybindings dialog](#keybindings); copy mode, quick select and the
resize sub-mode keep their fixed keys.

### Direct bindings

| Action | Keys |
|---|---|
| New tab | `Ctrl+Shift+T` |
| New SSH connection | `Ctrl+Shift+S` |
| Split top/bottom | `Ctrl+Shift+Alt+'` (i.e. `"`) |
| Split left/right | `Ctrl+Shift+Alt+5` (i.e. `%`) |
| Close focused pane (or tab) | `Ctrl+Shift+W` |
| Previous / next tab | `Ctrl+PageUp` / `Ctrl+PageDown`, `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Focus movement | `Alt+Arrow` |
| Next pane | `Alt+p` |
| Previous tab | `Alt+m` (`ActivateLastTab`) |
| Zoom the focused pane | `Ctrl+Shift+Z` |
| Copy / paste | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| Search | `Ctrl+Shift+F` |
| Copy mode | `Alt+X` |
| Quick select | `Alt+I` |
| Settings | `Ctrl+,` |
| Keybindings dialog | `Ctrl+Shift+K` |
| Fullscreen (hides the title bar) | `Alt+Enter` |

### Leader key

`Alt+N` arms leader mode — the same idea as tmux's prefix key. A floating overlay at the bottom of
the screen lists the available commands, and leader mode times out after 2 seconds without a
keypress.

Once armed, the leader takes the **next key, whatever it is**: an unlisted key cancels the mode and
is swallowed rather than reaching the shell. That includes keys that are otherwise global shortcuts —
`Alt+N` then `Alt+m` cancels, it does not jump to the last tab. (Before the keybindings work those
three chords leaked through and left leader mode armed, which made the overlay's hint a lie.)

Only the bare modifier keydowns (`Shift`, `Ctrl`, `Alt`) pass through, so that a chord like
`Shift+-` — which arrives as `Shift` first, then `_` — can complete without cancelling the mode.

| After `Alt+N`, press | Action |
|---|---|
| `-` | Split top/bottom (tmux `split-window -v`) |
| `Shift+-` | Split left/right (tmux `split-window -h`) |
| `c` | New tab |
| `x` | Close the focused pane |
| `z` | Zoom / unzoom the pane (wezterm `TogglePaneZoomState`) |
| `,` | Rename the current tab (wezterm `PromptInputLine`; blank restores the automatic title) |
| `n` / `p` | Next / previous tab |
| `1`–`9` | Jump to tab N (wezterm `LEADER+1..9` → `ActivateTab`) |
| `h` / `j` / `k` / `l` | Focus the pane left / down / up / right (`ActivatePaneDirection`) |
| `r` | Enter resize mode, then use `h`/`j`/`k`/`l` (`Esc` or 1s timeout exits) |

## Troubleshooting

### Stale content under the WebGL renderer

The WebGL renderer (`@xterm/addon-webgl`, enabled when `webglAvailable()` detects support, otherwise
falling back to the DOM renderer) has an upstream family of bugs where the texture atlas or
individual cells go stale until something forces a full repaint
([xtermjs/xterm.js#6042](https://github.com/xtermjs/xterm.js/pull/6042) and nearby atlas-reset
reports). Some of them **do not fire `onContextLoss`**, so there is no event to react to.

**Symptom**: after a full-screen program clears and redraws, cells it did not write still show the
previous screen's content (in an SSH pane, for example, a watermark of the login banner) — while
xterm's buffer is correct. A useful way to tell this apart from genuinely missing clear sequences is
that selections and copies come out clean. A full repaint (for instance `Ctrl-L` in Claude Code)
restores the display, because the repaint overwrites those cells.

**What the app does about it**: `repaint()` in `terminal-pane.tsx` forces
`term.refresh(0, rows-1)`. It is triggered at the moments that lose damage — pane layout
completion, a pane becoming visible again (tab switch, un-zooming, window returning to the
foreground), and, most importantly, **when a program clears the screen**. For the last one, the `J`
(erase in display) and `K` (erase in line) handlers are attached with a CSI handler that returns
`false` (so xterm still performs the erase normally) purely to request one repaint coalesced into
the same tick. A clear-and-redraw is exactly the moment this bug shows up. On `onContextLoss` the
addon is disposed and the DOM renderer takes over, as xterm recommends.

**If it still happens**, set `"webgl": false` in the config (default `true`, needs a restart) to
fall back to the DOM renderer — the one VS Code's built-in terminal uses — at the cost of throughput
under heavy output. This is also the fastest A/B test for whether stale content is a renderer
problem: if it stops happening with WebGL off, the renderer is the cause.

### Windows local sessions: ConPTY and escape sequences

ConPTY is not a transparent byte pipe. conhost parses the child process's VT output, renders it into
its own screen buffer, and sends *its own rendering* to the terminal. Sequences it implements are
re-emitted in normalized form; **sequences it does not implement are dropped**.

Measured against a real ConPTY on Windows 10 LTSC 2019 (17763), the following never reach the
terminal at all when written by a child process: `OSC 7` (cwd), `OSC 52` (clipboard), `OSC 1337`
(iTerm images), `CSI 16t` (cell size query), and kitty graphics APC. `SGR` (e.g. `ESC[31m`) is
re-emitted in normalized form as `ESC[0;31m`. `OSC 0/1/2` (title) is implemented by conhost and
comes through fine. `useConpty: false` (winpty) gives the same result, and `useConptyDll: true`
(node-pty's bundled ConPTY 1.23) did not change it either — passthrough also requires client-side
negotiation.

**What this means**:

- **Windows local sessions**: anything depending on those sequences does not work — yazi image
  previews, OSC 52, and tools reporting their own cwd. This is a platform limitation, not an
  application bug.
- **SSH sessions are unaffected**: bytes travel over libssh2 and never pass through ConPTY, so
  `OSC 1337`, `OSC 52` and `OSC 7` arrive intact. Remote yazi images do work, provided the server's
  `AcceptEnv` allows `TERM_PROGRAM`.
- **Linux / macOS**: no ConPTY, no limitation.

References: [mintty#1192](https://github.com/mintty/mintty/issues/1192) (the conclusion being that
there is no fix until ConPTY supports passthrough),
[windows/terminal#19926](https://github.com/microsoft/terminal/issues/19926) (cursor drift caused by
passthrough), and [Rio's Windows notes](https://rioterm.com/ko/docs/install/windows). Passthrough
requires ConPTY 1.22+ (the Windows Terminal project version) and has to be negotiated by the
terminal.

### Ligatures do not appear

Check, in order:

1. `font.ligatures` is `true`, and you have restarted since changing it.
2. `webgl` is `true` — only the WebGL renderer consumes character joiners. If WebGL was unavailable
   at startup the app fell back to the DOM renderer and ligatures are invisible.
3. The font actually has the ligatures you are looking for, and the characters are in the same
   color run (color boundaries break joins).
4. The cursor is not inside the join and the selection state is uniform across it.

### Diagnosing which font-ligature path is active

`@xterm/addon-ligatures` either obtains the font's ligature list via the **Local Font Access API**
(`navigator.fonts.query()` / `window.queryLocalFonts()`) and parses the GSUB table with
`font-ligatures`, or falls back to a built-in sequence table (Iosevka's calt set: `-> => <= >= != ==
=== !== :: /* */ <| |> ~~> <!-- +++ …`). So common ligatures still work even when the font file
cannot be read. Open devtools to see which path was taken — the addon logs `console.error` with the
reason when font access fails.

## Known limitations

- No tmux-style remote multiplexing (`wezterm connect` / mux-server).
- `Match exec` and `canonical` are not implemented (same as wezterm-ssh). `ProxyJump` is not
  implemented (same as wezterm).
- Search is scoped to the focused pane; it does not span sessions.
- Copy mode's keys, quick select's keys, the resize sub-mode's `h`/`j`/`k`/`l`, and the leader `1`–`9`
  digit range cannot be remapped, only the chord that enters each mode. See
  [Keybindings](#what-cannot-be-remapped).
- WebGL renderer can show stale cells — see
  [Stale content](#stale-content-under-the-webgl-renderer).
- On Windows local sessions ConPTY drops several escape sequences — see
  [ConPTY and escape sequences](#windows-local-sessions-conpty-and-escape-sequences).

## Appendix A: Architecture

```
Electron main ── IPC ── renderer (React)
  ├─ SessionManager (analogous to wezterm's Mux)
  │    ├─ LocalSession  (node-pty, ConPTY on Windows)
  │    └─ SshSession    (ssh2, pure JS; analogous to wezterm-ssh)
  │         ├─ ssh-connection.ts  connection pool keyed by target (like RemoteSshDomain)
  │         ├─ ssh-config.ts      ssh_config(5) parsing/matching
  │         ├─ ssh-auth.ts        authHandler interactive authentication
  │         └─ known-hosts.ts     host key verification / writing
  └─ renderer: tabs → pane binary tree → xterm.js instances
        ├─ mux-model.ts / mux-reducer.ts   (Tab/Pane state machine)
        ├─ keymap.ts      (binding tables, chord grammar, conflicts, key routing)
        ├─ split-view / terminal-pane / tab-bar / ssh-dialog / settings-dialog / overlays
        ├─ copy-mode.ts   (vim/wezterm copy mode logic, Alt+X)
        ├─ quick-select.ts (wezterm QuickSelect matching/labeling logic, Alt+I)
        ├─ osc52.ts       (OSC 52 clipboard payload decoding)
        └─ prompt-input    (inline prompt line editing, analogous to wezterm's LineEditor)
```

Data flow: `node-pty / ssh2 streams → session:output → xterm.write()`; keyboard input goes
`xterm.onData → session:write`; resizes go through `session:resize`. SSH authentication and host-key
prompts use `session:prompt` for inline input in the terminal.

### How ligatures are wired up

xterm takes a glyph per cell, so a font's `liga`/`calt` features would never apply across cells. The
enablement path is the core's `term.registerCharacterJoiner()`: a joiner returns *which columns must
be drawn as a unit*, and the WebGL renderer, on a hit, builds `JoinedCellData` (`combinedData` being
that run of characters) and takes the atlas's "combined string" rasterization path — a **single
`fillText` for the whole run**, at which point the browser applies the font's `calt`.

That is what `@xterm/addon-ligatures` does, plus obtaining the font's ligature set as described in
[Troubleshooting](#diagnosing-which-font-ligature-path-is-active).

Two ordering constraints are hard requirements, both in the mount effect of `terminal-pane.tsx`:

1. `LigaturesAddon.activate()` requires `terminal.element` to exist, so it must be loaded after
   `term.open()` (xterm's `AddonManager.loadAddon` activates **immediately**; there is no "wait for
   open, then activate").
2. The WebGL addon must be activated **after** it, so that the atlas picks up the element's
   `font-feature-settings: "calt" on` (required by the addon's typings).

Additional behavior worth knowing:

- Only the WebGL renderer consumes joiners, so with `"webgl": false` ligatures do not render (the
  joiner is still registered; nothing draws it).
- Foreground/background changes split the candidate run (core calls the joiner per color segment),
  so **colored output breaks ligatures at color changes**, exactly as in VS Code.
- A run is not joined when the cursor falls inside it or when selection state is inconsistent across
  it, which keeps the cursor and selection correct in all cases.
- The indices the joiner receives are **string indices**; xterm maps them back to columns and skips
  zero-width cells, so CJK and wide-character lines need no special handling.
- It is a pure rendering feature: the buffer is untouched, so copying, searching, copy mode, quick
  select and double-click word selection are unaffected. That also means there is **no unit test
  coverage** — the way to verify is to type `->`, `=>`, `!==`, `::`, `/*` in a pane and watch the
  glyphs merge.
- Dependency weight: the addon bundle is roughly 200KB (including `font-ligatures`) and ships with
  the renderer.

## Appendix B: Building, running and testing

### Development

```bash
npm install        # install dependencies; postinstall rebuilds native modules for Electron
npm run dev        # electron-vite dev mode
npm run typecheck  # type checking only
npm test           # typecheck + unit tests (mux tree) + session-layer tests
npm run build      # build into out/
```

### Packaging

```bash
npm run pack          # electron-vite build + electron-builder --dir (host platform)
npm run dist:win      # NSIS installer, on Windows
npm run dist:linux    # AppImage, on the host
```

- The Windows installer must be built **on a Windows machine**: node-pty's Windows binary has to be
  compiled against the Electron ABI on the target platform (`electron-builder.yml` sets
  `npmRebuild: true`).
- The icon is generated into `build/icon.png` by `scripts/make-icon.js`; electron-builder derives
  the `.ico` from it.

### Tests

- `npm run test:unit` — pure-JS unit tests for the mux tree/reducer (splits, collapsing, focus
  navigation, tab lifecycle).
- `npm run test:sessions` — runs under Electron (headless) and covers ssh_config parsing,
  known_hosts (including hashed entries), node-pty local sessions, the SSH end-to-end flow (host-key
  TOFU + auth prompts + error paths, verified against a local sshd), cwd inheritance (exec wrapper
  landing, plus the fallback when the server refuses exec, verified with a built-in fake ssh2
  server: the `cd` in the command string is correctly escaped and the wrapper path **writes nothing
  into the session**), and pty size tracking the pane (no resize lost during either the
  authentication window or the "request sent, reply not yet received" window).

### Native rebuilds

node-pty must be compiled against the Electron ABI. `scripts/rebuild-native.js` auto-detects **zig**
(`ZIG_PATH`, `~/zig160/zig`) and Python (`PYTHON` / `NODE_GYP_FORCE_PYTHON`, or common install
locations) — none of which are configured in `.npmrc`. If zig is not found it falls back to the
default toolchain, which then requires a system compiler with C++20 support (VS Build Tools on
Windows, gcc ≥ 9 on Linux).

### Mirrors

The two mirror keys live in different places because they are consumed at different times.

`electron_mirror` (npmmirror) stays in `.npmrc`: it is read during `npm install` by the **electron
package's own postinstall**, and npm only injects `npm_package_config_*` for the package whose
script is running — putting it in this repo's `package.json` `config` would not be visible and would
silently fall back to GitHub.

`electron_builder_binaries_mirror` goes in `package.json`'s `config` instead, because it is read by
the root `npm run dist:*` scripts, where `npm_package_config_*` is present.

npm currently prints an "Unknown project config" warning for `electron_mirror` in `.npmrc`, and it
will stop working in the next major version; at that point use the `ELECTRON_MIRROR` environment
variable instead (which `@electron/get` also recognizes).

## License

See [LICENSE](LICENSE).
