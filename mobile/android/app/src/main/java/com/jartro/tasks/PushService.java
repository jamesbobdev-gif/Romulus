package com.jartro.tasks;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.util.Map;

/**
 * A notification from the Agent arriving through Firebase (supabase/functions/push). It comes sealed, as
 * {iv, ct}; Push opens it with the key the page left and draws it. While the app is on screen nothing is
 * drawn: the page shows the answer itself.
 */
public class PushService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> d = message.getData();
        JSONObject p = Push.open(this, d.get("iv"), d.get("ct"));
        if (p == null || MainActivity.visible) return;
        String id = p.optString("id");
        if (id.isEmpty()) return;
        Push.show(this, id, p.optString("title", "Romulus"), p.optString("note"), "done".equals(p.optString("st")),
                p.optLong("at", System.currentTimeMillis()), null, true);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // the page registers the token each time the app opens (PushPlugin.register), so nothing to do here
    }
}
