// DiagLog.swift — 诊断日志落盘（所有 TX/RX/蓝牙事件/页面告警写入同一个文件）
//
// 位置：<App Documents>/logs/zeeho-<时间戳>.log
// Info.plist 已开启 UIFileSharingEnabled 与 LSSupportsOpeningDocumentsInPlace，
// 因此可以在「文件」App → 我的 iPhone/极核自主诊断 里直接取走，
// 也可以用诊断页「更多功能 → 诊断日志文件 → 分享/导出日志」走系统分享面板。
//
// 所有写操作都在同一条串行队列上，既不阻塞主线程，也保证行序不乱。
import Foundation
import UIKit

final class DiagLog {

    static let shared = DiagLog()

    private let queue = DispatchQueue(label: "com.zeeho.diag.log")
    private let maxBytes = 2 * 1024 * 1024
    private let keep = 5

    private var handle: FileHandle?
    private(set) var fileURL: URL?
    private var bytes = 0
    private var lines = 0

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm:ss.SSS"
        return f
    }()

    private init() {
        queue.async { [weak self] in self?.openLocked() }
    }

    // MARK: - 内部（只在 queue 上执行）

    private func dirURL() -> URL? {
        guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return nil
        }
        let d = docs.appendingPathComponent("logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func openLocked() {
        guard let dir = dirURL() else { return }
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        let url = dir.appendingPathComponent("zeeho-\(f.string(from: Date())).log")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try? FileHandle(forWritingTo: url)
        fileURL = url
        bytes = 0
        lines = 0
        pruneLocked(dir)
        rawLocked("SYS", "==== 日志开始 ====")
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        rawLocked("SYS", "app \(v) (\(b)) | \(UIDevice.current.model) | iOS \(UIDevice.current.systemVersion)")
        rawLocked("SYS", "文件: \(url.path)")
    }

    private func rawLocked(_ tag: String, _ text: String) {
        guard let h = handle else { return }
        let line = "[\(Self.stamp.string(from: Date()))] \(tag) \(text)\n"
        guard let data = line.data(using: .utf8) else { return }
        do {
            try h.write(contentsOf: data)
            bytes += data.count
            lines += 1
        } catch {
            // 日志写失败不应影响诊断流程
        }
    }

    private func rotateLocked() {
        try? handle?.close()
        handle = nil
        openLocked()
    }

    private func pruneLocked(_ dir: URL) {
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let sorted = items.sorted { a, b in
            let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return da > db
        }
        for u in sorted.dropFirst(keep) {
            try? FileManager.default.removeItem(at: u)
        }
    }

    // MARK: - 对外

    /// 写一行日志（异步，不阻塞调用方）
    func write(_ tag: String, _ text: String) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.rawLocked(tag, text)
            if self.bytes > self.maxBytes { self.rotateLocked() }
        }
    }

    /// 当前日志文件（分享用）
    func currentURL() -> URL? {
        var url: URL?
        queue.sync { url = self.fileURL }
        return url
    }

    func dirPath() -> String { dirURL()?.path ?? "" }

    func infoJSON() -> String {
        var out = "{}"
        queue.sync { out = self.infoLockedJSON() }
        return out
    }

    /// 只在 queue 上执行
    private func infoLockedJSON() -> String {
        let f = fileURL
        let exists = (f != nil) && FileManager.default.fileExists(atPath: f!.path)
        var size = 0
        if exists, let url = f,
           let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let sz = attrs[.size] as? Int {
            size = sz
        }
        var d: [String: Any] = [:]
        d["path"] = f?.path ?? ""
        d["dir"] = dirURL()?.path ?? ""
        d["name"] = f?.lastPathComponent ?? ""
        d["size"] = size
        d["lines"] = lines
        d["exists"] = exists
        if let data = try? JSONSerialization.data(withJSONObject: d),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return "{}"
    }

    @discardableResult
    func clear() -> Bool {
        queue.async { [weak self] in
            guard let self = self else { return }
            try? self.handle?.close()
            self.handle = nil
            if let dir = self.dirURL(), let items = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) {
                for u in items { try? FileManager.default.removeItem(at: u) }
            }
            self.openLocked()
        }
        return true
    }
}
