import AppKit

@MainActor
final class StatusBorderAnimation {
    private(set) var frameRevision = 0
    var isRunning: Bool { timer != nil }
    private weak var button: NSStatusBarButton?
    private var baseImage: NSImage?
    private var accent = NSColor.systemGreen
    private var timer: Timer?
    private let startedAt = ProcessInfo.processInfo.systemUptime
    private static let cornerLength = CGFloat.pi * 2
    private static let pathLength = 220 + cornerLength * 2

    func update(base: NSImage, accent: NSColor, button: NSStatusBarButton) {
        self.baseImage = base
        self.accent = accent
        self.button = button
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            timer?.invalidate()
            timer = nil
        } else if timer == nil {
            let timer = Timer(timeInterval: 1 / 24, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.drawFrame() }
            }
            self.timer = timer
            RunLoop.main.add(timer, forMode: .common)
        }
        drawFrame()
    }

    private func drawFrame() {
        guard let button, let baseImage else { timer?.invalidate(); timer = nil; return }
        let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if reduced { timer?.invalidate(); timer = nil }
        let phase = (ProcessInfo.processInfo.systemUptime - startedAt).truncatingRemainder(dividingBy: 5.2) / 5.2
        var frame = baseImage
        if !reduced {
            button.effectiveAppearance.performAsCurrentDrawingAppearance {
                frame = Self.render(base: baseImage, accent: accent, phase: phase)
            }
        }
        let attachment = NSTextAttachment()
        attachment.image = frame
        attachment.bounds = NSRect(x: 0, y: -5, width: 114, height: 20)
        button.attributedTitle = NSAttributedString(attachment: attachment)
        frameRevision &+= 1
    }

    // The gap is intentional: the light fades at the open left edge, never cuts across it.
    static func render(base: NSImage, accent: NSColor, phase: Double) -> NSImage {
        let image = NSImage(size: base.size)
        image.lockFocus()
        base.draw(at: .zero, from: .zero, operation: .sourceOver, fraction: 1)
        let distance = CGFloat(phase) * (pathLength + 22)
        if distance <= pathLength {
            for index in stride(from: 18, through: 0, by: -1) {
                let sample = distance - CGFloat(index) * 0.85
                guard sample >= 0, sample <= pathLength else { continue }
                let point = point(at: sample)
                let fade = min(1, min(sample / 7, (pathLength - sample) / 7))
                let strength = CGFloat(1 - Double(index) / 19)
                let radius: CGFloat = index == 0 ? 1.05 : 0.38
                accent.withAlphaComponent(fade * strength * (index == 0 ? 0.95 : 0.65)).setFill()
                NSBezierPath(ovalIn: NSRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)).fill()
            }
        }
        image.unlockFocus()
        image.isTemplate = false
        return image
    }

    private static func point(at distance: CGFloat) -> NSPoint {
        if distance <= 105 { return NSPoint(x: 3 + distance, y: 19) }
        var remaining = distance - 105
        if remaining <= cornerLength {
            let angle = CGFloat.pi / 2 - remaining / 4
            return NSPoint(x: 108 + 4 * cos(angle), y: 15 + 4 * sin(angle))
        }
        remaining -= cornerLength
        if remaining <= 10 { return NSPoint(x: 112, y: 15 - remaining) }
        remaining -= 10
        if remaining <= cornerLength {
            let angle = -remaining / 4
            return NSPoint(x: 108 + 4 * cos(angle), y: 5 + 4 * sin(angle))
        }
        return NSPoint(x: 108 - (remaining - cornerLength), y: 1)
    }
}
