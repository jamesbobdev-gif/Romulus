package com.jartro.tasks;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.core.app.RemoteInput;

/**
 * "Reply" on one of the Agent's notifications: the typed words go to the server, sealed (Push.sendReply),
 * where a device with the lists open puts them on the task. With no connection they wait on the phone and
 * the page takes them the next time the app opens. Either way the notification shows what was answered.
 */
public class PushReplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Bundle typed = RemoteInput.getResultsFromIntent(intent);
        CharSequence words = typed == null ? null : typed.getCharSequence(Push.REPLY_KEY);
        String taskId = intent.getStringExtra("taskId");
        if (words == null || taskId == null) return;
        String text = words.toString().trim();
        if (text.isEmpty()) return;
        if (text.length() > 2000) text = text.substring(0, 2000);
        final String reply = text;
        final Context ctx = context.getApplicationContext();
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                boolean sent = Push.sendReply(ctx, taskId, reply);
                if (!sent) Push.queueReply(ctx, taskId, reply);
                String title = intent.getStringExtra("title"), note = intent.getStringExtra("note");
                Push.show(ctx, taskId, title == null ? "Romulus" : title, note == null ? "" : note,
                        intent.getBooleanExtra("done", false), intent.getLongExtra("at", System.currentTimeMillis()), reply, sent);
            } finally {
                pending.finish();
            }
        }).start();
    }
}
