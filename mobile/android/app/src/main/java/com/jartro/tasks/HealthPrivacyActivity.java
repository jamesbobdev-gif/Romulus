package com.jartro.tasks;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * Health Connect's "why does this app want your data?" link (its permission screen, and Android 14's
 * permission-usage page): opens the Health part of PRIVACY.md in the browser, then gets out of the way.
 * Health Connect won't show its permission screen for an app that doesn't answer these.
 */
public class HealthPrivacyActivity extends Activity {
    static final String URL = "https://github.com/jamesbobdev-gif/Romulus/blob/main/PRIVACY.md#health-connect-android";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(URL))); } catch (Exception ignored) {}
        finish();
    }
}
