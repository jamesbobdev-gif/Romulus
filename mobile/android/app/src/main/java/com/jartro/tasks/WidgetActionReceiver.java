package com.jartro.tasks;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/** Checks a task off from a widget: hides it right away, then saves it in the background. */
public class WidgetActionReceiver extends BroadcastReceiver {
    static final String ACTION_COMPLETE = "com.jartro.tasks.WIDGET_COMPLETE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_COMPLETE.equals(intent.getAction())) return;
        final String channel = intent.getStringExtra("channel");
        final String id = intent.getStringExtra("id");
        if (channel == null || id == null) return;
        final Context app = context.getApplicationContext();
        SyncStore.setPending(app, id, true); // the row disappears immediately
        Widgets.refreshAll(app);
        final PendingResult pr = goAsync();
        new Thread(() -> {
            boolean ok = SyncStore.complete(app, channel, id);
            SyncStore.setPending(app, id, false); // saved: it's done in the data now; failed: show it again
            if (!ok) {
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                        Toast.makeText(app, "Couldn’t check that off — no connection?", Toast.LENGTH_SHORT).show());
            }
            Widgets.refreshAll(app);
            pr.finish();
        }).start();
    }
}
