package com.divaor.tracker;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Send a log (the icon's long-press menu, and Settings): the share sheet with LogReport. It
 * runs in a process of its own (":log" in the manifest) and shows nothing itself, so it works
 * even while the app is stuck or keeps closing.
 */
public class LogActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        new Thread(() -> {
            Intent share = LogReport.shareIntent(this);
            runOnUiThread(() -> {
                try {
                    startActivity(share);
                } finally {
                    finish();
                }
            });
        }, "log-report").start();
    }
}
