# Codex Progress

## Purpose
在本机 Codex 执行任务时提供低打扰、可信的语义进度。用户无需打开网页；菜单栏可随时显示/收起原生浮窗。

## Audience & scene
用户在日间室内使用 Mac 的 Codex 桌面端，边读结果边处理其他工作；小窗应与系统界面保持相近亮度，并支持系统深色模式。

## Register
product

## Platform
macOS native shell with local web content

## Principles
- 一格代表一个明确的子任务，不代表时间、token 或调用次数。
- 总量可以随新发现的工作增加，完成项保持身份；不为了 100% 填绿未完成项。
- 未提供子任务时只显示整体任务，避免编造分母。
- 网格下方只有总体目标、当前进度两列。
- 本机只读观察，显式任务更新走本地桥接；不访问认证文件，不向远端发送任务信息。
