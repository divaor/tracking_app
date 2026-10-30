package com.divaor.tracker;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.webkit.WebView;
import androidx.annotation.RequiresApi;
import androidx.core.content.FileProvider;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * "Send a log": what to send when something goes wrong. The app and phone (versions, model,
 * WebView), what Android recorded about the app's last exits (a crash, a freeze with where the
 * app was stuck), and the logs of the app and the page (AppLog). Shared as a text
 * file through the system's share sheet, so the person chooses where it goes.
 */
final class LogReport {

    private static final int MAX_FILE_PART = 300 * 1024;
    private static final int MAX_TRACE = 48 * 1024;

    private LogReport() {}

    static String build(Context context) {
        StringBuilder out = new StringBuilder();
        out.append("Tracker log, made ").append(AppLog.stamp()).append("\n");
        out.append("It holds what the app did and its errors, never passwords, keys, tokens or your items.\n\n");
        try {
            PackageInfo p = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            out.append("App: ").append(p.versionName).append(" (").append(Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode).append(")\n");
        } catch (Exception ignored) {}
        out.append("Android: ").append(Build.VERSION.RELEASE).append(" (SDK ").append(Build.VERSION.SDK_INT).append(")\n");
        out.append("Phone: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append(", ").append(Arrays.toString(Build.SUPPORTED_ABIS)).append("\n");
        if (Build.VERSION.SDK_INT >= 26) {
            PackageInfo web = WebView.getCurrentWebViewPackage();
            if (web != null) out.append("WebView: ").append(web.packageName).append(' ').append(web.versionName).append("\n");
        }
        out.append("\n");
        // The app's log, then Android's records with their long traces: a report cut short keeps the start.
        for (String name : new String[] { "app.old.log", "app.log" }) {
            File f = AppLog.fileFor(context, name);
            if (!f.exists()) continue;
            out.append("== ").append(name).append(" ==\n").append(tail(f, MAX_FILE_PART)).append("\n");
        }
        exits(context, out);
        return out.toString();
    }

    /** What Android recorded about how the app's processes ended (Android 11 and later). */
    static void exits(Context context, StringBuilder out) {
        if (Build.VERSION.SDK_INT < 30) return;
        out.append("== The app's last exits, as Android recorded them ==\n");
        try {
            ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(context.getPackageName(), 0, 12);
            if (list.isEmpty()) out.append("(none)\n");
            for (ApplicationExitInfo e : list) {
                out.append(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(new Date(e.getTimestamp())))
                    .append("  ").append(e.getProcessName())
                    .append("  ").append(reason(e.getReason()))
                    .append("  status ").append(e.getStatus())
                    .append("  importance ").append(e.getImportance());
                if (e.getDescription() != null) out.append("  ").append(cut(e.getDescription(), 300));
                out.append("\n");
                if (e.getReason() == ApplicationExitInfo.REASON_ANR) {
                    String trace = anrTrace(e);
                    if (!trace.isEmpty()) out.append(trace).append("\n");
                }
            }
        } catch (Exception err) {
            out.append("(could not read them: ").append(err).append(")\n");
        }
        out.append("\n");
    }

    /** The same, for the log, once per exit: called when the app starts. */
    static void logNewExits(Context context) {
        if (Build.VERSION.SDK_INT < 30) return;
        try {
            SharedPreferences prefs = context.getSharedPreferences("log", Context.MODE_PRIVATE);
            long seen = prefs.getLong("exitsSeen", 0);
            ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            long newest = seen;
            for (ApplicationExitInfo e : am.getHistoricalProcessExitReasons(context.getPackageName(), 0, 12)) {
                if (e.getTimestamp() <= seen) continue;
                newest = Math.max(newest, e.getTimestamp());
                AppLog.i("exit", e.getProcessName() + " ended " + new SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date(e.getTimestamp())) + ": " + reason(e.getReason()) + " (status " + e.getStatus() + ")" + (e.getDescription() != null ? " " + cut(e.getDescription(), 160) : ""));
            }
            prefs.edit().putLong("exitsSeen", newest).apply();
        } catch (Exception err) {
            AppLog.w("exit", "Could not read the last exits", err);
        }
    }

    private static String cut(String s, int max) {
        return s.length() > max ? s.substring(0, max) + "…" : s;
    }

    private static String reason(int r) {
        switch (r) {
            case ApplicationExitInfo.REASON_ANR:
                return "NOT RESPONDING (frozen)";
            case ApplicationExitInfo.REASON_CRASH:
                return "CRASH (Java)";
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
                return "CRASH (native)";
            case ApplicationExitInfo.REASON_EXIT_SELF:
                return "ended itself";
            case ApplicationExitInfo.REASON_SIGNALED:
                return "killed by a signal";
            case ApplicationExitInfo.REASON_LOW_MEMORY:
                return "low memory";
            case ApplicationExitInfo.REASON_USER_REQUESTED:
                return "closed by the user";
            case ApplicationExitInfo.REASON_USER_STOPPED:
                return "stopped by the user";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED:
                return "a process it needed died";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE:
                return "used too much";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE:
                return "failed to start";
            case ApplicationExitInfo.REASON_PERMISSION_CHANGE:
                return "a permission changed";
            case ApplicationExitInfo.REASON_OTHER:
                return "other";
            default:
                return "reason " + r;
        }
    }

    // An ANR's trace holds every thread: the main thread (where it was stuck) and the app's own
    // threads are what matter.
    @RequiresApi(30)
    private static String anrTrace(ApplicationExitInfo e) {
        StringBuilder kept = new StringBuilder();
        try (InputStream in = e.getTraceInputStream()) {
            if (in == null) return "";
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            StringBuilder block = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null && kept.length() < MAX_TRACE) {
                if (line.isEmpty()) {
                    String b = block.toString();
                    if (b.startsWith("\"main\"") || b.contains("com.divaor") || b.contains("CapacitorPlugins") || b.startsWith("Cmd line") || b.startsWith("----- pid")) kept.append(b).append("\n");
                    block.setLength(0);
                } else {
                    block.append(line).append("\n");
                }
            }
        } catch (Exception err) {
            return "(no trace: " + err + ")";
        }
        return kept.toString();
    }

    private static String tail(File f, int max) {
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long length = raf.length();
            long from = Math.max(0, length - max);
            byte[] bytes = new byte[(int) (length - from)];
            raf.seek(from);
            raf.readFully(bytes);
            String text = new String(bytes, StandardCharsets.UTF_8);
            return from > 0 ? "(…the start is left out)\n" + text.substring(Math.max(0, text.indexOf('\n') + 1)) : text;
        } catch (Exception err) {
            return "(could not read it: " + err + ")";
        }
    }

    /** The share sheet for the report, written to a file (off the main thread: it reads the logs). */
    static Intent shareIntent(Context context) {
        String report = build(context);
        try {
            File dir = new File(context.getCacheDir(), "log-share");
            dir.mkdirs();
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            File file = new File(dir, "tracker-log-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date()) + ".txt");
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(report.getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_SUBJECT, "Tracker log")
                .putExtra(Intent.EXTRA_TEXT, "Tracker log (attached).")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(android.content.ClipData.newRawUri("", uri));
            return Intent.createChooser(send, "Send the log");
        } catch (Exception err) {
            AppLog.w("log", "Could not write the log to share", err);
            // At least as text.
            String text = report.length() > 90000 ? report.substring(report.length() - 90000) : report;
            return Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Send the log");
        }
    }
}
