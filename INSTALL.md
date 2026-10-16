# Codex Progress 1.1

适用：macOS 13.5 及以上，Apple 芯片和 Intel Mac。

1. 打开 DMG，将 Codex Progress 拖到 Applications（应用程序）。
2. 若已有旧版，先退出旧版，再选择替换。
3. 从应用程序打开 Codex Progress，点击菜单栏图标查看任务。

无需安装 Node、Homebrew、Python 或开发工具。运行环境已包含在应用内。请先复制到应用程序，再使用；DMG 是只读安装介质。

任务来自这台 Mac 当前用户的 Codex 本机执行记录。若没有记录，打开并使用 Codex 后会自动发现。另一台电脑上的记录不会随安装包搬过来。目标控制与输入能力取决于当前 Codex 桌面版本是否开放相应控制接口；不支持的任务仍可只读显示。

运行数据保存在当前用户的 ~/Library/Application Support/Codex Progress/runtime，应用目录内不写入运行数据。首次索引会显示加载动画。

当前包使用本地完整性签名，尚未获得 Apple Developer ID 公证。通过下载、企业微信等途径传输后，macOS 可能提示无法验证开发者。此提示与芯片架构不兼容是两回事；请按系统提供的安全设置自行确认来源后打开，不需要关闭系统安全保护。

若 Finder 显示禁止标记，请核对系统是否至少为 macOS 13.5，并确认使用的是名称带 Universal 的 1.1 安装包。旧版 arm64 安装包不再分发。
