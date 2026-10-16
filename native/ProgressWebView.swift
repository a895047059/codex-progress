import AppKit
import WebKit

// An NSPanel treats Escape as closing the window. Give web dialogs and menus
// the first opportunity to close, as they do in an ordinary browser.
@MainActor
final class ProgressWebView: WKWebView {
    private var startupView: WKWebView?

    func showStartupLoading() {
        guard startupView == nil,
              let url = Bundle.main.resourceURL?.appendingPathComponent("server/web/startup.html") else { return }
        let loading = WKWebView(frame: bounds)
        loading.autoresizingMask = [.width, .height]
        loading.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        addSubview(loading)
        startupView = loading
    }

    func finishStartupLoading() {
        callAsyncJavaScript("""
        if (document.documentElement.dataset.tasksReady !== 'true') {
          await new Promise(resolve => window.addEventListener('tasks-ready', resolve, {once:true}));
        }
        return true;
        """, arguments: [:], in: nil, in: .page, completionHandler: { [weak self] result in
            guard case .success = result else { return }
            self?.startupView?.removeFromSuperview()
            self?.startupView = nil
        })
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { dismissWebOverlay(); return }
        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        dismissWebOverlay()
    }

    private func dismissWebOverlay() {
        evaluateJavaScript("""
        (() => {
          const dialogs = [...document.querySelectorAll('dialog[open]')];
          if (dialogs.length) { dialogs[dialogs.length - 1].close(); return; }
          document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
        })()
        """, completionHandler: nil)
    }
}
