import Foundation
import Capacitor
import HealthKit
import UIKit

/**
 * Health on the iPhone: today's steps, last night's sleep and today's workout minutes, read from Apple Health
 * (HealthKit), which the iPhone itself, an Apple Watch, and most other health apps write to. The same four
 * calls as the Android plugin (HealthDataPlugin.kt), so mobile/health-phone.js and renderer/js/health.js have
 * no platform branches; RomulusViewController registers it.
 *
 * Read-only, and only while the app is open. The numbers go to the page on this phone and nowhere else: they
 * are not synced, not saved, and never given to an AI. What leaves the phone is a ticked-off to-do.
 */
@objc(HealthDataPlugin)
public class HealthDataPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthDataPlugin"
    public let jsName = "HealthData"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "today", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manage", returnType: CAPPluginReturnPromise)
    ]

    private let store = HKHealthStore()
    private let steps = HKQuantityType.quantityType(forIdentifier: .stepCount)!
    private let exerciseTime = HKQuantityType.quantityType(forIdentifier: .appleExerciseTime)!
    private let sleep = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
    private let workouts = HKObjectType.workoutType()
    private var readTypes: Set<HKObjectType> { [steps, exerciseTime, sleep, workouts] }

    /// {sdk: "ready" | "none", granted: {steps, sleep, exercise}}. HealthKit never says whether a read was
    /// allowed (a type the person said no to simply reads as empty), so "granted" means the permission sheet
    /// has been shown; "none" is a device without the Health app.
    @objc func status(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["sdk": "none"]); return }
        store.getRequestStatusForAuthorization(toShare: [], read: readTypes) { status, _ in
            let asked = status == .unnecessary
            call.resolve(["sdk": "ready", "granted": ["steps": asked, "sleep": asked, "exercise": asked]])
        }
    }

    /// Apple Health's own sheet asking to read the four types. Resolves like status().
    @objc func connect(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["sdk": "none"]); return }
        store.requestAuthorization(toShare: nil, read: readTypes) { _, error in
            if let error = error { call.reject(error.localizedDescription); return }
            self.status(call)
        }
    }

    /// {date, steps, sleepMin, exerciseMin}: a number is left out where nothing is logged yet (or it wasn't allowed).
    @objc func today(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.reject("Apple Health isn’t available"); return }
        let now = Date()
        let day = Calendar.current.startOfDay(for: now)
        let today = HKQuery.predicateForSamples(withStart: day, end: now, options: .strictStartDate)
        var out: [String: Any] = ["date": Self.isoDay(day)]
        var workoutMin = 0.0, ringMin = 0.0, sawExercise = false
        let lock = NSLock()
        let group = DispatchGroup()

        // steps since midnight (HealthKit already merges the phone's and the watch's counts)
        group.enter()
        store.execute(HKStatisticsQuery(quantityType: steps, quantitySamplePredicate: today, options: .cumulativeSum) { _, stats, _ in
            if let sum = stats?.sumQuantity() { lock.lock(); out["steps"] = Int(sum.doubleValue(for: .count()).rounded()); lock.unlock() }
            group.leave()
        })
        // exercise: today's workouts from any app, or the watch's exercise minutes, whichever says more
        group.enter()
        store.execute(HKSampleQuery(sampleType: workouts, predicate: today, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
            if let ws = samples as? [HKWorkout], !ws.isEmpty {
                lock.lock(); workoutMin = ws.reduce(0) { $0 + $1.duration } / 60; sawExercise = true; lock.unlock()
            }
            group.leave()
        })
        group.enter()
        store.execute(HKStatisticsQuery(quantityType: exerciseTime, quantitySamplePredicate: today, options: .cumulativeSum) { _, stats, _ in
            if let sum = stats?.sumQuantity() { lock.lock(); ringMin = sum.doubleValue(for: .minute()); sawExercise = true; lock.unlock() }
            group.leave()
        })
        // sleep: from 6 pm yesterday, so a night that started before midnight counts in full. Records that
        // overlap (the watch and a sleep app both logging the same night) are merged so no minute counts twice.
        group.enter()
        let night = HKQuery.predicateForSamples(withStart: day.addingTimeInterval(-6 * 3600), end: now, options: [])
        store.execute(HKSampleQuery(sampleType: sleep, predicate: night, limit: HKObjectQueryNoLimit,
                                    sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, _ in
            let asleep = (samples as? [HKCategorySample] ?? []).filter { Self.isAsleep($0.value) }
            if !asleep.isEmpty {
                var total = 0.0, coveredTo = Date.distantPast
                for s in asleep {
                    let from = max(s.startDate, coveredTo)
                    if s.endDate > from { total += s.endDate.timeIntervalSince(from); coveredTo = s.endDate }
                }
                lock.lock(); out["sleepMin"] = Int((total / 60).rounded()); lock.unlock()
            }
            group.leave()
        })
        group.notify(queue: .main) {
            if sawExercise { out["exerciseMin"] = Int(max(workoutMin, ringMin).rounded()) }
            call.resolve(out)
        }
    }

    /// The Health app, where Sharing → Apps → Romulus changes or takes back what it may read.
    @objc func manage(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: "x-apple-health://") else { call.reject("Couldn’t open the Health app"); return }
            UIApplication.shared.open(url) { ok in
                if ok { call.resolve() } else { call.reject("Couldn’t open the Health app") }
            }
        }
    }

    private static func isAsleep(_ value: Int) -> Bool {
        guard let v = HKCategoryValueSleepAnalysis(rawValue: value) else { return false }
        if #available(iOS 16.0, *) { return HKCategoryValueSleepAnalysis.allAsleepValues.contains(v) }
        return v == .asleep
    }

    /// The phone's local date as the page writes it (formatDate in renderer/js/core.js): 2026-11-07
    private static func isoDay(_ d: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
}
