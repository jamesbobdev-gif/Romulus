package com.jartro.tasks;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android's Share sheet with just a link in it — no words added — so you can send it to people in
 * Messages, WhatsApp, etc. You pick who and hit send yourself; nothing goes out on its own.
 */
@CapacitorPlugin(name = "ShareLink")
public class ShareLinkPlugin extends Plugin {
    @PluginMethod
    public void share(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.matches("(?i)^https?://.+")) {
            call.reject("Not a link");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, url);
        Intent chooser = Intent.createChooser(send, null);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().runOnUiThread(() -> {
            getContext().startActivity(chooser);
            call.resolve();
        });
    }
}
