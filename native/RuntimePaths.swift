import Foundation

// Bundle resources are read-only; all mutable state belongs to the current user.
enum RuntimePaths {
    static var node: URL {
        Bundle.main.resourceURL!.appendingPathComponent("runtime/node")
    }
    static var runtime: URL {
        if let override = ProcessInfo.processInfo.environment["CODEX_PROGRESS_RUNTIME"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Codex Progress/runtime", isDirectory: true)
    }
}
