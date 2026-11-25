package com.jartro.tasks

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.aggregate.AggregationResultGroupedByPeriod
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId

/**
 * Health Connect, read-only: daily totals of steps, workout minutes and sleep, for tasks that check
 * themselves off ("Walk #steps 8000"). renderer/js/health.js calls it as the "Health" plugin.
 * Also his latest weight, for the Food plan ("1 g of protein per pound"); it's asked for alongside the three but
 * optional, so "granted" still means the three. The same goes for the rest of the Health tab: the day's workouts
 * (type, time, distance, calories, reps), resting heart rate, active calories, distance and what food apps logged.
 * Per-day totals and one line per workout leave this file, never the raw samples, and nothing is ever written
 * to Health Connect.
 * Health Connect needs Android 8 (API 26); the app still installs from Android 7, where status() says "no".
 */
@CapacitorPlugin(name = "Health")
class HealthPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val stepsPerm = HealthPermission.getReadPermission(StepsRecord::class)
    private val exercisePerm = HealthPermission.getReadPermission(ExerciseSessionRecord::class)
    private val sleepPerm = HealthPermission.getReadPermission(SleepSessionRecord::class)
    private val weightPerm = HealthPermission.getReadPermission(WeightRecord::class)
    private val perms = setOf(stepsPerm, exercisePerm, sleepPerm) // the first three: "granted" means these
    private val heartPerm = HealthPermission.getReadPermission(RestingHeartRateRecord::class)
    private val kcalPerm = HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class)
    private val distPerm = HealthPermission.getReadPermission(DistanceRecord::class)
    private val foodPerm = HealthPermission.getReadPermission(NutritionRecord::class)
    private val extraPerms = setOf(weightPerm, heartPerm, kcalPerm, distPerm, foodPerm)
    private val allPerms = perms + extraPerms
    private val contract by lazy { PermissionController.createRequestPermissionResultContract() }

    private fun sdk(): Int =
        if (Build.VERSION.SDK_INT < 26) HealthConnectClient.SDK_UNAVAILABLE
        else HealthConnectClient.getSdkStatus(context)

    private fun client() = HealthConnectClient.getOrCreate(context)

    private suspend fun grantedNow(): Set<String> =
        try { client().permissionController.getGrantedPermissions() } catch (e: Exception) { emptySet() }

    private fun grantInfo(r: JSObject, granted: Set<String>) {
        r.put("granted", granted.containsAll(perms))
        r.put("steps", stepsPerm in granted)
        r.put("exercise", exercisePerm in granted)
        r.put("sleep", sleepPerm in granted)
        r.put("weight", weightPerm in granted)
        r.put("heart", heartPerm in granted)
        r.put("calories", kcalPerm in granted)
        r.put("distance", distPerm in granted)
        r.put("food", foodPerm in granted)
        r.put("more", !granted.containsAll(extraPerms)) // the rest of the Health tab's kinds not allowed yet (or turned down)
    }

    /** {available: "yes" | "install" | "no", granted, steps, exercise, sleep, weight, heart, calories, distance, food, more} */
    @PluginMethod
    fun status(call: PluginCall) {
        val s = sdk()
        val r = JSObject()
        r.put("available", when (s) {
            HealthConnectClient.SDK_AVAILABLE -> "yes"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "install"
            else -> "no"
        })
        if (s != HealthConnectClient.SDK_AVAILABLE) { grantInfo(r, emptySet()); call.resolve(r); return }
        scope.launch { grantInfo(r, grantedNow()); call.resolve(r) }
    }

    /** Health Connect's own permission screen; resolves like status(). */
    @PluginMethod
    fun connect(call: PluginCall) {
        when (sdk()) {
            HealthConnectClient.SDK_AVAILABLE -> startActivityForResult(call, contract.createIntent(context, allPerms), "connectResult")
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                openStore()
                call.reject("Install or update Health Connect from Google Play, then press Connect again.")
            }
            else -> call.reject("Health Connect isn't available on this phone (it needs Android 8 or later).")
        }
    }

    @ActivityCallback
    private fun connectResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        // the screen's answer lists only what was just allowed; ask again for the whole picture
        scope.launch {
            val r = JSObject()
            r.put("available", "yes")
            grantInfo(r, grantedNow())
            call.resolve(r)
        }
    }

    /** Health Connect's settings, where he can take the permissions back. */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        try {
            val i = if (Build.VERSION.SDK_INT >= 34) Intent("android.health.connect.action.MANAGE_HEALTH_PERMISSIONS")
                .putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
            else Intent("androidx.health.ACTION_HEALTH_CONNECT_SETTINGS")
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Couldn't open Health Connect's settings.")
        }
    }

    private fun openStore() {
        try {
            val i = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding"))
            i.setPackage("com.android.vending")
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
        } catch (ignored: Exception) {}
    }

    /**
     * {days: [{date: "YYYY-MM-DD", steps?, exerciseMin?, sleepMin?, from?}]} for the last `days` days (1-30,
     * today last). A kind he didn't allow is left out rather than reported as 0. Steps and workouts come
     * from Health Connect's own totals, which drop the overlap when two apps record the same walk; sleep
     * counts toward the morning it ended, overlapping sessions from different apps counted once.
     * from: {steps?, exercise?, sleep?: ["Samsung Health", "Garmin Connect"]}, the apps that wrote each number.
     * weight: {kg, at (ms), from?} the newest weigh-in of the last 180 days, when that read is allowed.
     * And on each day, each when allowed and there's something: weightKg (the day's average), restHr (bpm),
     * activeKcal, distM (meters, all walking, running and riding), food {kcal, protein, carbs, fat} (grams), and
     * workouts [{type: run|walk|hike|bike|swim|strength|yoga|pilates|hiit|cardio|row|stairs|dance|sport|other,
     *   name?, at: "HH:MM", min, distM?, kcal?, reps?, sets?, from?}], at most 12 a day.
     */
    @PluginMethod
    fun read(call: PluginCall) {
        val days = (call.getInt("days") ?: 7).coerceIn(1, 30)
        if (sdk() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect isn't available."); return }
        scope.launch {
            try {
                val c = client()
                val granted = grantedNow()
                val zone = ZoneId.systemDefault()
                val today = LocalDate.now(zone)
                val first = today.minusDays((days - 1).toLong())
                val start = first.atStartOfDay()
                val end = today.plusDays(1).atStartOfDay()
                val out = LinkedHashMap<String, JSObject>()
                val sources = HashMap<String, HashMap<String, LinkedHashSet<String>>>() // day → kind → app names
                for (i in 0 until days) {
                    val d = first.plusDays(i.toLong()).toString()
                    out[d] = JSObject().put("date", d)
                }
                if (stepsPerm in granted) {
                    val rows = c.aggregateGroupByPeriod(AggregateGroupByPeriodRequest(
                        setOf(StepsRecord.COUNT_TOTAL), TimeRangeFilter.between(start, end), Period.ofDays(1)))
                    for (row in rows) {
                        val d = row.startTime.toLocalDate().toString()
                        out[d]?.put("steps", row.result[StepsRecord.COUNT_TOTAL] ?: 0L)
                        addFrom(sources, d, "steps", row.result.dataOrigins)
                    }
                    for (o in out.values) if (!o.has("steps")) o.put("steps", 0)
                }
                if (exercisePerm in granted) {
                    val rows = c.aggregateGroupByPeriod(AggregateGroupByPeriodRequest(
                        setOf(ExerciseSessionRecord.EXERCISE_DURATION_TOTAL), TimeRangeFilter.between(start, end), Period.ofDays(1)))
                    for (row in rows) {
                        val d = row.startTime.toLocalDate().toString()
                        out[d]?.put("exerciseMin", row.result[ExerciseSessionRecord.EXERCISE_DURATION_TOTAL]?.toMinutes() ?: 0L)
                        addFrom(sources, d, "exercise", row.result.dataOrigins)
                    }
                    for (o in out.values) if (!o.has("exerciseMin")) o.put("exerciseMin", 0)
                }
                if (sleepPerm in granted) {
                    // a night that ended on the first day began the evening before it
                    val from = start.minusDays(1).atZone(zone).toInstant()
                    val spans = ArrayList<Pair<Instant, Instant>>()
                    val sleepFrom = HashMap<String, MutableSet<DataOrigin>>()
                    var token: String? = null
                    do {
                        val resp = c.readRecords(ReadRecordsRequest(SleepSessionRecord::class,
                            TimeRangeFilter.between(from, Instant.now()), pageToken = token))
                        for (s in resp.records) {
                            spans.add(s.startTime to s.endTime)
                            sleepFrom.getOrPut(s.endTime.atZone(zone).toLocalDate().toString()) { HashSet() }.add(s.metadata.dataOrigin)
                        }
                        token = resp.pageToken
                    } while (token != null)
                    for (o in out.values) o.put("sleepMin", 0)
                    spans.groupBy { it.second.atZone(zone).toLocalDate().toString() }
                        .forEach { (d, list) -> out[d]?.put("sleepMin", unionMinutes(list)) }
                    for ((d, origins) in sleepFrom) addFrom(sources, d, "sleep", origins)
                }
                // the rest of the Health tab's numbers, one daily total each
                val dayOf = { row: AggregationResultGroupedByPeriod -> out[row.startTime.toLocalDate().toString()] }
                if (kcalPerm in granted) daily(c, start, end, setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)) { row ->
                    row.result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories?.let { if (it > 0) dayOf(row)?.put("activeKcal", Math.round(it)) }
                }
                if (distPerm in granted) daily(c, start, end, setOf(DistanceRecord.DISTANCE_TOTAL)) { row ->
                    row.result[DistanceRecord.DISTANCE_TOTAL]?.inMeters?.let { if (it > 0) dayOf(row)?.put("distM", Math.round(it)) }
                }
                if (heartPerm in granted) daily(c, start, end, setOf(RestingHeartRateRecord.BPM_AVG)) { row ->
                    row.result[RestingHeartRateRecord.BPM_AVG]?.let { if (it > 0) dayOf(row)?.put("restHr", it) }
                }
                if (weightPerm in granted) daily(c, start, end, setOf(WeightRecord.WEIGHT_AVG)) { row ->
                    row.result[WeightRecord.WEIGHT_AVG]?.inKilograms?.let { if (it > 0) dayOf(row)?.put("weightKg", Math.round(it * 10) / 10.0) }
                }
                if (foodPerm in granted) daily(c, start, end, setOf(NutritionRecord.ENERGY_TOTAL, NutritionRecord.PROTEIN_TOTAL,
                        NutritionRecord.TOTAL_CARBOHYDRATE_TOTAL, NutritionRecord.TOTAL_FAT_TOTAL)) { row ->
                    val f = JSObject()
                    row.result[NutritionRecord.ENERGY_TOTAL]?.inKilocalories?.let { if (it > 0) f.put("kcal", Math.round(it)) }
                    row.result[NutritionRecord.PROTEIN_TOTAL]?.inGrams?.let { if (it > 0) f.put("protein", Math.round(it)) }
                    row.result[NutritionRecord.TOTAL_CARBOHYDRATE_TOTAL]?.inGrams?.let { if (it > 0) f.put("carbs", Math.round(it)) }
                    row.result[NutritionRecord.TOTAL_FAT_TOTAL]?.inGrams?.let { if (it > 0) f.put("fat", Math.round(it)) }
                    if (f.length() > 0) dayOf(row)?.put("food", f)
                }
                // each workout, from any app: what it was, how long, how far, how hard
                if (exercisePerm in granted) {
                    val byDay = HashMap<String, JSArray>()
                    var token: String? = null
                    var seen = 0
                    do {
                        val resp = c.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class,
                            TimeRangeFilter.between(start, end), pageToken = token))
                        for (w in resp.records) {
                            if (++seen > 400) break
                            val d = w.startTime.atZone(zone).toLocalDate().toString()
                            val list = byDay.getOrPut(d) { JSArray() }
                            if (list.length() >= 12) continue
                            val type = typeName(w.exerciseType)
                            val o = JSObject().put("type", type)
                                .put("at", w.startTime.atZone(zone).toLocalTime().toString().take(5))
                                .put("min", java.time.Duration.between(w.startTime, w.endTime).toMinutes())
                            w.title?.trim()?.takeIf { it.isNotEmpty() }?.let { o.put("name", it.take(40)) }
                            val span = TimeRangeFilter.between(w.startTime, w.endTime)
                            if (distPerm in granted && type in DISTANCE_TYPES) try {
                                c.aggregate(AggregateRequest(setOf(DistanceRecord.DISTANCE_TOTAL), span))[DistanceRecord.DISTANCE_TOTAL]
                                    ?.inMeters?.let { if (it > 0) o.put("distM", Math.round(it)) }
                            } catch (ignored: Exception) {}
                            if (kcalPerm in granted) try {
                                c.aggregate(AggregateRequest(setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL), span))[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]
                                    ?.inKilocalories?.let { if (it > 0) o.put("kcal", Math.round(it)) }
                            } catch (ignored: Exception) {}
                            val reps = w.segments.sumOf { it.repetitions }
                            if (reps > 0) { o.put("reps", reps); o.put("sets", w.segments.count { it.repetitions > 0 }) }
                            appName(w.metadata.dataOrigin.packageName)?.let { o.put("from", it) }
                            list.put(o)
                        }
                        token = if (seen > 400) null else resp.pageToken
                    } while (token != null)
                    for ((d, list) in byDay) out[d]?.put("workouts", list)
                }
                for ((d, kinds) in sources) {
                    val o = out[d] ?: continue
                    val f = JSObject()
                    for ((kind, names) in kinds) if (names.isNotEmpty()) f.put(kind, JSArray(names.toList()))
                    if (f.length() > 0) o.put("from", f)
                }
                val arr = JSArray()
                for (o in out.values) arr.put(o)
                val res = JSObject().put("days", arr)
                if (weightPerm in granted) latestWeight(c)?.let { res.put("weight", it) }
                call.resolve(res)
            } catch (e: Exception) {
                call.reject("Couldn't read Health Connect: " + (e.message ?: e.javaClass.simpleName))
            }
        }
    }

    /** The newest weigh-in of the last 180 days: {kg, at, from?}, or null. */
    private suspend fun latestWeight(c: HealthConnectClient): JSObject? = try {
        val resp = c.readRecords(ReadRecordsRequest(WeightRecord::class,
            TimeRangeFilter.between(Instant.now().minus(java.time.Duration.ofDays(180)), Instant.now()),
            ascendingOrder = false, pageSize = 1))
        resp.records.firstOrNull()?.let { w ->
            val o = JSObject().put("kg", w.weight.inKilograms).put("at", w.time.toEpochMilli())
            appName(w.metadata.dataOrigin.packageName)?.let { o.put("from", it) }
            o
        }
    } catch (e: Exception) { null }

    /** One total per day of the given metrics, each row to `use`. A kind that fails is left out, not the whole read. */
    private suspend fun daily(c: HealthConnectClient, start: LocalDateTime, end: LocalDateTime,
                              metrics: Set<AggregateMetric<*>>, use: (AggregationResultGroupedByPeriod) -> Unit) {
        try {
            for (row in c.aggregateGroupByPeriod(AggregateGroupByPeriodRequest(metrics, TimeRangeFilter.between(start, end), Period.ofDays(1)))) use(row)
        } catch (ignored: Exception) {}
    }

    private fun typeName(t: Int): String = when (t) {
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING, ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "run"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "walk"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "hike"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING, ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "bike"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL, ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "swim"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING, ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING,
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS -> "strength"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "yoga"
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> "pilates"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "hiit"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "cardio"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING, ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> "row"
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING, ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE -> "stairs"
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING -> "dance"
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL, ExerciseSessionRecord.EXERCISE_TYPE_SOCCER, ExerciseSessionRecord.EXERCISE_TYPE_TENNIS,
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING, ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS -> "sport"
        else -> "other"
    }

    private fun addFrom(from: HashMap<String, HashMap<String, LinkedHashSet<String>>>, day: String, kind: String, origins: Set<DataOrigin>) {
        if (origins.isEmpty()) return
        val names = from.getOrPut(day) { HashMap() }.getOrPut(kind) { LinkedHashSet() }
        for (o in origins) appName(o.packageName)?.let { names.add(it) }
    }

    private val nameCache = HashMap<String, String?>()

    /**
     * The name he knows an app by. The common health apps by package, since Android 11 hides other apps' labels
     * unless they're listed under <queries>; anything else by its label when Android shares it, or left out.
     */
    private fun appName(pkg: String): String? = nameCache.getOrPut(pkg) {
        KNOWN_APPS[pkg] ?: try {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString().takeIf { it.isNotBlank() }
        } catch (e: Exception) { null }
    }

    /** Minutes covered by the spans, overlaps counted once. */
    private fun unionMinutes(spans: List<Pair<Instant, Instant>>): Long {
        var total = 0L
        var curStart: Instant? = null
        var curEnd: Instant? = null
        for ((s, e) in spans.sortedBy { it.first }) {
            if (curEnd == null || s.isAfter(curEnd)) {
                if (curStart != null && curEnd != null) total += java.time.Duration.between(curStart, curEnd).toMinutes()
                curStart = s; curEnd = e
            } else if (e.isAfter(curEnd)) curEnd = e
        }
        if (curStart != null && curEnd != null) total += java.time.Duration.between(curStart, curEnd).toMinutes()
        return total
    }

    companion object {
        private val DISTANCE_TYPES = setOf("run", "walk", "hike", "bike", "swim", "row")
        private val KNOWN_APPS = mapOf(
            "android" to "This phone",
            "com.google.android.apps.healthdata" to "This phone",
            "com.sec.android.app.shealth" to "Samsung Health",
            "com.google.android.apps.fitness" to "Google Fit",
            "com.fitbit.FitbitMobile" to "Fitbit",
            "com.garmin.android.apps.connectmobile" to "Garmin Connect",
            "com.ouraring.oura" to "Oura",
            "com.strava" to "Strava",
            "com.whoop.android" to "WHOOP",
            "com.withings.wiscale2" to "Withings",
            "fi.polar.polarflow" to "Polar Flow",
            "com.huami.watch.hmwatchmanager" to "Zepp",
            "com.mi.health" to "Mi Fitness",
            "com.xiaomi.wearable" to "Mi Fitness",
            "com.huawei.health" to "Huawei Health",
            "com.nike.plusgps" to "Nike Run Club",
            "com.onepeloton.callisto" to "Peloton",
            "com.myfitnesspal.android" to "MyFitnessPal",
            "com.urbandroid.sleep" to "Sleep as Android",
            "com.runtastic.android" to "adidas Running",
            "com.yf.smart.coros.dist" to "COROS",
            "com.stt.android.suunto" to "Suunto",
        )
    }

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }
}
