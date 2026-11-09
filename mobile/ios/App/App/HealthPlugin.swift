import Foundation
import Capacitor
import HealthKit
import UIKit

/**
 * Apple Health (HealthKit), read-only: daily totals of steps, exercise minutes and sleep, for tasks that check
 * themselves off ("Walk #steps 8000", "Walk 8,000 steps"). The same "Health" plugin, with the same four calls and
 * answers, as the Android one (HealthPlugin.kt), so renderer/js/health.js has no platform branches.
 * Also his latest weight, for the Food plan ("1 g of protein per pound").
 * Only totals per day and that one weigh-in leave this file, and nothing is ever written to Apple Health.
 * HealthKit never says whether a read was allowed (a kind said no to simply reads as empty), so "granted" means
 * the permission sheet has been shown, and a day only carries the kinds that had data.
 */
@objc(HealthPlugin)
public class HealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthPlugin"
    public let jsName = "Health"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise)
    ]

    private let store = HKHealthStore()
    private let steps = HKQuantityType.quantityType(forIdentifier: .stepCount)!
    private let exerciseTime = HKQuantityType.quantityType(forIdentifier: .appleExerciseTime)!
    private let sleep = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
    private let workouts = HKObjectType.workoutType()
    private let bodyMass = HKQuantityType.quantityType(forIdentifier: .bodyMass)!
    private var readTypes: Set<HKObjectType> { [steps, exerciseTime, sleep, workouts, bodyMass] }

    /// {available: "yes" | "no", granted, steps, exercise, sleep}
    @objc func status(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(Self.info("no", asked: false)); return }
        store.getRequestStatusForAuthorization(toShare: [], read: readTypes) { status, _ in
            call.resolve(Self.info("yes", asked: status == .unnecessary))
        }
    }

    /// Apple Health's own sheet asking to read the four types; resolves like status().
    @objc func connect(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.reject("Apple Health isn’t available on this device."); return }
        store.requestAuthorization(toShare: nil, read: readTypes) { _, error in
            if let error = error { call.reject(error.localizedDescription); return }
            self.status(call)
        }
    }

    /// The Health app, where Sharing → Apps → Romulus changes or takes back what it may read.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: "x-apple-health://") else { call.reject("Couldn’t open the Health app."); return }
            UIApplication.shared.open(url) { ok in
                if ok { call.resolve() } else { call.reject("Couldn’t open the Health app.") }
            }
        }
    }

    /**
     * {days: [{date: "YYYY-MM-DD", steps?, exerciseMin?, sleepMin?, from?}]} for the last `days` days (1-30, today last).
     * Steps are HealthKit's own daily sums (which merge the phone's and the watch's counts); exercise is the day's
     * workouts from any app or the watch's exercise minutes, whichever says more; sleep counts toward the morning it
     * ended, overlapping records from different apps counted once.
     * from: {steps?, exercise?, sleep?: ["iPhone", "Apple Watch", "Oura"]}, the apps and devices that wrote each number.
     * weight: {kg, at (ms), from} the newest weigh-in of the last 180 days, when there is one and it may be read.
     */
    @objc func read(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.reject("Apple Health isn’t available."); return }
        let days = min(max(call.getInt("days") ?? 7, 1), 30)
        let cal = Calendar.current
        let now = Date()
        let today = cal.startOfDay(for: now)
        guard let first = cal.date(byAdding: .day, value: -(days - 1), to: today),
              let end = cal.date(byAdding: .day, value: 1, to: today) else { call.reject("Couldn’t work out the days."); return }
        var dates: [String] = []
        for i in 0..<days { if let d = cal.date(byAdding: .day, value: i, to: first) { dates.append(Self.ymd(d)) } }
        var out: [String: [String: Any]] = [:]
        for d in dates { out[d] = ["date": d] }
        var workoutMin: [String: Double] = [:], ringMin: [String: Double] = [:]
        var from: [String: [String: [String]]] = [:] // day → kind → names, in the order first seen
        let lock = NSLock()
        let addFrom = { (day: String, kind: String, name: String) in
            lock.lock()
            var kinds = from[day] ?? [:], names = kinds[kind] ?? []
            if !names.contains(name) { names.append(name) }
            kinds[kind] = names; from[day] = kinds
            lock.unlock()
        }
        let put = { (day: String, key: String, value: Any) in lock.lock(); if out[day] != nil { out[day]![key] = value }; lock.unlock() }
        let range = HKQuery.predicateForSamples(withStart: first, end: end, options: .strictStartDate)
        let group = DispatchGroup()

        // steps: one sum per day
        group.enter()
        let stepsQuery = HKStatisticsCollectionQuery(quantityType: steps, quantitySamplePredicate: range, options: [.cumulativeSum, .separateBySource],
                                                     anchorDate: first, intervalComponents: DateComponents(day: 1))
        stepsQuery.initialResultsHandler = { _, results, _ in
            results?.enumerateStatistics(from: first, to: end) { stat, _ in
                if let q = stat.sumQuantity() {
                    let d = Self.ymd(stat.startDate)
                    put(d, "steps", Int(q.doubleValue(for: .count()).rounded()))
                    for src in stat.sources ?? [] where (stat.sumQuantity(for: src)?.doubleValue(for: .count()) ?? 0) > 0 { addFrom(d, "steps", Self.name(src)) }
                }
            }
            group.leave()
        }
        store.execute(stepsQuery)

        // exercise: the watch's exercise minutes per day, and the workouts logged by any app
        group.enter()
        let ringQuery = HKStatisticsCollectionQuery(quantityType: exerciseTime, quantitySamplePredicate: range, options: [.cumulativeSum, .separateBySource],
                                                    anchorDate: first, intervalComponents: DateComponents(day: 1))
        ringQuery.initialResultsHandler = { _, results, _ in
            results?.enumerateStatistics(from: first, to: end) { stat, _ in
                if let q = stat.sumQuantity() {
                    let d = Self.ymd(stat.startDate)
                    lock.lock(); ringMin[d] = q.doubleValue(for: .minute()); lock.unlock()
                    for src in stat.sources ?? [] where (stat.sumQuantity(for: src)?.doubleValue(for: .minute()) ?? 0) > 0 { addFrom(d, "exercise", Self.name(src)) }
                }
            }
            group.leave()
        }
        store.execute(ringQuery)
        group.enter()
        store.execute(HKSampleQuery(sampleType: workouts, predicate: range, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
            for w in (samples as? [HKWorkout] ?? []) {
                let d = Self.ymd(w.startDate)
                lock.lock(); workoutMin[d] = (workoutMin[d] ?? 0) + w.duration / 60; lock.unlock()
                addFrom(d, "exercise", Self.name(w.sourceRevision.source))
            }
            group.leave()
        })

        // sleep: from the evening before the first day, so a night that ended on it counts in full
        group.enter()
        let nightStart = cal.date(byAdding: .day, value: -1, to: first) ?? first
        let nights = HKQuery.predicateForSamples(withStart: nightStart, end: now, options: [])
        store.execute(HKSampleQuery(sampleType: sleep, predicate: nights, limit: HKObjectQueryNoLimit,
                                    sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, _ in
            let asleep = (samples as? [HKCategorySample] ?? []).filter { Self.isAsleep($0.value) }
            var byDay: [String: [(Date, Date)]] = [:]
            for s in asleep {
                let d = Self.ymd(s.endDate)
                byDay[d, default: []].append((s.startDate, s.endDate))
                addFrom(d, "sleep", Self.name(s.sourceRevision.source))
            }
            for (d, spans) in byDay { put(d, "sleepMin", Self.unionMinutes(spans)) }
            group.leave()
        })

        // weight: the newest weigh-in of the last 180 days
        var weight: [String: Any]? = nil
        group.enter()
        let lately = HKQuery.predicateForSamples(withStart: cal.date(byAdding: .day, value: -180, to: now), end: now, options: [])
        store.execute(HKSampleQuery(sampleType: bodyMass, predicate: lately, limit: 1,
                                    sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) { _, samples, _ in
            if let w = (samples as? [HKQuantitySample])?.first {
                let kg = w.quantity.doubleValue(for: .gramUnit(with: .kilo))
                lock.lock()
                weight = ["kg": kg, "at": Int(w.endDate.timeIntervalSince1970 * 1000), "from": Self.name(w.sourceRevision.source)]
                lock.unlock()
            }
            group.leave()
        })

        group.notify(queue: .main) {
            for d in dates {
                let w = workoutMin[d], r = ringMin[d]
                if w != nil || r != nil { out[d]!["exerciseMin"] = Int(max(w ?? 0, r ?? 0).rounded()) }
                if let f = from[d], !f.isEmpty { out[d]!["from"] = f }
            }
            var res: [String: Any] = ["days": dates.map { out[$0]! }]
            if let w = weight { res["weight"] = w }
            call.resolve(res)
        }
    }

    private static func info(_ available: String, asked: Bool) -> [String: Any] {
        ["available": available, "granted": asked, "steps": asked, "exercise": asked, "sleep": asked, "weight": asked]
    }

    /// The name he knows a source by. The iPhone and Watch record under the device's own name ("Sam's Apple Watch"),
    /// so those are just "iPhone" and "Apple Watch"; any other app (Oura, Garmin Connect, Strava...) by its name.
    private static func name(_ src: HKSource) -> String {
        if src.bundleIdentifier.hasPrefix("com.apple.health") {
            return src.name.range(of: "watch", options: .caseInsensitive) != nil ? "Apple Watch" : "iPhone"
        }
        return src.name
    }

    private static func isAsleep(_ value: Int) -> Bool {
        guard let v = HKCategoryValueSleepAnalysis(rawValue: value) else { return false }
        if #available(iOS 16.0, *) { return HKCategoryValueSleepAnalysis.allAsleepValues.contains(v) }
        return v == .asleep
    }

    /// Minutes covered by the spans, overlaps counted once (sorted by start).
    private static func unionMinutes(_ spans: [(Date, Date)]) -> Int {
        var total = 0.0, coveredTo = Date.distantPast
        for (s, e) in spans.sorted(by: { $0.0 < $1.0 }) {
            let from = max(s, coveredTo)
            if e > from { total += e.timeIntervalSince(from); coveredTo = e }
        }
        return Int((total / 60).rounded())
    }

    /// The phone's local date as the page writes it (healthYmd in renderer/js/health.js): 2026-11-07
    private static func ymd(_ d: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
}
