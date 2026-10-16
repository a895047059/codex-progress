import AppKit
import Foundation

@main
private struct StatusGridIconTests {
    @MainActor
    static func main() throws {
        try testSelectionWindows()
        try testRenderingAndUpdate()
        try writePreview()
    }

    private static func makeTasks(_ statuses: [String]) -> [[String: Any]] {
        statuses.enumerated().map { index, status in
            ["id": "task-\(index)", "status": status]
        }
    }

    private static func assertIndices(_ cells: [StatusGridCell], _ expected: Range<Int>) {
        precondition(cells.count == 9, "selection must always contain nine cells")
        precondition(cells.compactMap(\.sourceIndex) == Array(expected), "unexpected source window")
    }

    private static func testSelectionWindows() throws {
        var statuses = Array(repeating: "pending", count: 19)
        statuses[9] = "in_progress"
        var cells = StatusGridSelection.select(tasks: makeTasks(statuses), threadStatus: "running")
        assertIndices(cells, 5..<14)
        precondition(cells[4].status == "in_progress")

        statuses = Array(repeating: "completed", count: 19)
        statuses[0] = "in_progress"
        cells = StatusGridSelection.select(tasks: makeTasks(statuses), threadStatus: "running")
        assertIndices(cells, 0..<9)

        statuses = Array(repeating: "completed", count: 19)
        statuses[18] = "in_progress"
        cells = StatusGridSelection.select(tasks: makeTasks(statuses), threadStatus: "running")
        assertIndices(cells, 10..<19)
        precondition(cells[8].status == "in_progress")

        cells = StatusGridSelection.select(tasks: [], threadStatus: "idle")
        precondition(cells.count == 9 && cells.allSatisfy { $0.sourceIndex == nil && $0.status == "empty" })

        cells = StatusGridSelection.select(tasks: makeTasks(Array(repeating: "completed", count: 19)),
                                           threadStatus: "completed")
        assertIndices(cells, 0..<9)
        precondition(cells.allSatisfy { $0.status == "completed" })

        statuses = Array(repeating: "completed", count: 19)
        statuses[14] = "in_progress"
        cells = StatusGridSelection.select(tasks: makeTasks(statuses), threadStatus: "interrupted")
        assertIndices(cells, 10..<19)
        precondition(cells[4].status == "failed", "interrupted in-progress task should be red")

        cells = StatusGridSelection.select(tasks: makeTasks(["completed", "in_progress", "pending"]),
                                           threadStatus: "failed")
        precondition(cells[1].status == "failed", "failed thread should mark in-progress task red")
        cells = StatusGridSelection.select(tasks: makeTasks(["completed", "blocked", "pending"]),
                                           threadStatus: "running")
        assertIndices(cells, 0..<3)
        precondition(cells[1].status == "blocked")

        statuses = Array(repeating: "completed", count: 19)
        statuses[10] = "pending"
        cells = StatusGridSelection.select(tasks: makeTasks(statuses), threadStatus: "running")
        assertIndices(cells, 6..<15)

        let active = StatusGridSelection.select(tasks: makeTasks(["pending", "in_progress", "pending"]),
                                                threadStatus: "running")
        let completed = StatusGridSelection.select(tasks: makeTasks(["pending", "completed", "pending"]),
                                                   threadStatus: "completed")
        precondition(active[1].status == "in_progress" && completed[1].status == "completed",
                     "selection must reflect updated task values")
        print("selection: passed")
    }

    @MainActor
    private static func testRenderingAndUpdate() throws {
        let button = NSStatusBarButton(frame: NSRect(x: 0, y: 0, width: 19, height: 19))
        let icon = StatusGridIcon(button: button)
        precondition(icon.frameRevision == 1)
        icon.update(tasks: makeTasks(["pending", "in_progress", "pending"]), threadStatus: "running")
        precondition(icon.cells.count == 9 && icon.cells[1].status == "in_progress")
        precondition(icon.frameRevision == 2 && button.image?.isTemplate == false)

        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            precondition(icon.animationRunning, "active task should start animation")
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            precondition(icon.frameRevision > 2, "animation should draw subsequent frames")
        } else {
            precondition(!icon.animationRunning, "reduced motion should suppress animation")
        }

        icon.update(tasks: makeTasks(["pending", "completed", "pending"]), threadStatus: "completed")
        precondition(!icon.animationRunning, "completed task should stop animation")
        let completedRevision = icon.frameRevision
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        precondition(icon.frameRevision == completedRevision, "stopped animation must not draw frames")
        print("render/update: passed")
    }

    @MainActor
    private static func writePreview() throws {
        let variants: [(String, [StatusGridCell])] = [
            ("pending", StatusGridSelection.select(tasks: makeTasks(Array(repeating: "pending", count: 9)), threadStatus: "running")),
            ("center", StatusGridSelection.select(tasks: makeTasks(["pending", "pending", "pending", "pending", "in_progress", "pending", "pending", "pending", "pending"]), threadStatus: "running")),
            ("edge", StatusGridSelection.select(tasks: makeTasks(Array(repeating: "pending", count: 18) + ["in_progress"]), threadStatus: "running")),
            ("complete", StatusGridSelection.select(tasks: makeTasks(Array(repeating: "completed", count: 9)), threadStatus: "completed")),
            ("exception", StatusGridSelection.select(tasks: makeTasks(["failed", "blocked", "in_progress", "pending", "pending", "pending", "pending", "pending", "pending"]), threadStatus: "interrupted")),
            ("row order", StatusGridSelection.select(tasks: makeTasks(["failed", "blocked", "pending", "in_progress", "pending", "failed", "completed", "completed", "pending"]), threadStatus: "running"))
        ]

        let columns = 3
        let tileWidth = 120
        let tileHeight = 134
        let preview = NSImage(size: NSSize(width: columns * tileWidth, height: 2 * tileHeight))
        preview.lockFocus()
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(rect: NSRect(origin: .zero, size: preview.size)).fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11),
            .foregroundColor: NSColor.labelColor
        ]
        for (index, variant) in variants.enumerated() {
            let column = index % columns
            let row = index / columns
            let x = column * tileWidth
            let y = (1 - row) * tileHeight
            let icon = StatusGridIcon.render(cells: variant.1, phase: 0.3)
            icon.draw(in: NSRect(x: x + 22, y: y + 37, width: 76, height: 76))
            (variant.0 as NSString).draw(at: NSPoint(x: x + 8, y: y + 12), withAttributes: attributes)
        }
        preview.unlockFocus()

        let directory = URL(fileURLWithPath: "work", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let output = directory.appendingPathComponent("status-grid-icon-preview.png")
        guard let tiff = preview.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "StatusGridIconTests", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "could not encode preview image"])
        }
        try png.write(to: output, options: .atomic)
        print("preview: \(output.path) (\(preview.size.width)x\(preview.size.height))")
    }
}
