import AppKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class ComposerBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var window: NSWindow?
    private var collapsedHeight: CGFloat?

    init(window: NSWindow) {
        self.window = window
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard isTrusted(message) else {
            replyHandler(nil, "Untrusted message origin")
            return
        }

        guard let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "Invalid message")
            return
        }

        switch action {
        case "chooseFiles":
            chooseFiles(replyHandler: replyHandler)
        case "openEditor":
            guard let raw = body["url"] as? String, let url = URL(string: raw),
                  url.scheme == "cursor", url.host == "local.codex-progress-editor", url.path == "/attach" else {
                replyHandler(nil, "Invalid editor link")
                return
            }
            replyHandler(["opened": NSWorkspace.shared.open(url)], nil)
        case "resize":
            guard let expanded = body["expanded"] as? Bool else {
                replyHandler(nil, "Invalid resize request")
                return
            }
            resize(expanded: expanded, contentHeight: body["contentHeight"] as? Double)
            replyHandler(["ok": true], nil)
        default:
            replyHandler(nil, "Unsupported action")
        }
    }

    private func isTrusted(_ message: WKScriptMessage) -> Bool {
        guard message.frameInfo.isMainFrame,
              let url = message.webView?.url,
              url.scheme == "http", url.host == "127.0.0.1",
              let port = url.port else { return false }

        let origin = message.frameInfo.securityOrigin
        return origin.protocol == url.scheme && origin.host == url.host && origin.port == port
    }

    private func chooseFiles(replyHandler: @escaping (Any?, String?) -> Void) {
        guard let window else {
            replyHandler(["files": []], nil)
            return
        }

        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = true
        panel.beginSheetModal(for: window) { response in
            guard response == .OK else {
                replyHandler(["files": []], nil)
                return
            }

            let files = panel.urls.map { url -> [String: String] in
                let isDirectory = url.hasDirectoryPath ||
                    ((try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true)
                let kind: String
                if isDirectory {
                    kind = "folder"
                } else if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image) {
                    kind = "image"
                } else {
                    kind = "file"
                }
                return ["name": url.lastPathComponent, "path": url.path, "kind": kind]
            }
            replyHandler(["files": files], nil)
        }
    }

    private func resize(expanded: Bool, contentHeight: Double?) {
        guard let window else { return }
        var frame = window.frame
        let targetHeight: CGFloat
        if expanded {
            if collapsedHeight == nil { collapsedHeight = frame.height }
            let desired = contentHeight.flatMap { $0.isFinite && $0 > 0 ? CGFloat(min($0, 1100)) + 32 : nil } ?? 618
            targetHeight = max(650, desired)
        } else {
            targetHeight = collapsedHeight ?? frame.height
            collapsedHeight = nil
        }

        guard let screen = NSScreen.screens.first(where: { $0.frame.intersects(frame) }) ?? window.screen else {
            frame.size.height = targetHeight
            window.setFrame(frame, display: true, animate: true)
            return
        }

        let visible = screen.visibleFrame
        let height = min(targetHeight, visible.height)
        frame.origin.y = min(max(frame.maxY - height, visible.minY), visible.maxY - height)
        frame.size.height = height
        window.setFrame(frame, display: true, animate: true)
    }
}
