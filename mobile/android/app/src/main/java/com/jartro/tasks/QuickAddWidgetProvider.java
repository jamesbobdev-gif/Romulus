package com.jartro.tasks;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/** Home-screen widget: two buttons that open the app ready to type — a task, or one for Claude. */
public class QuickAddWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_quick);
            v.setOnClickPendingIntent(R.id.q_task, Widgets.openApp(ctx, 600, "quickAdd", "list"));
            v.setOnClickPendingIntent(R.id.q_agent, Widgets.openApp(ctx, 601, "quickAdd", "agent"));
            v.setOnClickPendingIntent(R.id.q_voice, Widgets.openApp(ctx, 602, "voice", "list")); // opens straight into listening
            mgr.updateAppWidget(id, v);
        }
    }
}
