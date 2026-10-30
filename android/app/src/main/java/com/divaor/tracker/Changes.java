package com.divaor.tracker;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Changes made elsewhere while the app is closed: about every 15 minutes (ChangesJob, Android's
 * shortest period) the data repo's commits since the last look, and a notification for what
 * Claude (the connector) and, when wanted, your other devices did (CommitNote). The page sets it
 * up (`configure`) whenever its sync settings change; with the app open, its own sync tells.
 * Only with GitHub sync: data kept on the phone alone has no one else writing it.
 */
final class Changes {

    static final String PREFS = "checks";
    static final int JOB_ID = 4201;
    static final String CHANNEL = "changes";
    private static final long PERIOD = 15 * 60 * 1000L;
    private static final int MAX_SHOWN = 3;

    private Changes() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * { enabled, api, owner, repo, branch, device, items, documents, devices } from the page;
     * on: the checks are scheduled, telling what is new from now on; off: they stop.
     */
    static void configure(Context context, JSONObject config) {
        boolean on = config.optBoolean("enabled") && !config.optString("owner").isEmpty() && !config.optString("repo").isEmpty();
        SharedPreferences prefs = prefs(context);
        String where = config.optString("api") + "/" + config.optString("owner") + "/" + config.optString("repo") + "#" + config.optString("branch");
        SharedPreferences.Editor edit = prefs.edit()
            .putBoolean("enabled", on)
            .putString("api", config.optString("api", "https://api.github.com"))
            .putString("owner", config.optString("owner"))
            .putString("repo", config.optString("repo"))
            .putString("branch", config.optString("branch"))
            .putString("device", config.optString("device"))
            .putBoolean("items", config.optBoolean("items", true))
            .putBoolean("documents", config.optBoolean("documents", true))
            .putBoolean("devices", config.optBoolean("devices", false));
        // Another repo, or a first start: what is new is told from now on.
        if (!where.equals(prefs.getString("where", ""))) edit.putString("where", where).remove("since");
        if (on && (!where.equals(prefs.getString("where", "")) || !prefs.contains("since"))) edit.putString("since", iso(System.currentTimeMillis()));
        edit.apply();
        JobScheduler jobs = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (jobs == null) return;
        if (!on) {
            jobs.cancel(JOB_ID);
            return;
        }
        channel(context);
        if (jobs.getPendingJob(JOB_ID) != null) return;
        jobs.schedule(
            new JobInfo.Builder(JOB_ID, new ComponentName(context, ChangesJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIOD)
                .setPersisted(true)
                .build()
        );
    }

    /** { enabled, allowed (notifications on for the app), scheduled, last (when it last looked), error }. */
    static JSONObject state(Context context) {
        JSONObject out = new JSONObject();
        try {
            SharedPreferences prefs = prefs(context);
            JobScheduler jobs = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            out.put("enabled", prefs.getBoolean("enabled", false));
            out.put("allowed", NotificationManagerCompat.from(context).areNotificationsEnabled());
            out.put("scheduled", jobs != null && jobs.getPendingJob(JOB_ID) != null);
            out.put("last", prefs.getString("last", ""));
            out.put("error", prefs.getString("error", ""));
        } catch (Exception ignored) {}
        return out;
    }

    static void channel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, context.getString(R.string.changes_channel), NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(context.getString(R.string.changes_channel_about));
        manager.createNotificationChannel(channel);
    }

    private static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    /** One look: the commits since the last one, and their notifications. Answers how many were shown. */
    static int check(Context context) throws Exception {
        SharedPreferences prefs = prefs(context);
        if (!prefs.getBoolean("enabled", false)) return 0;
        String token = Secrets.read(context, "github-token");
        if (token == null || token.isEmpty()) throw new IllegalStateException("No GitHub token on this phone.");
        String since = prefs.getString("since", null);
        String now = iso(System.currentTimeMillis());
        if (since == null) {
            // The first look: only where to start from.
            prefs.edit().putString("since", now).putString("last", now).remove("error").apply();
            return 0;
        }
        String api = prefs.getString("api", "https://api.github.com").replaceAll("/+$", "");
        String url = api + "/repos/" + enc(prefs.getString("owner", "")) + "/" + enc(prefs.getString("repo", "")) + "/commits?per_page=30&since=" + enc(since)
            + (prefs.getString("branch", "").isEmpty() ? "" : "&sha=" + enc(prefs.getString("branch", "")));
        JSONArray commits;
        try {
            commits = new JSONArray(get(url, token));
        } catch (Exception e) {
            prefs.edit().putString("error", e.getMessage() == null ? e.toString() : e.getMessage()).apply();
            throw e;
        }
        String device = prefs.getString("device", "");
        boolean devices = prefs.getBoolean("devices", false);
        boolean wanted = prefs.getBoolean("items", true) || prefs.getBoolean("documents", true);
        String newest = since;
        List<CommitNote> notes = new ArrayList<>();
        // Oldest first, as they happened; "since" is inclusive, so the last one seen is skipped.
        for (int i = commits.length() - 1; i >= 0; i--) {
            JSONObject commit = commits.getJSONObject(i).getJSONObject("commit");
            String date = commit.getJSONObject("committer").optString("date", "");
            if (date.compareTo(since) <= 0) continue;
            if (date.compareTo(newest) > 0) newest = date;
            CommitNote note = CommitNote.of(commit.optString("message"), device, devices);
            if (note != null && (wanted || !note.claude)) notes.add(note);
        }
        prefs.edit().putString("since", newest).putString("last", now).remove("error").apply();
        if (notes.isEmpty() || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return 0;
        show(context, notes);
        return notes.size();
    }

    private static String enc(String s) throws Exception {
        return URLEncoder.encode(s, "UTF-8");
    }

    private static String get(String url, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(30000);
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("Accept", "application/vnd.github+json");
        conn.setRequestProperty("User-Agent", "Tracker-Android");
        try {
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
            }
            String body = out.toString("UTF-8");
            if (status == 401) throw new IllegalStateException("GitHub refused the token (it may have expired).");
            if (status >= 400) throw new IllegalStateException("GitHub answered " + status + ".");
            return body;
        } finally {
            conn.disconnect();
        }
    }

    // One notification each (up to MAX_SHOWN), else one that sums them up. A tap opens the app.
    private static void show(Context context, List<CommitNote> notes) {
        channel(context);
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("tracker-app://open"), context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        int base = (int) (System.currentTimeMillis() / 1000 % 100000) * 10;
        try {
            if (notes.size() <= MAX_SHOWN) {
                for (int i = 0; i < notes.size(); i++) {
                    CommitNote note = notes.get(i);
                    manager.notify(base + i, builder(context, tap).setContentTitle(note.claude ? note.who + " on your tracker" : note.who).setContentText(note.what).build());
                }
            } else {
                NotificationCompat.InboxStyle style = new NotificationCompat.InboxStyle();
                for (CommitNote note : notes) style.addLine(note.who + ": " + note.what);
                manager.notify(base, builder(context, tap)
                    .setContentTitle(notes.size() + " changes on your tracker")
                    .setContentText(notes.get(notes.size() - 1).who + ": " + notes.get(notes.size() - 1).what)
                    .setStyle(style)
                    .build());
            }
        } catch (SecurityException e) {
            AppLog.w("changes", "Notifications are not allowed", e);
        }
    }

    private static NotificationCompat.Builder builder(Context context, PendingIntent tap) {
        return new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF4F46E5)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
    }
}
