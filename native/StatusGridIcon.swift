import AppKit

public struct StatusGridCell: Equatable {
    public let sourceIndex: Int?
    public let status: String

    public init(sourceIndex: Int?, status: String) {
        self.sourceIndex = sourceIndex
        self.status = status
    }
}

public enum StatusGridSelection {
    public static let cellCount = 9

    public static func select(tasks: [[String: Any]], threadStatus: String) -> [StatusGridCell] {
        let cells = tasks.enumerated().map { index, task in
            let taskStatus = task["status"] as? String ?? "pending"
            let status = taskStatus == "in_progress" && ["interrupted", "failed"].contains(threadStatus)
                ? "failed"
                : taskStatus
            return StatusGridCell(sourceIndex: index, status: status)
        }

        guard cells.count > cellCount else {
            return cells + (cells.count..<cellCount).map { _ in
                StatusGridCell(sourceIndex: nil, status: "empty")
            }
        }

        let center = cells.firstIndex(where: { $0.status == "in_progress" })
            ?? cells.firstIndex(where: { $0.status != "completed" })
            ?? 0
        let start = min(max(center - cellCount / 2, 0), cells.count - cellCount)
        return Array(cells[start..<(start + cellCount)])
    }
}

@MainActor
public final class StatusGridIcon {
    public private(set) var cells: [StatusGridCell] = []
    public private(set) var animationRunning = false
    public private(set) var frameRevision = 0

    private weak var button: NSStatusBarButton?
    private var timer: Timer?
    private var phase = 0.0

    private static let framesPerSecond = 12.0
    private static let animationPeriod = 1.8

    public init(button: NSStatusBarButton) {
        self.button = button
        cells = StatusGridSelection.select(tasks: [], threadStatus: "idle")
        drawCurrentFrame()
    }

    public func update(tasks: [[String: Any]], threadStatus: String) {
        cells = StatusGridSelection.select(tasks: tasks, threadStatus: threadStatus)

        let shouldAnimate = cells.contains(where: { $0.status == "in_progress" })
            && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if shouldAnimate {
            startAnimationIfNeeded()
        } else {
            stopAnimation()
        }
        drawCurrentFrame()
    }

    public static func render(cells: [StatusGridCell], phase: Double = 0) -> NSImage {
        let size = NSSize(width: 19, height: 19)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.clear.setFill()
        NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()

        let boundedPhase = phase.isFinite ? phase - floor(phase) : 0
        let wave = (sin(boundedPhase * 2 * .pi) + 1) / 2
        for slot in 0..<StatusGridSelection.cellCount {
            let cell = cells.indices.contains(slot)
                ? cells[slot]
                : StatusGridCell(sourceIndex: nil, status: "empty")
            let row = slot / 3
            let column = slot % 3
            let rect = NSRect(x: CGFloat(1 + column * 6),
                              y: CGFloat(19 - (1 + row * 6 + 4)),
                              width: 4,
                              height: 4)

            if cell.status == "in_progress" {
                let expansion = CGFloat(wave * 0.8)
                let ring = rect.insetBy(dx: -expansion, dy: -expansion)
                NSColor.systemYellow.withAlphaComponent(CGFloat(0.42 * (1 - wave))).setStroke()
                let ringPath = NSBezierPath(ovalIn: ring)
                ringPath.lineWidth = 0.7
                ringPath.stroke()
            }

            color(for: cell.status, activeWave: wave).setFill()
            NSBezierPath(roundedRect: rect, xRadius: 0.8, yRadius: 0.8).fill()
        }

        image.unlockFocus()
        image.isTemplate = false
        return image
    }

    private static func color(for status: String, activeWave: Double) -> NSColor {
        switch status {
        case "completed":
            return NSColor(srgbRed: 0.22, green: 0.63, blue: 0.36, alpha: 1)
        case "pending":
            return .tertiaryLabelColor
        case "failed", "blocked":
            return NSColor(srgbRed: 0.82, green: 0.29, blue: 0.29, alpha: 1)
        case "in_progress":
            return NSColor(srgbRed: 0.90, green: 0.68, blue: 0.15, alpha: CGFloat(0.78 + activeWave * 0.22))
        case "empty":
            return .quaternaryLabelColor
        default:
            return .tertiaryLabelColor
        }
    }

    private func startAnimationIfNeeded() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1 / Self.framesPerSecond, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.advanceFrame()
            }
        }
        self.timer = timer
        animationRunning = true
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopAnimation() {
        timer?.invalidate()
        timer = nil
        animationRunning = false
        phase = 0
    }

    private func advanceFrame() {
        guard cells.contains(where: { $0.status == "in_progress" }),
              !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            stopAnimation()
            drawCurrentFrame()
            return
        }
        phase = (phase + 1 / Self.framesPerSecond / Self.animationPeriod).truncatingRemainder(dividingBy: 1)
        drawCurrentFrame()
    }

    private func drawCurrentFrame() {
        guard let button else { return }
        button.image = Self.render(cells: cells, phase: phase)
        frameRevision &+= 1
    }
}
