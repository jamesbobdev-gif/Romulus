package com.jartro.tasks;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;

/** Helpers shared by every home-screen widget. */
final class Widgets {
    private Widgets() {}

    /** Re-fetch and redraw every widget of every kind. */
    static void refreshAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        notify(mgr, ctx, TasksWidgetProvider.class, R.id.task_list);
        // the list widgets redraw their header (counts, next-test countdown) along with the rows
        notify(mgr, ctx, TodayWidgetProvider.class, R.id.w_list);
        notify(mgr, ctx, AgentWidgetProvider.class, R.id.w_list);
        notify(mgr, ctx, SchoolWidgetProvider.class, R.id.w_list);
        notify(mgr, ctx, AgentStatusWidgetProvider.class, R.id.w_list);
    }

    private static void notify(AppWidgetManager mgr, Context ctx, Class<?> provider, int listId) {
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, provider));
        if (ids.length > 0) mgr.notifyAppWidgetViewDataChanged(ids, listId);
    }

    /** Opens the app; extras tell the page what to show (see window.__tasksHook in the app). */
    static PendingIntent openApp(Context ctx, int requestCode, String kind, String arg) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setAction("com.jartro.tasks.OPEN_" + kind + "_" + requestCode); // distinct per button
        i.putExtra("hookKind", kind);
        if (arg != null) i.putExtra("hookArg", arg);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Template for list rows: every row tap goes through WidgetActionActivity (fill-ins say what to do). */
    static PendingIntent rowTemplate(Context ctx, int requestCode) {
        Intent i = new Intent(ctx, WidgetActionActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        return PendingIntent.getActivity(ctx, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    static Intent fillDone(String channel, String id) {
        return new Intent().putExtra("op", "done").putExtra("channel", channel).putExtra("id", id);
    }

    static Intent fillOpen(String id) {
        return new Intent().putExtra("op", "open").putExtra("id", id);
    }
}
