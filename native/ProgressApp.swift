import AppKit
import Darwin
import Dispatch
import WebKit

private final class ProgressPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private let duplicateNotification = Notification.Name("local.codex.progress.show")
    private let statusItem = NSStatusBar.system.statusItem(withLength: StatusMetricsTitle.statusWidth)
    private let menu = NSMenu()
    private let statusMetricsTitle = StatusMetricsTitle()
    private var gridIcon: StatusGridIcon?
    private var panel: ProgressPanel!
    private var webView: WKWebView!
    private var composerBridge: ComposerBridge!
    private var nodeProcess: Process?
    private var timer: Timer?
    private var revealSignalSource: DispatchSourceSignal?
    private var terminateSignalSource: DispatchSourceSignal?
    private var endpointPort: Int?
    private var loadedPort: Int?
    private var latestState: [String: Any] = [:]
    private var seenTurns: [String: String] = [:]
    private var suppressedTurns: [String: String] = [:]
    private var displayedTurn: (id: String, turnId: String)?
    private var panelHasBeenPositioned = false
    private var requestInFlight = false
    private var serviceUnavailable = false
    private var terminationPending = false
    private var verificationBusy = false
    private var verificationDone = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bundleID = Bundle.main.bundleIdentifier ?? "local.codex.progress"
        let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if let existing {
            existing.activate(options: [.activateAllWindows])
            DistributedNotificationCenter.default().post(name: duplicateNotification, object: bundleID)
            NSApp.terminate(nil)
            return
        }
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(revealFromDuplicateInstance),
                                                               name: duplicateNotification, object: bundleID,
                                                               suspensionBehavior: .deliverImmediately)
        NSApp.setActivationPolicy(.accessory)
        NativeEditMenu.install()
        configureStatusItem()
        configurePanel()
        configureSignalHandlers()
        startService()
        timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshState() }
        }
        RunLoop.main.add(timer!, forMode: .common)
        updateMenuAndStatus()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let process = nodeProcess, process.isRunning else { return .terminateNow }
        guard !terminationPending else { return .terminateCancel }
        terminationPending = true
        process.terminate()
        // Keep the main run loop available for the child's termination handler.
        // It requests termination again after the owned service has exited.
        return .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if let process = nodeProcess, process.isRunning { process.terminate() }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hidePanel()
        return false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.scheme == "http", url.host == "127.0.0.1",
              let port = endpointPort, url.port == port else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // Optional local render verification, disabled in normal use.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.host == "127.0.0.1" { (webView as? ProgressWebView)?.finishStartupLoading() }
        verifySnapshot()
    }

    private func verifySnapshot() {
        guard !verificationBusy, !verificationDone else { return }
        guard let output = ProcessInfo.processInfo.environment["CODEX_PROGRESS_SNAPSHOT"],
              let thread = ProcessInfo.processInfo.environment["CODEX_PROGRESS_VERIFY_THREAD"] else { return }
        verificationBusy = true
        webView.callAsyncJavaScript("""
          await fetch('/api/select', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({threadId:thread})});
          for(let i=0;i<60;i++) {
            if(document.getElementById('threads').value===thread && document.querySelectorAll('.cell').length) break;
            await new Promise(r=>setTimeout(r,100));
          }
          return {cells:document.querySelectorAll('.cell').length, green:document.querySelectorAll('.cell.completed').length, connection:document.getElementById('connection').textContent, done:document.getElementById('done').textContent, total:document.getElementById('total').textContent, height:document.body.scrollHeight, width:innerWidth, barWidth:document.getElementById('bar').getBoundingClientRect().width};
          """, arguments: ["thread": thread], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            self.verificationBusy = false
            guard case .success(let details) = result,
                  self.latestState["activeId"] as? String == thread else { return }
            self.verificationDone = true
            self.webView.takeSnapshot(with: nil) { image, error in
                guard error == nil, let data = image?.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: data),
                      let png = bitmap.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: output))
                let report: [String: Any] = ["windowVisible": self.panel.isVisible,
                                           "contentWidth": self.webView.bounds.width,
                                           "contentHeight": self.webView.bounds.height,
                                           "menuTitle": self.statusItem.button?.title ?? "",
                                           "page": details]
                if let json = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]) {
                    try? json.write(to: URL(fileURLWithPath: output + ".json"))
                }
            }
        }
    }

    @objc private func statusPressed(_ sender: Any?) {
        if let event = NSApp.currentEvent,
           event.type == .rightMouseUp || event.modifierFlags.contains(.control) {
            NSMenu.popUpContextMenu(menu, with: event, for: statusItem.button!)
        } else {
            showPanel(automatically: false, thread: activeThread())
        }
    }

    @objc private func showFromMenu(_ sender: Any?) {
        if panel.isVisible { hidePanel() }
        else { showPanel(automatically: false, thread: activeThread()) }
    }

    @objc private func togglePin(_ sender: NSMenuItem) {
        panel.level = panel.level == .floating ? .normal : .floating
        sender.state = panel.level == .floating ? .on : .off
    }

    @objc private func retryService(_ sender: Any?) {
        guard nodeProcess?.isRunning != true else { return }
        startService()
        updateMenuAndStatus()
    }

    @objc private func quit(_ sender: Any?) { NSApp.terminate(nil) }

    @objc private func revealFromDuplicateInstance() {
        showPanel(automatically: false, thread: activeThread())
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        gridIcon = StatusGridIcon(button: button)
        button.imagePosition = .imageLeading
        button.toolTip = "点击打开任务进度大窗 · 右键查看更多操作"
        button.target = self
        button.action = #selector(statusPressed(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    private func configurePanel() {
        let size = NSSize(width: 640, height: 540)
        panel = ProgressPanel(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "Codex Progress"
        panel.minSize = NSSize(width: 456, height: 380)
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.delegate = self

        let contentController = WKUserContentController()
        composerBridge = ComposerBridge(window: panel)
        contentController.addScriptMessageHandler(composerBridge, contentWorld: .page, name: "progressComposer")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        webView = ProgressWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        panel.contentView = webView
        (webView as? ProgressWebView)?.showStartupLoading()

        menu.addItem(NSMenuItem(title: "显示进度", action: #selector(showFromMenu(_:)), keyEquivalent: ""))
        menu.items[0].target = self
        menu.addItem(.separator())
        let status = NSMenuItem(title: "正在连接", action: nil, keyEquivalent: "")
        status.tag = 100
        menu.addItem(status)
        let retry = NSMenuItem(title: "重新连接", action: #selector(retryService(_:)), keyEquivalent: "")
        retry.tag = 101
        retry.target = self
        menu.addItem(retry)
        menu.addItem(.separator())
        let pin = NSMenuItem(title: "置顶", action: #selector(togglePin(_:)), keyEquivalent: "")
        pin.tag = 102
        pin.target = self
        menu.addItem(pin)
        menu.addItem(.separator())
        let exit = NSMenuItem(title: "退出", action: #selector(quit(_:)), keyEquivalent: "q")
        exit.target = self
        menu.addItem(exit)
    }

    private func startService() {
        guard nodeProcess?.isRunning != true else { return }
        serviceUnavailable = false
        endpointPort = nil
        loadedPort = nil
        let nodeURL = RuntimePaths.node
        let serverRoot = Bundle.main.resourceURL!.appendingPathComponent("server", isDirectory: true)
        let script = serverRoot.appendingPathComponent("src/server.mjs")
        let runtime = RuntimePaths.runtime
        do {
            try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
            let process = Process()
            process.executableURL = nodeURL
            process.arguments = [script.path, "--runtime", runtime.path]
            process.currentDirectoryURL = serverRoot
            process.environment = ProcessInfo.processInfo.environment.merging([
                "CODEX_PROGRESS_RUNTIME": runtime.path
            ]) { _, new in new }
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { [weak self] child in
                Task { @MainActor in
                    guard let self else { return }
                    if self.nodeProcess?.processIdentifier == child.processIdentifier { self.nodeProcess = nil }
                    self.endpointPort = nil
                    self.loadedPort = nil
                    self.serviceUnavailable = true
                    self.updateMenuAndStatus()
                    if self.terminationPending {
                        self.terminationPending = false
                        NSApp.terminate(nil)
                    }
                }
            }
            try process.run()
            nodeProcess = process
        } catch {
            nodeProcess = nil
            serviceUnavailable = true
        }
        updateMenuAndStatus()
    }

    private func refreshState() {
        guard let process = nodeProcess, process.isRunning else {
            updateMenuAndStatus()
            return
        }
        let runtime = RuntimePaths.runtime
        let endpointURL = runtime.appendingPathComponent("endpoint.json")
        guard let data = try? Data(contentsOf: endpointURL),
              let endpoint = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let port = endpoint["port"] as? Int,
              let pid = endpoint["pid"] as? Int, pid == Int(process.processIdentifier) else { return }
        endpointPort = port
        if loadedPort != port {
            loadedPort = port
            webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
        }
        guard !requestInFlight else { return }
        requestInFlight = true
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/state")!, timeoutInterval: 2)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            Task { @MainActor in
                guard let self else { return }
                self.requestInFlight = false
                guard error == nil, let data,
                      let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
                self.latestState = state
                self.observeNewTurns(state)
                self.updateMenuAndStatus()
                self.writeNativeState()
                if self.loadedPort != nil { self.verifySnapshot() }
            }
        }.resume()
    }

    private func observeNewTurns(_ state: [String: Any]) {
        guard let threads = state["threads"] as? [[String: Any]] else { return }
        var newlyRunning: (id: String, turnId: String)?
        for thread in threads {
            guard let id = thread["id"] as? String, let turnId = thread["turnId"] as? String,
                  !turnId.isEmpty else { continue }
            let isRunning = thread["status"] as? String == "running"
            if isRunning && seenTurns[id] != turnId && newlyRunning == nil { newlyRunning = (id, turnId) }
            seenTurns[id] = turnId
        }
        if let turn = newlyRunning, suppressedTurns[turn.id] != turn.turnId {
            showPanel(automatically: true, thread: turn)
        }
    }

    private func showPanel(automatically: Bool, thread: (id: String, turnId: String)?) {
        if let thread { displayedTurn = thread }
        let targetScreen = screenForDisplay()
        let isOnTargetScreen = targetScreen?.visibleFrame.contains(panel.frame) ?? false
        if !panelHasBeenPositioned || !panelFitsVisibleScreen() || (!automatically && !isOnTargetScreen) {
            positionPanel()
            panelHasBeenPositioned = true
        }
        if automatically {
            panel.orderFrontRegardless()
        } else {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
            panel.orderFrontRegardless()
        }
    }

    private func hidePanel() {
        if let displayedTurn { suppressedTurns[displayedTurn.id] = displayedTurn.turnId }
        panel.orderOut(nil)
    }

    private func positionPanel() {
        let screen = screenForDisplay()
        guard let screen else { return }
        let visible = screen.visibleFrame.insetBy(dx: 12, dy: 12)
        let x = max(visible.minX, visible.maxX - panel.frame.width)
        let y = max(visible.minY, visible.maxY - panel.frame.height)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func screenForDisplay() -> NSScreen? {
        let pointer = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.screens.first
    }

    private func panelFitsVisibleScreen() -> Bool {
        NSScreen.screens.contains { $0.visibleFrame.contains(panel.frame) }
    }

    private func writeNativeState() {
        func rectState(_ rect: NSRect) -> [String: Double] {
            ["x": Double(rect.origin.x), "y": Double(rect.origin.y),
             "width": Double(rect.width), "height": Double(rect.height)]
        }
        let activeThreadId: Any = (latestState["activeId"] as? String).map { $0 as Any } ?? NSNull()
        let state: [String: Any] = [
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "isVisible": panel.isVisible,
            "isOnActiveSpace": panel.isOnActiveSpace,
            "occluded": !panel.occlusionState.contains(.visible),
            "frame": rectState(panel.frame),
            "screens": NSScreen.screens.map { screen in
                ["frame": rectState(screen.frame), "visibleFrame": rectState(screen.visibleFrame)]
            },
            "activeThreadId": activeThreadId,
            "iconCells": gridIcon?.cells.map { ["index": $0.sourceIndex.map { $0 as Any } ?? NSNull(), "status": $0.status] } ?? [],
            "iconAnimating": gridIcon?.animationRunning ?? false,
            "iconFrameRevision": gridIcon?.frameRevision ?? 0,
            "menuTitle": menu.items.first?.title ?? "",
            "statusTitle": statusMetricsTitle.accessibleTitle,
            "statusWidth": statusItem.length,
            "statusBorderAnimating": statusMetricsTitle.borderAnimating,
            "statusBorderFrameRevision": statusMetricsTitle.borderFrameRevision,
            "appActive": NSApp.isActive
        ]
        let runtime = RuntimePaths.runtime
        do {
            try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
            try data.write(to: runtime.appendingPathComponent("native-state.json"), options: .atomic)
        } catch {
            NSLog("Codex Progress: couldn't write native-state.json: %@", String(describing: error))
        }
    }

    private func configureSignalHandlers() {
        signal(SIGUSR1, SIG_IGN)
        let reveal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        reveal.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.showPanel(automatically: false, thread: self.activeThread())
            }
        }
        revealSignalSource = reveal
        reveal.resume()

        signal(SIGTERM, SIG_IGN)
        let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        terminate.setEventHandler {
            Task { @MainActor in NSApp.terminate(nil) }
        }
        terminateSignalSource = terminate
        terminate.resume()
    }

    private func activeThread() -> (id: String, turnId: String)? {
        guard let threads = latestState["threads"] as? [[String: Any]] else { return nil }
        let activeId = latestState["activeId"] as? String
        let thread = threads.first { ($0["id"] as? String) == activeId } ?? threads.first
        guard let thread, let id = thread["id"] as? String else { return nil }
        return (id, thread["turnId"] as? String ?? "")
    }

    private func updateMenuAndStatus() {
        let thread = activeThread()
        let threads = latestState["threads"] as? [[String: Any]] ?? []
        let tasks: [[String: Any]]
        if let id = thread?.id,
           let selected = threads.first(where: { ($0["id"] as? String) == id }),
           let selectedTasks = selected["tasks"] as? [[String: Any]] {
            let history = (selected["taskGroups"] as? [[String: Any]] ?? []).flatMap { $0["tasks"] as? [[String: Any]] ?? [] }
            tasks = history + ((selected["currentTaskGroupId"] as? String) == nil ? selectedTasks : [])
        } else {
            tasks = []
        }
        let selected = threads.first { ($0["id"] as? String) == thread?.id }
        gridIcon?.update(tasks: tasks, threadStatus: selected?["status"] as? String ?? "idle")
        let completed = selected?["completed"] as? Int ?? tasks.filter { ($0["status"] as? String) == "completed" }.count
        if let button = statusItem.button {
            statusMetricsTitle.apply(to: button, snapshot: latestState, completed: completed, taskCount: selected?["total"] as? Int ?? tasks.count)
        }
        menu.items.first?.title = panel?.isVisible == true ? "收起进度" : "显示进度"
        if let status = menu.item(withTag: 100) {
            if serviceUnavailable { status.title = "进度暂时不可用" }
            else if nodeProcess?.isRunning == true && endpointPort != nil { status.title = "实时更新已连接" }
            else { status.title = "正在连接" }
        }
        if let retry = menu.item(withTag: 101) {
            retry.isEnabled = serviceUnavailable || nodeProcess?.isRunning != true
        }
        if let pin = menu.item(withTag: 102) { pin.state = panel?.level == .floating ? .on : .off }
    }
}

@main
private struct ProgressApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
