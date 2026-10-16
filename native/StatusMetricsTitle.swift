import AppKit

@MainActor
final class StatusMetricsTitle {
    private enum Page: Int, CaseIterable {
        case total
        case rate
        case current
    }

    private let rotationInterval: TimeInterval = 4
    private var page = Page.total
    private var lastRotationAt: TimeInterval?
    private var valueText = "—M"
    private var progressText = "0/0"
    private(set) var accessibleTitle = ""
    private let borderAnimation = StatusBorderAnimation()
    var borderAnimating: Bool { borderAnimation.isRunning }
    var borderFrameRevision: Int { borderAnimation.frameRevision }

    // The grid, metric and progress each keep their own space across rotations.
    static let statusWidth: CGFloat = 146

    func apply(to button: NSStatusBarButton, snapshot: [String: Any], completed: Int, taskCount: Int) {
        let description = title(snapshot: snapshot, completed: completed, taskCount: taskCount)
        accessibleTitle = description
        let symbols: [Page: String] = [.total: "square.stack.fill", .rate: "gauge.medium", .current: "doc.text.fill"]
        let symbolName = symbols[page]!
        let accents: [Page: NSColor] = [
            .total: NSColor(srgbRed: 0.23, green: 0.51, blue: 0.40, alpha: 1),
            .rate: NSColor(srgbRed: 0.70, green: 0.47, blue: 0.17, alpha: 1),
            .current: NSColor(srgbRed: 0.27, green: 0.49, blue: 0.65, alpha: 1)
        ]
        let accent = accents[page]!
        let metric = valueText, progress = progressText
        var rendered = NSImage(size: NSSize(width: 114, height: 20))
        button.effectiveAppearance.performAsCurrentDrawingAppearance {
            rendered = NSImage(size: NSSize(width: 114, height: 20), flipped: false) { _ in
                let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
                let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?.withSymbolConfiguration(config)
                let tinted = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
                    symbol?.draw(in: rect)
                    accent.setFill()
                    rect.fill(using: .sourceAtop)
                    return true
                }
                tinted.draw(in: NSRect(x: 0, y: 3, width: 14, height: 14))
                let paragraph = NSMutableParagraphStyle()
                paragraph.alignment = .left
                paragraph.lineBreakMode = .byTruncatingTail
                var attributes: [NSAttributedString.Key: Any] = [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .medium),
                    .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph
                ]
                let unit = metric.hasSuffix("M") ? "M" : "/s"
                let value = String(metric.dropLast(unit.count))
                let unitFont = NSFont.systemFont(ofSize: 9.5, weight: .medium)
                let unitWidth = (unit as NSString).size(withAttributes: [.font: unitFont]).width
                var metricFontSize: CGFloat = 11.5
                while metricFontSize > 8 && (value as NSString).size(withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: metricFontSize, weight: .medium)]).width + unitWidth + 2 > 54 { metricFontSize -= 0.5 }
                attributes[.font] = NSFont.monospacedDigitSystemFont(ofSize: metricFontSize, weight: .medium)
                let valueWidth = (value as NSString).size(withAttributes: attributes).width
                (value as NSString).draw(at: NSPoint(x: 19, y: 3.5), withAttributes: attributes)
                attributes[.font] = unitFont
                attributes[.foregroundColor] = NSColor.secondaryLabelColor
                (unit as NSString).draw(at: NSPoint(x: 20.5 + valueWidth, y: 4), withAttributes: attributes)
                NSColor.labelColor.withAlphaComponent(0.16).setFill()
                NSRect(x: 77, y: 4.5, width: 0.5, height: 11).fill()
                var progressSize: CGFloat = 11
                while progressSize > 8 && (progress as NSString).size(withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: progressSize, weight: .medium)]).width > 30 { progressSize -= 0.5 }
                attributes[.font] = NSFont.monospacedDigitSystemFont(ofSize: progressSize, weight: .medium)
                attributes[.foregroundColor] = NSColor.labelColor
                (progress as NSString).draw(in: NSRect(x: 82, y: 3.5, width: 30, height: 15), withAttributes: attributes)
                // A quiet open-left enclosure ties the metrics to the nine-cell mark.
                let enclosure = NSBezierPath()
                enclosure.move(to: NSPoint(x: 3, y: 19))
                enclosure.line(to: NSPoint(x: 108, y: 19))
                enclosure.curve(to: NSPoint(x: 112, y: 15), controlPoint1: NSPoint(x: 110.2, y: 19), controlPoint2: NSPoint(x: 112, y: 17.2))
                enclosure.line(to: NSPoint(x: 112, y: 5))
                enclosure.curve(to: NSPoint(x: 108, y: 1), controlPoint1: NSPoint(x: 112, y: 2.8), controlPoint2: NSPoint(x: 110.2, y: 1))
                enclosure.line(to: NSPoint(x: 3, y: 1))
                enclosure.lineWidth = 0.6
                enclosure.lineCapStyle = .round
                NSColor.labelColor.withAlphaComponent(0.28).setStroke()
                enclosure.stroke()
                return true
            }
            // Render now so subsequent appearance changes cannot reuse a stale lazy drawing block.
            _ = rendered.tiffRepresentation
        }
        borderAnimation.update(base: rendered, accent: accent, button: button)
        button.toolTip = "\(description.trimmingCharacters(in: .whitespaces)) · 点击打开任务进度 · 右键查看更多操作"
        button.setAccessibilityLabel(description)
    }

    func title(snapshot: [String: Any], completed: Int, taskCount: Int,
               at uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> String {
        rotateIfNeeded(at: uptime)

        let threads = snapshot["threads"] as? [[String: Any]] ?? []
        let totalTokens = sumMainThreadTokens(threads)
        let activeId = snapshot["activeId"] as? String
        let currentThread = threads.first { ($0["id"] as? String) == activeId } ?? threads.first
        let currentMetrics = currentThread?["metrics"] as? [String: Any] ?? [:]
        let currentTokens = metricNumber(currentMetrics["totalTokens"])
        let progress = " \(completed)/\(taskCount)"
        progressText = "\(completed)/\(taskCount)"

        switch page {
        case .total:
            valueText = formatMillions(totalTokens)
            return " total:\(formatMillions(totalTokens))\(progress)"
        case .rate:
            let rate = formatRate(currentMetrics["rate"], estimated: currentMetrics["rateEstimated"] as? Bool == true)
            valueText = rate.replacingOccurrences(of: "tok/s", with: "/s")
            return " \(rate)\(progress)"
        case .current:
            valueText = formatMillions(currentTokens)
            return " current:\(formatMillions(currentTokens))\(progress)"
        }
    }

    private func rotateIfNeeded(at uptime: TimeInterval) {
        guard let lastRotationAt else {
            self.lastRotationAt = uptime
            return
        }
        guard uptime >= lastRotationAt + rotationInterval else { return }
        let elapsedIntervals = Int((uptime - lastRotationAt) / rotationInterval)
        page = Page(rawValue: (page.rawValue + elapsedIntervals) % Page.allCases.count) ?? .total
        self.lastRotationAt = lastRotationAt + Double(elapsedIntervals) * rotationInterval
    }

    private func sumMainThreadTokens(_ threads: [[String: Any]]) -> Double? {
        var total = 0.0
        var found = false
        for thread in threads {
            let metrics = thread["metrics"] as? [String: Any] ?? [:]
            guard let value = metricNumber(metrics["totalTokens"]) else { continue }
            total += value
            found = true
        }
        return found && total.isFinite ? total : nil
    }

    private func metricNumber(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        let result = number.doubleValue
        return result.isFinite && result >= 0 ? result : nil
    }

    private func formatMillions(_ value: Double?) -> String {
        guard let value else { return "—M" }
        return String(format: "%.1fM", value / 1_000_000)
    }

    private func formatRate(_ value: Any?, estimated: Bool) -> String {
        guard let number = metricNumber(value) else { return "—tok/s" }
        let formatted = String(format: number >= 100 ? "%.0f" : "%.1f", number)
        let compact = formatted.replacingOccurrences(of: "\\.0$", with: "", options: .regularExpression)
        return "\(estimated ? "≈" : "")\(compact)tok/s"
    }
}
