package com.jartro.tasks;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * Health Connect opens this from its permission screen ("Read privacy policy") and from Android's
 * permission settings. It shows the privacy policy, whose Health section says what is read and where it goes.
 */
public class HealthPrivacyActivity extends Activity {
    static final String POLICY = "https://github.com/jamesbobdev-gif/Romulus/blob/main/PRIVACY.md#health";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(POLICY)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {}
        finish();
    }
}
