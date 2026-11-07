import Foundation

/// What the home-screen widgets show, shared between the app and the widget extension through the App Group.
/// The page writes it (mobile/widgets-phone.js → WidgetDataPlugin) every time it saves, because only the
/// page can read the synced lists (they are end-to-end encrypted). Android's widgets fetch the rows
/// themselves instead (SyncStore.java).
enum WidgetShared {
    static let group = "group.com.jartro.tasks"
    static let snapshotKey = "widget.snapshot"
    static let pendingKey = "widget.pendingDone"

    static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }

    static func snapshot() -> WidgetSnapshot? {
        guard let data = defaults.data(forKey: snapshotKey) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }

    static func saveSnapshot(_ data: Data) { defaults.set(data, forKey: snapshotKey) }

    /// Tasks checked off on a widget that the app hasn't saved yet: hidden from the widgets meanwhile.
    static func pendingDone() -> [String] { defaults.stringArray(forKey: pendingKey) ?? [] }

    static func addPending(_ id: String) {
        var ids = pendingDone()
        if !ids.contains(id) { ids.append(id) }
        defaults.set(Array(ids.suffix(200)), forKey: pendingKey)
    }

    static func takePending() -> [String] {
        let ids = pendingDone()
        defaults.removeObject(forKey: pendingKey)
        return ids
    }
}

struct WidgetSnapshot: Codable {
    var at: Double?
    /// open to-dos in the personal, work and school lists
    var open: [WidgetTask]?
    /// the Agent board and the next grocery order, already worded by the page (nil when the Agent tab isn't set up)
    var agent: WidgetList?
    var groceries: WidgetList?
    var school: Bool?
}

struct WidgetTask: Codable, Hashable {
    var id: String
    var title: String
    var ch: String?
    var due: String?   // YYYY-MM-DD
    var time: String?  // HH:MM
    var tag: String?
    var kind: String?
    var ord: Int?      // place in his list, for the undated ones
}

struct WidgetList: Codable {
    var header: String
    var tone: String?
    var rows: [WidgetRow]
}

struct WidgetRow: Codable, Hashable, Identifiable {
    var id: String
    var title: String
    var sub: String?
    var label: String?
    var tone: String?
    var checkable: Bool?
    var openId: String? // the task a tap opens, when it isn't id (a grocery item opens its grocery task)
}
