import AppKit

@MainActor
enum NativeEditMenu {
    private struct Command {
        let title: String
        let action: Selector
        let key: String
        let modifiers: NSEvent.ModifierFlags
    }

    private static let groups: [[Command]] = [
        [Command(title: "撤销", action: NSSelectorFromString("undo:"), key: "z", modifiers: [.command]),
         Command(title: "重做", action: NSSelectorFromString("redo:"), key: "z", modifiers: [.command, .shift])],
        [Command(title: "剪切", action: NSSelectorFromString("cut:"), key: "x", modifiers: [.command]),
         Command(title: "复制", action: NSSelectorFromString("copy:"), key: "c", modifiers: [.command]),
         Command(title: "粘贴", action: NSSelectorFromString("paste:"), key: "v", modifiers: [.command])],
        [Command(title: "全选", action: NSSelectorFromString("selectAll:"), key: "a", modifiers: [.command])]
    ]

    static func install() {
        let app = NSApplication.shared
        let mainMenu = app.mainMenu ?? NSMenu(title: "Main Menu")
        if app.mainMenu == nil {
            let applicationItem = NSMenuItem(title: "Codex Progress", action: nil, keyEquivalent: "")
            let applicationMenu = NSMenu(title: "Codex Progress")
            applicationMenu.addItem(NSMenuItem(title: "退出 Codex Progress", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
            applicationItem.submenu = applicationMenu
            mainMenu.addItem(applicationItem)
        }
        let editItem: NSMenuItem
        if let existing = mainMenu.items.first(where: { $0.title == "编辑" || $0.title.caseInsensitiveCompare("Edit") == .orderedSame }) {
            editItem = existing
        } else {
            editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
            mainMenu.addItem(editItem)
        }
        let editMenu = editItem.submenu ?? NSMenu(title: "编辑")
        editItem.submenu = editMenu

        if app.mainMenu == nil { app.mainMenu = mainMenu }

        for group in groups {
            let missing = group.filter { command in
                guard let item = editMenu.items.first(where: { $0.action == command.action }) else { return true }
                item.title = command.title
                item.keyEquivalent = command.key
                item.keyEquivalentModifierMask = command.modifiers
                item.target = nil
                return false
            }
            guard !missing.isEmpty else { continue }
            if !editMenu.items.isEmpty && editMenu.items.last?.isSeparatorItem != true {
                editMenu.addItem(.separator())
            }
            for command in missing {
                let item = NSMenuItem(title: command.title, action: command.action, keyEquivalent: command.key)
                item.keyEquivalentModifierMask = command.modifiers
                item.target = nil
                editMenu.addItem(item)
            }
        }
    }
}
