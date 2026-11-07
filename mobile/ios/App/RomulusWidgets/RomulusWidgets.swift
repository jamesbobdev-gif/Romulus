import WidgetKit
import SwiftUI
import AppIntents

/// Romulus's home-screen widgets: the iPhone versions of the five Android ones (TodayWidgetProvider and friends).
/// They draw what the app last saved (WidgetShared); a row's circle checks it off on the spot, and the app
/// saves it the next time it opens. Tapping a row opens it in the app.
@main
struct RomulusWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        ListWidget()
        SchoolWidget()
        AgentWidget()
        QuickAddWidget()
    }
}

/* ---------- timeline ---------- */

struct DayEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    let pending: Set<String>
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> DayEntry { DayEntry(date: Date(), snapshot: nil, pending: []) }

    func getSnapshot(in context: Context, completion: @escaping (DayEntry) -> Void) { completion(current()) }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DayEntry>) -> Void) {
        // "today", "tomorrow" and "overdue" change at midnight even when nothing else does
        let midnight = Calendar.current.startOfDay(for: Date().addingTimeInterval(86400))
        completion(Timeline(entries: [current()], policy: .after(midnight)))
    }

    private func current() -> DayEntry {
        DayEntry(date: Date(), snapshot: WidgetShared.snapshot(), pending: Set(WidgetShared.pendingDone()))
    }
}

/* ---------- checking a task off ---------- */

struct CheckOffIntent: AppIntent {
    static var title: LocalizedStringResource = "Check off"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Task") var id: String

    init() {}
    init(id: String) { self.id = id }

    func perform() async throws -> some IntentResult {
        WidgetShared.addPending(id)
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

/* ---------- rows ---------- */

struct Row: Identifiable, Hashable {
    let id: String
    let title: String
    let sub: String
    let label: String
    let tone: String
    let checkable: Bool
    var openId: String? = nil // the task a tap opens, when it isn't id
}

enum Tone {
    static func color(_ tone: String?) -> Color {
        switch tone {
        case "late": return Color(red: 0.75, green: 0.23, blue: 0.17)
        case "accent": return Color(red: 0.15, green: 0.26, blue: 0.78)
        case "warn": return Color(red: 0.54, green: 0.35, blue: 0.0)
        case "ok": return Color(red: 0.18, green: 0.49, blue: 0.20)
        default: return .secondary
        }
    }
}

enum Dates {
    static func day(_ s: String) -> Date? {
        let p = s.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }

    static func diff(_ s: String) -> Int? {
        guard let d = day(s) else { return nil }
        return Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date()), to: d).day
    }

    static func minutes(_ time: String?) -> Int {
        let p = (time ?? "").split(separator: ":").compactMap { Int($0) }
        return p.count == 2 ? p[0] * 60 + p[1] : 0
    }

    /// the same words as the app and the Android widgets: "overdue 2d", "today 3:00pm", "tomorrow", "Fri", "12 Nov"
    static func label(_ due: String, _ time: String?, _ diff: Int) -> String {
        var t = ""
        if let time, time.contains(":") {
            let m = minutes(time)
            let h = m / 60 % 12 == 0 ? 12 : m / 60 % 12
            t = String(format: " %d:%02d%@", h, m % 60, m / 60 < 12 ? "am" : "pm")
        }
        if diff < 0 { return "overdue \(-diff)d" + t }
        if diff == 0 { return "today" + t }
        if diff == 1 { return "tomorrow" + t }
        guard let d = day(due) else { return due }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = diff < 7 ? "EEE" : "d MMM"
        return f.string(from: d) + t
    }

    static func sortKey(_ t: WidgetTask) -> Double {
        guard let due = t.due, let d = day(due) else { return .greatestFiniteMagnitude }
        return d.timeIntervalSince1970 + Double(minutes(t.time) * 60)
    }
}

/// The lists, worked out from the snapshot the way ListWidgetService.java does it.
enum Lists {
    static func open(_ e: DayEntry) -> [WidgetTask] {
        (e.snapshot?.open ?? []).filter { !e.pending.contains($0.id) }
    }

    static func dated(_ t: WidgetTask, sub: String) -> Row {
        guard let due = t.due, let diff = Dates.diff(due) else {
            return Row(id: t.id, title: t.title, sub: sub, label: "", tone: "muted", checkable: true)
        }
        return Row(id: t.id, title: t.title, sub: sub, label: Dates.label(due, t.time, diff),
                   tone: diff < 0 ? "late" : diff <= 1 ? "accent" : "muted", checkable: true)
    }

