package com.jartro.tasks;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;

/**
 * Home-screen widget: List — one list, picked when it's placed (long-press, Widget settings, to
 * change it): Personal (every open task, check-off circles) or Groceries (what's on the next
 * order). Keeps the old Personal list's class name so widgets already on the home screen stay,
 * showing Personal.
 */
public class TasksWidgetProvider extends ListWidgetProvider {
    static final String[] CHOICES = {"personal", "groceries"};
    static final String[] CHOICE_LABELS = {"Personal", "Groceries"};

    @Override String mode() { return "personal"; }
    @Override String title() { return "Personal"; }
    @Override String emptyText() { return "Nothing open."; }
    @Override String tabToOpen() { return "list"; }
    @Override int requestBase() { return 700; }

    @Override String mode(Context ctx, int id) { return chosen(ctx, id); }
    @Override String title(Context ctx, int id) { return chosen(ctx, id).equals("groceries") ? "Groceries" : "Personal"; }
    @Override String emptyText(Context ctx, int id) {
        return chosen(ctx, id).equals("groceries") ? "Nothing on the next order." : "Nothing open.";
    }
    @Override String tabToOpen(Context ctx, int id) { return chosen(ctx, id).equals("groceries") ? "agent" : "list"; }
    // each List widget can show a different list, so each gets its own PendingIntents
    @Override int requestBase(int id) { return 10000 + (id % 100000) * 4; }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("widget_lists", Context.MODE_PRIVATE);
    }

    static String chosen(Context ctx, int id) {
        String v = prefs(ctx).getString("list_" + id, "personal");
        return "groceries".equals(v) ? "groceries" : "personal";
    }

    static void choose(Context ctx, int id, String list) {
        prefs(ctx).edit().putString("list_" + id, list).apply();
    }

    @Override
    public void onDeleted(Context ctx, int[] ids) {
        SharedPreferences.Editor e = prefs(ctx).edit();
        for (int id : ids) e.remove("list_" + id);
        e.apply();
    }

    /** Redraw one List widget after its list changes. */
    static void redraw(Context ctx, int id) {
        new TasksWidgetProvider().draw(ctx, AppWidgetManager.getInstance(ctx), id);
    }

    static int[] ids(Context ctx) {
        return AppWidgetManager.getInstance(ctx).getAppWidgetIds(new ComponentName(ctx, TasksWidgetProvider.class));
    }
}
