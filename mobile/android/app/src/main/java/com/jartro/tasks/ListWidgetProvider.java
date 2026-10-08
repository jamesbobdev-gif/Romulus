package com.jartro.tasks;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/**
 * Base for the list widgets (Today, Claude needs you, School). Each subclass picks a mode; the
 * rows and the header text come from ListWidgetService for that mode.
 */
public abstract class ListWidgetProvider extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.jartro.tasks.LIST_WIDGET_REFRESH";

    abstract String mode();         // "today" | "agent" | "school"
    abstract String title();
    abstract String emptyText();
    abstract String tabToOpen();    // tab the header opens: "list" | "agent" | "school"
    abstract int requestBase();     // keeps each widget's PendingIntents distinct

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_list);
            v.setTextViewText(R.id.w_title, title());
            v.setTextViewText(R.id.w_empty, emptyText());

            Intent svc = new Intent(ctx, ListWidgetService.class);
            svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
            svc.putExtra("mode", mode());
            svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME))); // one data set per widget
            v.setRemoteAdapter(R.id.w_list, svc);
            v.setEmptyView(R.id.w_list, R.id.w_empty);
            v.setPendingIntentTemplate(R.id.w_list, Widgets.rowTemplate(ctx, requestBase()));

            PendingIntent open = Widgets.openApp(ctx, requestBase() + 1, "tab", tabToOpen());
            v.setOnClickPendingIntent(R.id.w_title, open);
            v.setOnClickPendingIntent(R.id.w_empty, open);

            Intent refresh = new Intent(ctx, getClass()).setAction(ACTION_REFRESH);
            v.setOnClickPendingIntent(R.id.w_refresh, PendingIntent.getBroadcast(ctx, requestBase() + 2, refresh,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

            mgr.updateAppWidget(id, v);
            mgr.notifyAppWidgetViewDataChanged(id, R.id.w_list);
        }
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) Widgets.refreshAll(ctx);
    }
}