    static func today(_ e: DayEntry) -> (String, String, [Row]) {
        var overdue = 0, today = 0
        let items = open(e).filter { t in
            guard let due = t.due, let diff = Dates.diff(due), diff <= 0 else { return false }
            if diff < 0 { overdue += 1 } else { today += 1 }
            return true
        }.sorted { Dates.sortKey($0) < Dates.sortKey($1) }
        let rows = items.map { t in
            dated(t, sub: t.ch == "school" ? "school" + (t.tag.map { " · " + $0 } ?? "") : (t.tag ?? ""))
        }
        let header = overdue > 0 && today > 0 ? "\(overdue) overdue · \(today) today"
            : overdue > 0 ? "\(overdue) overdue" : today > 0 ? "\(today) today" : "all clear"
        return (header, overdue > 0 ? "late" : "muted", rows)
    }

    /// every open personal task: dated ones by when they're due, then the rest in list order
    static func personal(_ e: DayEntry) -> (String, String, [Row]) {
        let items = open(e).filter { $0.ch == "personal" }.sorted {
            let a = Dates.sortKey($0), b = Dates.sortKey($1)
            return a != b ? a < b : ($0.ord ?? 0) < ($1.ord ?? 0)
        }
        var overdue = 0, today = 0
        for t in items { if let d = t.due.flatMap(Dates.diff) { if d < 0 { overdue += 1 } else if d == 0 { today += 1 } } }
        let header = overdue > 0 && today > 0 ? "\(overdue) overdue · \(today) today"
            : overdue > 0 ? "\(overdue) overdue" : today > 0 ? "\(today) due today" : "\(items.count) open"
        return (header, overdue > 0 ? "late" : "muted", items.map { dated($0, sub: $0.tag ?? "") })
    }

    static func school(_ e: DayEntry) -> (String, String, [Row]) {
        let items = open(e).filter { $0.ch == "school" }.sorted { Dates.sortKey($0) < Dates.sortKey($1) }
        var next: (String, Int)?
        for t in items where t.kind == "exam" {
            if let d = t.due.flatMap(Dates.diff), d >= 0, d < (next?.1 ?? Int.max) { next = (t.title, d) }
        }
        let rows = items.map { t -> Row in
            let kind = t.kind ?? "regular"
            let sub = (t.tag ?? "") + (kind == "regular" ? "" : (t.tag == nil ? "" : " · ") + kind)
            return dated(t, sub: sub)
        }
        if let n = next {
            let (title, d) = n
            let short = title.replacingOccurrences(of: "\\s*\\(.*\\)$", with: "", options: .regularExpression)
            return (short + (d == 0 ? " today" : d == 1 ? " tomorrow" : " in \(d) days"), d <= 3 ? "late" : "accent", rows)
        }
        return ("\(rows.count) upcoming", "muted", rows)
    }

    static func worded(_ list: WidgetList?, _ e: DayEntry) -> (String, String, [Row]) {
        guard let list else { return ("", "muted", []) }
        let rows = list.rows.filter { !e.pending.contains($0.id) }.map {
            Row(id: $0.id, title: $0.title, sub: $0.sub ?? "", label: $0.label ?? "", tone: $0.tone ?? "muted", checkable: $0.checkable ?? false, openId: $0.openId)
        }
        return (list.header, list.tone ?? "muted", rows)
    }
}

/* ---------- views ---------- */

func hookURL(_ kind: String, _ arg: String) -> URL {
    var c = URLComponents()
    c.scheme = "romulus"
    c.host = "hook"
    c.queryItems = [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "arg", value: arg)]
    return c.url!
}

struct ListView: View {
    @Environment(\.widgetFamily) var family
    let title: String
    let header: String
    let headerTone: String
    let rows: [Row]
    let empty: String
    let tab: String
    let noData: Bool

    var maxRows: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 3
        case .systemExtraLarge: return 10
        default: return 8
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline)
                Spacer(minLength: 4)
                Text(header).font(.caption).foregroundColor(Tone.color(headerTone)).lineLimit(1)
            }
            if noData {
                Text("Open Romulus once to fill this in.").font(.subheadline).foregroundColor(.secondary)
            } else if rows.isEmpty {
                Text(empty).font(.subheadline).foregroundColor(.secondary)
            } else {
                ForEach(rows.prefix(maxRows)) { row in RowView(row: row, compact: family == .systemSmall) }
                if rows.count > maxRows {
                    Text("+\(rows.count - maxRows) more").font(.caption2).foregroundColor(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .widgetURL(hookURL("tab", tab))
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

struct RowView: View {
    let row: Row
    let compact: Bool

    var body: some View {
        HStack(spacing: 8) {
            if row.checkable {
                Button(intent: CheckOffIntent(id: row.id)) {
                    Image(systemName: "circle").font(.body).foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Check off " + row.title)
            }
            Link(destination: hookURL("open", row.openId ?? row.id)) {
                HStack(spacing: 6) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.title).font(.subheadline).lineLimit(1)
                        if !compact && !row.sub.isEmpty {
                            Text(row.sub).font(.caption2).foregroundColor(.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 2)
                    if !compact && !row.label.isEmpty {
                        Text(row.label).font(.caption).foregroundColor(Tone.color(row.tone)).lineLimit(1)
                    }
                }
            }
        }
    }
}

/* ---------- the widgets ---------- */

private let listFamilies: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "today", provider: Provider()) { e in
            let l = Lists.today(e)
            ListView(title: "Today", header: l.0, headerTone: l.1, rows: l.2, empty: "Nothing due today. Nice.", tab: "list", noData: e.snapshot == nil)
        }
        .configurationDisplayName("Today")
        .description("Due today and overdue. Tap the circle to check it off.")
        .supportedFamilies(listFamilies)
    }
}

