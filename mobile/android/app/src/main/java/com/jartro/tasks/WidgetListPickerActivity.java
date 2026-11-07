package com.jartro.tasks;

import android.app.Activity;
import android.app.AlertDialog;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;

/** Asks which list a List widget shows, when it's placed and from Widget settings later. */
public class WidgetListPickerActivity extends Activity {
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setResult(RESULT_CANCELED); // backing out of a new widget doesn't place it
        Bundle extras = getIntent().getExtras();
        if (extras != null) widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return; }

        String current = TasksWidgetProvider.chosen(this, widgetId);
        int checked = 0;
        for (int i = 0; i < TasksWidgetProvider.CHOICES.length; i++) if (TasksWidgetProvider.CHOICES[i].equals(current)) checked = i;

        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
                .setTitle("Which list?")
                .setSingleChoiceItems(TasksWidgetProvider.CHOICE_LABELS, checked, (d, which) -> {
                    TasksWidgetProvider.choose(this, widgetId, TasksWidgetProvider.CHOICES[which]);
                    TasksWidgetProvider.redraw(this, widgetId);
                    setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
                    d.dismiss();
                })
                .setOnDismissListener(d -> finish())
                .show();
    }
}
