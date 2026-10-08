package com.jartro.tasks;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Invisible stop for widget row taps (a list row can only have one tap target, so the row's
 * fill-in says what to do): "done" hands the check-off to WidgetActionReceiver and closes at
 * once; "open" opens the app at that task.
 */
public class WidgetActionActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent in = getIntent();
        String op = in.getStringExtra("op");
        String id = in.getStringExtra("id");
        if ("done".equals(op) && id != null) {
            Intent b = new Intent(this, WidgetActionReceiver.class);
            b.setAction(WidgetActionReceiver.ACTION_COMPLETE);
            b.putExtra("channel", in.getStringExtra("channel"));
            b.putExtra("id", id);
            sendBroadcast(b);
        } else if ("open".equals(op) && id != null) {
            Intent open = new Intent(this, MainActivity.class);
            open.setAction("com.jartro.tasks.OPEN_TASK");
            open.putExtra("hookKind", "open");
            open.putExtra("hookArg", id);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(open);
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