/// The List widget picks what it shows, like Android's (WidgetListPickerActivity): Personal or Groceries.
enum ListChoice: String, AppEnum {
    case personal, groceries
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "List"
    static var caseDisplayRepresentations: [ListChoice: DisplayRepresentation] = [
        .personal: "Personal",
        .groceries: "Groceries"
    ]
}

struct ListPickIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "List"
    static var description = IntentDescription("Personal: every open task. Groceries: what's on the next order.")
    @Parameter(title: "List", default: .personal) var list: ListChoice
    init() {}
}

struct ListEntry: TimelineEntry {
    let date: Date
    let base: DayEntry
    let choice: ListChoice
}

struct ListProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ListEntry {
        ListEntry(date: Date(), base: DayEntry(date: Date(), snapshot: nil, pending: []), choice: .personal)
    }
    func snapshot(for configuration: ListPickIntent, in context: Context) async -> ListEntry { entry(configuration) }
    func timeline(for configuration: ListPickIntent, in context: Context) async -> Timeline<ListEntry> {
        let midnight = Calendar.current.startOfDay(for: Date().addingTimeInterval(86400))
        return Timeline(entries: [entry(configuration)], policy: .after(midnight))
    }
    private func entry(_ c: ListPickIntent) -> ListEntry {
        let e = DayEntry(date: Date(), snapshot: WidgetShared.snapshot(), pending: Set(WidgetShared.pendingDone()))
        return ListEntry(date: e.date, base: e, choice: c.list)
    }
}

struct ListWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "list", intent: ListPickIntent.self, provider: ListProvider()) { le in
            if le.choice == .groceries {
                let l = Lists.worded(le.base.snapshot?.groceries, le.base)
                ListView(title: "Groceries", header: l.0, headerTone: l.1, rows: l.2,
                         empty: le.base.snapshot?.groceries == nil ? "Set up the Agent tab in Romulus first." : "Nothing due for the next order.",
                         tab: "agent", noData: le.base.snapshot == nil)
            } else {
                let l = Lists.personal(le.base)
                ListView(title: "Personal", header: l.0, headerTone: l.1, rows: l.2, empty: "No open tasks.", tab: "list", noData: le.base.snapshot == nil)
            }
        }
        .configurationDisplayName("List")
        .description("Pick Personal (every open task, tap the circle to check it off) or Groceries (what's on the next order).")
        .supportedFamilies(listFamilies)
    }
}

struct SchoolWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "school", provider: Provider()) { e in
            let l = Lists.school(e)
            ListView(title: "School", header: l.0, headerTone: l.1, rows: l.2,
                     empty: e.snapshot?.school == true ? "Nothing coming up." : "Set up the School tab in Romulus first.",
                     tab: "school", noData: e.snapshot == nil)
        }
        .configurationDisplayName("School")
        .description("Next test countdown and upcoming assignments.")
        .supportedFamilies(listFamilies)
    }
}

struct AgentWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "agent", provider: Provider()) { e in
            let l = Lists.worded(e.snapshot?.agent, e)
            ListView(title: "Agent", header: l.0, headerTone: l.1, rows: l.2,
                     empty: e.snapshot?.agent == nil ? "Set up the Agent tab in Romulus first." : "Nothing waiting or running.",
                     tab: "agent", noData: e.snapshot == nil)
        }
        .configurationDisplayName("Agent")
        .description("What needs your answer, then what Claude and Lupa are working on, what's queued and what they just finished.")
        .supportedFamilies(listFamilies)
    }
}

struct QuickAddWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "quickadd", provider: Provider()) { _ in QuickAddView() }
            .configurationDisplayName("Quick add")
            .description("A new task, or one for Claude.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct QuickButton: Identifiable {
    let label: String
    let icon: String
    let url: URL
    var id: String { label }
}

struct QuickAddView: View {
    @Environment(\.widgetFamily) var family

    var body: some View {
        let buttons = [
            QuickButton(label: "New task", icon: "plus", url: hookURL("quickAdd", "list")),
            QuickButton(label: "Ask Claude", icon: "sparkle", url: hookURL("quickAdd", "agent")),
            QuickButton(label: "Say it", icon: "mic", url: hookURL("voice", "list"))
        ]
        let layout = family == .systemSmall ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        layout {
            ForEach(buttons) { b in
                Link(destination: b.url) {
                    HStack(spacing: 6) {
                        Image(systemName: b.icon)
                        Text(b.label).font(.subheadline).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.accentColor.opacity(0.15)))
                }
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }
}
