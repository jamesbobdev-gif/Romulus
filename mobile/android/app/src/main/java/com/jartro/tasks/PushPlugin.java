package com.jartro.tasks;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONArray;

/**
 * The page's side of the Agent's notifications (renderer/js/push.js). register: keeps what a closed app needs
 * (the notification key, and where replies go), asks once to show notifications, and gives back this phone's
 * Firebase token for the page to register. takeReplies: the replies that couldn't be sent when they were typed.
 */
@CapacitorPlugin(name = "Push", permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class PushPlugin extends Plugin {
    @PluginMethod
    public void register(PluginCall call) {
        String key = call.getString("key", ""), url = call.getString("url", ""), apikey = call.getString("apikey", ""), account = call.getString("account", "");
        if (key.isEmpty() || !url.startsWith("https://") || apikey.isEmpty() || account.isEmpty()) { call.reject("Not set up"); return; }
        Push.prefs(getContext()).edit().putString("key", key).putString("url", url).putString("apikey", apikey).putString("account", account).apply();
        if (!Push.init(getContext())) { call.resolve(new JSObject()); return; } // this build has no Firebase project
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "asked");
            return;
        }
        token(call);
    }

    @PermissionCallback
    private void asked(PluginCall call) {
        token(call); // registered either way: a no can be changed in Android's settings later
    }

    private void token(PluginCall call) {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                JSObject out = new JSObject();
                if (task.isSuccessful() && task.getResult() != null) out.put("token", task.getResult());
                call.resolve(out);
            });
        } catch (Exception e) {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void takeReplies(PluginCall call) {
        JSObject out = new JSObject();
        try {
            JSONArray a = Push.takeReplies(getContext());
            out.put("replies", new JSArray(a.toString()));
        } catch (Exception e) {
            out.put("replies", new JSArray());
        }
        call.resolve(out);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        Push.clearAll(getContext());
    }
}
