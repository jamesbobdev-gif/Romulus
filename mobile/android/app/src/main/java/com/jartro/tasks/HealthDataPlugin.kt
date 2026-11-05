package com.jartro.tasks

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
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
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * Health on the phone: today's steps, last night's sleep and today's workout minutes, read from Android's
 * Health Connect (which Samsung Health, Fitbit, Google Fit, Oura, Garmin and most other health apps write to).
 * mobile/health-phone.js is the page's side; renderer/js/health.js checks off goal to-dos with the numbers.
 *
 * Read-only, and only while the app is open. The numbers go to the page on this phone and nowhere else: they
 * are not synced, not saved, and never given to an AI. What leaves the phone is a ticked-off to-do.
 */
@CapacitorPlugin(name = "HealthData")
class HealthDataPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val perms = mapOf(
        "steps" to HealthPermission.getReadPermission(StepsRecord::class),
        "sleep" to HealthPermission.getReadPermission(SleepSessionRecord::class),
        "exercise" to HealthPermission.getReadPermission(ExerciseSessionRecord::class),
    )

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    /** "ready", "install" (Health Connect missing or out of date: Android 13 and older get it from Play) or "none". */
    private fun sdk(): String = when (HealthConnectClient.getSdkStatus(context, PROVIDER)) {
        HealthConnectClient.SDK_AVAILABLE -> "ready"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "install"
        else -> if (Build.VERSION.SDK_INT < 34) "install" else "none"
    }

    private suspend fun granted(): JSObject {
        val have = HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
        val out = JSObject()
        perms.forEach { (k, p) -> out.put(k, have.contains(p)) }
        return out
    }

    /** {sdk, granted: {steps, sleep, exercise}} */
    @PluginMethod
    fun status(call: PluginCall) {
        scope.launch {
            try {
                val r = JSObject()
                val s = sdk()
                r.put("sdk", s)
                if (s == "ready") r.put("granted", granted())
                call.resolve(r)
            } catch (e: Exception) {
                call.reject(e.message ?: "Health Connect didn’t answer")
            }
        }
    }

    /** Health Connect's own screen asking for the three read permissions. Resolves like status(). */
    @PluginMethod
    fun connect(call: PluginCall) {
        when (sdk()) {
            "ready" -> {
                val intent = PermissionController.createRequestPermissionResultContract()
                    .createIntent(context, perms.values.toSet())
                startActivityForResult(call, intent, "connected")
            }
            "install" -> { openStore(); call.resolve(JSObject().put("sdk", "install")) }
            else -> call.resolve(JSObject().put("sdk", "none"))
        }
    }

    @ActivityCallback
    private fun connected(call: PluginCall?, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        if (call == null) return
        status(call) // what was granted, read back from Health Connect rather than from the result
    }

    /** {date, steps, sleepMin, exerciseMin}: null where it isn't allowed or there's no data yet. */
    @PluginMethod
    fun today(call: PluginCall) {
        scope.launch {
            try {
                if (sdk() != "ready") { call.reject("Health Connect isn’t available"); return@launch }
                val client = HealthConnectClient.getOrCreate(context)
                val have = client.permissionController.getGrantedPermissions()
                val now = LocalDateTime.now()
                val day = LocalDate.now().atStartOfDay()
                val r = JSObject()
                r.put("date", LocalDate.now().toString()) // a number left out: not allowed, or nothing logged yet
                if (have.contains(perms.getValue("steps"))) {
                    val a = client.aggregate(AggregateRequest(setOf(StepsRecord.COUNT_TOTAL), TimeRangeFilter.between(day, now)))
                    r.put("steps", a[StepsRecord.COUNT_TOTAL] ?: 0L)
                }
                if (have.contains(perms.getValue("exercise"))) {
                    val a = client.aggregate(AggregateRequest(setOf(ExerciseSessionRecord.EXERCISE_DURATION_TOTAL), TimeRangeFilter.between(day, now)))
                    r.put("exerciseMin", a[ExerciseSessionRecord.EXERCISE_DURATION_TOTAL]?.toMinutes() ?: 0L)
                }
                if (have.contains(perms.getValue("sleep"))) {
                    // last night: from 6 pm yesterday, so a night that started before midnight counts in full
                    val a = client.aggregate(AggregateRequest(setOf(SleepSessionRecord.SLEEP_DURATION_TOTAL), TimeRangeFilter.between(day.minusHours(6), now)))
                    a[SleepSessionRecord.SLEEP_DURATION_TOTAL]?.let { r.put("sleepMin", it.toMinutes()) } // none logged yet: stays null
                }
                call.resolve(r)
            } catch (e: SecurityException) {
                call.reject("Romulus isn’t allowed to read that in Health Connect")
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn’t read Health Connect")
            }
        }
    }

    /** Health Connect's settings for this app, to change or take back what it may read. */
    @PluginMethod
    fun manage(call: PluginCall) {
        val i = if (Build.VERSION.SDK_INT >= 34)
            Intent("android.health.connect.action.MANAGE_HEALTH_PERMISSIONS").putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
        else Intent("androidx.health.ACTION_HEALTH_CONNECT_SETTINGS")
        try {
            activity.startActivity(i)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Couldn’t open Health Connect")
        }
    }

    private fun openStore() {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$PROVIDER&url=healthconnect%3A%2F%2Fonboarding"))
            .setPackage("com.android.vending")
        try { activity.startActivity(market) } catch (e: Exception) {
            try { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$PROVIDER"))) } catch (_: Exception) {}
        }
    }

    companion object {
        private const val PROVIDER = "com.google.android.apps.healthdata"
    }
}
