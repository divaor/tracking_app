package com.divaor.tracker;

import android.content.Context;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * The app's own log, for "Send a log" (LogActivity): what the app and the page report, in
 * files/logs (app.log); a file past MAX becomes app.old.log, so a log never holds more than two.
 * Nothing secret goes in: no tokens, keys or passwords, and none of the items.
 */
final class AppLog {

    static final String TAG = "Tracker";
    private static final long MAX = 384 * 1024;
    private static Context app;
    private static String file = "app.log";

    private AppLog() {}

    /** Once per process, with the name of its file. */
    static synchronized void init(Context context, String name) {
        app = context.getApplicationContext();
        file = name;
    }

    static File dir(Context context) {
        File dir = new File(context.getFilesDir(), "logs");
        dir.mkdirs();
        return dir;
    }

    static File fileFor(Context context, String name) {
        return new File(dir(context), name);
    }

    /** A file past MAX moves aside (its .old.log), so writing starts a fresh one. */
    static void rotate(File f) {
        if (f.length() <= MAX) return;
        File old = new File(f.getParent(), f.getName().replace(".log", ".old.log"));
        old.delete();
        f.renameTo(old);
    }

    static String stamp() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.ROOT).format(new Date());
    }

    static void i(String tag, String message) {
        Log.i(TAG, tag + ": " + message);
        write(tag, message);
    }

    static void w(String tag, String message, Throwable t) {
        Log.w(TAG, tag + ": " + message, t);
        write(tag, t == null ? message : message + "\n" + Log.getStackTraceString(t));
    }

    static synchronized void write(String tag, String message) {
        if (app == null) return;
        try {
            File f = fileFor(app, file);
            rotate(f);
            try (OutputStream out = new FileOutputStream(f, true)) {
                out.write((stamp() + " [" + tag + "] " + message + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not write the log", e);
        }
    }

    /** Uncaught exceptions in this process go in the log before the process ends. */
    static void catchCrashes() {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            w("crash", "Uncaught in thread " + thread.getName(), error);
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }
}
