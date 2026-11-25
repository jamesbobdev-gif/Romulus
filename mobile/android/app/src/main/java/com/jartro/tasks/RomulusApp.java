package com.jartro.tasks;

import android.app.Application;

/**
 * Starts Firebase for the Agent's notifications before anything else runs, so a notification that wakes the
 * app while it is closed finds it ready (Push.init; nothing happens in a build without a Firebase project).
 */
public class RomulusApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Push.init(this);
    }
}
