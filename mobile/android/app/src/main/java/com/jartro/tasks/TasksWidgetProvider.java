package com.jartro.tasks;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

public class TasksWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "com.jartro.tasks.WIDGET_REFRESH";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_tasks);

            Intent svc = new Intent(context, TasksWidgetService.class);
            svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
            svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
            views.setRemoteAdapter(R.id.task_list, svc);
            views.setEmptyView(R.id.task_list, R.id.empty_view);

            // header + empty area open the app
            Intent open = new Intent(context, MainActivity.class);
            PendingIntent openPi = PendingIntent.getActivity(context, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(R.id.widget_header, openPi);
            views.setOnClickPendingIntent(R.id.empty_view, openPi);

            // list rows open the app too (template + fill-in)
            Intent rowTemplate = new Intent(context, MainActivity.class);
            PendingIntent rowPi = PendingIntent.getActivity(context, 1, rowTemplate,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setPendingIntentTemplate(R.id.task_list, rowPi);

            // refresh icon re-fetches
            Intent refresh = new Intent(context, TasksWidgetProvider.class);
            refresh.setAction(ACTION_REFRESH);
            PendingIntent refreshPi = PendingIntent.getBroadcast(context, 2, refresh,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(R.id.refresh_btn, refreshPi);

            manager.updateAppWidget(id, views);
            manager.notifyAppWidgetViewDataChanged(id, R.id.task_list);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) {
            refreshAll(context);
        }
    }

    /** Re-fetch and redraw every widget instance. Safe to call from anywhere. */
    public static void refreshAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, TasksWidgetProvider.class));
        if (ids.length > 0) mgr.notifyAppWidgetViewDataChanged(ids, R.id.task_list);
    }
}
