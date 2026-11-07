# macOS：一个快捷键打开豆芽

豆芽跑在本机，登录入口是一个带 token 的 URL，写在 `.odm-data/dsh-web.url` 里。这一页把「打开那个 URL」做成一个系统级快捷键：按一下，默认浏览器就打开已经登录的豆芽页面，不用先开终端 `cat` 链接。

这一版只交付文档和一条可复制的命令，不新增程序，也不改页面。

## 前提

- 仓库在这台机器上的位置，下文一律写作 `<仓库绝对路径>`（例如你的家目录下的某个目录）。它是占位符，实际使用时换成这台机器上的真实路径；仓库搬家或换机器要改一次。
- `.odm-data/dsh-web.url` 由 `npm start` 生成，内容是一行 `<origin>/?token=<token>`。没跑过 `npm start` 就没有这个文件。
- 需要 macOS 自带 Shortcuts.app（macOS 12 起）。Linux / Windows 的全局热键不在这一页里。
- 这个 URL 是登录凭据：不要贴到 issue、聊天记录或截图里。

## 1. 做一个 Shortcut

1. 打开 **Shortcuts.app**，新建一个 Shortcut，名字可以叫「豆芽」。
2. 在右侧动作库里搜 **Run Shell Script** 并添加。Shell 选 `/bin/zsh`。
3. 把下面这一行粘进去，**只替换 `<仓库绝对路径>` 这一段**（尖括号一起换掉），其它字符一个都不要动：

```bash
/usr/bin/open "$(/bin/cat <仓库绝对路径>/.odm-data/dsh-web.url)"
```

4. 打开这个 Shortcut 的设置，给它设一个快捷键，例如 ⌃⌥⌘D。和系统或其它 App 冲突就换一个。
5. 在 Shortcuts.app 里点一下运行，确认浏览器打开了豆芽。

命令里用的是 `/usr/bin/open` 和 `/bin/cat` 的绝对路径：Shortcut 运行 shell 时的起始目录通常不是仓库根，PATH 也是受限的，写绝对路径才不依赖这两样。

## 2. 钉到菜单栏

在 Shortcut 的详情里打开 **Pin in Menu Bar**，菜单栏会出现一个图标，点一下也能打开豆芽，不用记快捷键。

## 3. 在终端里直接用

不想用快捷键时，在终端里先进入仓库再打开：

```bash
cd <仓库绝对路径>
open "$(cat .odm-data/dsh-web.url)"
```

这和快捷键做的是同一件事，只是这一步用相对路径，前提是当前目录就是仓库根。

## 4. 第一次会遇到什么

- 第一次运行 Shortcut 时，macOS 会弹窗要求允许 Shortcuts 运行 shell 脚本，允许一次即可。
- 之后按快捷键，默认浏览器会打开 `.odm-data/dsh-web.url` 里的那个 URL，页面已经是登录状态。
- Chrome 通常新开一个标签页。这一版不承诺复用已有的豆芽标签页。

## 5. 排错

- **打开后是 401**：dsh 重启过，旧 URL 里的端口或 token 已经失效。在仓库根重新跑 `npm start`，让它重写 `.odm-data/dsh-web.url`，再按快捷键。
- **提示找不到文件**：这台机器还没跑过 `npm start`，`.odm-data/dsh-web.url` 还没生成。
- **打开的是别的浏览器**：`/usr/bin/open` 走系统默认浏览器，先去「系统设置 → 桌面与程序坞 → 默认网页浏览器」里改。
- **快捷键没反应**：多半和系统或其它 App 的快捷键撞了，换一个组合试试。

## 6. 这一版不做的

- **不复用已有标签页**：`open` 的行为由浏览器决定，Chrome 通常新开标签页；要复用或把焦点落回页内 dock，需要 AppleScript 或深链，留给后续。
- **不自动开麦**：按住说话已经有了，但自动开麦还要决定用户手势与权限，不在这一版。
- **不做原生菜单栏 App**：没有打包 `.app`，也没有 PWA「加到程序坞」，菜单栏入口就是 Shortcuts 的 Pin in Menu Bar。
- 不做 Windows / Linux 全局热键，也不在端口没起时自动把 dsh 拉起来。
