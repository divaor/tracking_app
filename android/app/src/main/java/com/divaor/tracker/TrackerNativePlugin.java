package com.divaor.tracker;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.speech.RecognizerIntent;
import android.util.Base64;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * The Android side of the tracker (app/js/androidApp.js is the page's side): what is shared with
 * the app (Share, the text selection's menu) and links to it (tracker-app://), files shared with
 * it read as bytes, attachments opened with other apps and saved where the person picks,
 * secrets kept with a key in the Android Keystore (Secrets), the Back button, the phone's voices
 * (Speech), requests to model and speech servers on your network (no CORS there, plain http
 * allowed), and the change checks while the app is closed (Changes).
 */
@CapacitorPlugin(
    name = "TrackerNative",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class TrackerNativePlugin extends Plugin {

    private static final String TAKEN = "com.divaor.tracker.TAKEN";
    private static final String LINK_SCHEME = "tracker-app";
    // Larger files than this are not read (attachments go up to 25 MB).
    private static final int MAX_READ = 40 * 1024 * 1024;
    // Copies of attachments opened with other apps are kept this long.
    private static final long OPEN_COPIES_DAYS = 7;

    private final List<JSObject> pending = new ArrayList<>();
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> requests = new ConcurrentHashMap<>();

    @Override
    public void load() {
        // Back: the page closes what is open on top (an item, Help, a picture); with nothing
        // open it calls minimize(). Without a page listening, the system does what it does.
        OnBackPressedCallback back = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (hasListeners("back")) {
                    notifyListeners("back", new JSObject());
                } else {
                    setEnabled(false);
                    getActivity().getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        };
        getActivity().runOnUiThread(() -> getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), back));
        io.execute(this::forgetOldCopies);
    }

    // The activity is singleTask: things shared and links opened while it runs come here too
    // (and the first intent, which BridgeActivity passes on after loading the plugins).
    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (take(intent)) notifyListeners("launch", new JSObject(), true);
    }

    private boolean take(Intent intent) {
        if (intent == null || intent.getBooleanExtra(TAKEN, false)) return false;
        String action = intent.getAction();
        List<JSObject> items = new ArrayList<>();
        Uri data = intent.getData();
        if (Intent.ACTION_VIEW.equals(action) && data != null && LINK_SCHEME.equals(data.getScheme())) {
            // tracker-app://item/<id>, new, voice (the icon's shortcuts), open (a notification).
            JSObject item = new JSObject();
            item.put("kind", "link");
            item.put("url", data.toString());
            items.add(item);
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri stream = streamOf(intent);
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (stream != null) items.add(fileItem(stream));
            else if (text != null) items.add(textItem(text.toString(), intent.getStringExtra(Intent.EXTRA_SUBJECT)));
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            for (Uri uri : streamsOf(intent)) items.add(fileItem(uri));
        } else if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
            if (text != null) items.add(textItem(text.toString(), null));
        }
        intent.putExtra(TAKEN, true);
        if (items.isEmpty()) return false;
        synchronized (pending) {
            pending.addAll(items);
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private static Uri streamOf(Intent intent) {
        Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream instanceof Uri) return (Uri) stream;
        ClipData clip = intent.getClipData();
        if (clip != null && clip.getItemCount() > 0 && clip.getItemAt(0).getUri() != null) return clip.getItemAt(0).getUri();
        // Some apps give the file as the intent's data instead.
        return intent.getData();
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> streamsOf(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        ArrayList<?> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (list != null) for (Object o : list) if (o instanceof Uri) uris.add((Uri) o);
        if (uris.isEmpty() && intent.getClipData() != null) {
            ClipData clip = intent.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) uris.add(clip.getItemAt(i).getUri());
        }
        return uris;
    }

    private static JSObject textItem(String text, String subject) {
        JSObject item = new JSObject();
        item.put("kind", "text");
        item.put("text", text);
        item.put("title", subject == null ? "" : subject);
        return item;
    }

    private JSObject fileItem(Uri uri) {
        JSObject item = describe(uri);
        item.put("kind", "file");
        return item;
    }

    /** { uri, name, size, mime } (size -1 when the app that has it does not say). */
    private JSObject describe(Uri uri) {
        JSObject info = new JSObject();
        info.put("uri", uri.toString());
        String name = uri.getLastPathSegment();
        long size = -1;
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int s = c.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0 && !c.isNull(n)) name = c.getString(n);
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
            }
        } catch (Exception ignored) {
            // Some apps answer no questions about their files: the name from the address.
        }
        String mime = null;
        try {
            mime = getContext().getContentResolver().getType(uri);
        } catch (Exception ignored) {}
        info.put("name", name == null ? "file" : name);
        info.put("size", size);
        info.put("mime", mime == null ? "" : mime);
        return info;
    }

    /** What was shared with the app or opened in it since the last call: { items: [{ kind: 'link' | 'text' | 'file', … }] }. */
    @PluginMethod
    public void takeLaunch(PluginCall call) {
        JSArray items = new JSArray();
        synchronized (pending) {
            for (JSObject item : pending) items.put(item);
            pending.clear();
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    /** A shared file's bytes as base64: { data, length }. */
    @PluginMethod
    public void read(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("No file.");
            return;
        }
        io.execute(() -> {
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                if (in == null) throw new FileNotFoundException("The file could not be opened.");
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_READ) throw new IllegalStateException("The file is larger than 40 MB.");
                }
                JSObject result = new JSObject();
                result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                result.put("length", out.size());
                call.resolve(result);
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    /** Opens { name, mime, data (base64) } with another app (the system asks which): a copy in the app's cache. */
    @PluginMethod
    public void openBytes(PluginCall call) {
        String name = safeName(call.getString("name", "file"));
        String mime = call.getString("mime", "");
        String data = call.getString("data", "");
        io.execute(() -> {
            try {
                File dir = new File(new File(getContext().getCacheDir(), "open"), UUID.randomUUID().toString());
                if (!dir.mkdirs()) throw new IllegalStateException("The copy could not be made.");
                File file = new File(dir, name);
                try (OutputStream out = new FileOutputStream(file)) {
                    out.write(Base64.decode(data, Base64.NO_WRAP));
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, mime == null || mime.isEmpty() ? "*/*" : mime);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                intent.setClipData(ClipData.newRawUri("", uri));
                getActivity().startActivity(Intent.createChooser(intent, "Open " + name + " with"));
                call.resolve();
            } catch (ActivityNotFoundException e) {
                call.reject("No app on this phone opens this kind of file.");
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    // The name as a file name here (no folders, nothing hidden).
    private static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[/\\\\:*?\"<>|\\x00-\\x1f]", "_").replaceAll("^\\.+", "").trim();
        return n.isEmpty() ? "file" : n;
    }

    // Copies opened with other apps older than a week go.
    private void forgetOldCopies() {
        File[] dirs = new File(getContext().getCacheDir(), "open").listFiles();
        if (dirs == null) return;
        long old = System.currentTimeMillis() - OPEN_COPIES_DAYS * 24 * 3600 * 1000L;
        for (File dir : dirs) {
            if (dir.lastModified() > old) continue;
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) f.delete();
            dir.delete();
        }
    }

    /** Save a copy: the system asks where; `data` (base64) is written there. Resolves { name } or { canceled }. */
    @PluginMethod
    public void saveAs(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "file"));
        startActivityForResult(call, intent, "savedAs");
    }

    @ActivityCallback
    private void savedAs(PluginCall call, ActivityResult result) {
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (uri == null) {
            JSObject out = new JSObject();
            out.put("canceled", true);
            call.resolve(out);
            return;
        }
        String data = call.getString("data", "");
        io.execute(() -> {
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new FileNotFoundException("It could not be saved there.");
                out.write(Base64.decode(data, Base64.NO_WRAP));
                call.resolve(describe(uri));
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    /** Whether an app is installed: { package } → { installed } (Tracker Editor, for Open in editor). */
    @PluginMethod
    public void appInstalled(PluginCall call) {
        boolean installed;
        try {
            getContext().getPackageManager().getPackageInfo(call.getString("package", ""), 0);
            installed = true;
        } catch (PackageManager.NameNotFoundException e) {
            installed = false;
        }
        JSObject out = new JSObject();
        out.put("installed", installed);
        call.resolve(out);
    }

    /** Back with nothing left to close: the app goes to the background, as Home does. */
    @PluginMethod
    public void minimize(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    /** Lines from the page for the app's log ({ lines: [string] }): its errors and what it did. */
    @PluginMethod
    public void log(PluginCall call) {
        try {
            JSArray lines = call.getArray("lines", new JSArray());
            for (int i = 0; i < lines.length() && i < 200; i++) {
                String line = lines.getString(i);
                AppLog.write("page", line.length() > 4000 ? line.substring(0, 4000) + "…" : line);
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    /** Send a log: the share sheet with the log (LogActivity, as from the icon's menu). */
    @PluginMethod
    public void sendLog(PluginCall call) {
        getActivity().startActivity(new Intent(getContext(), LogActivity.class));
        call.resolve();
    }

    /** { sdk, release, manufacturer, model, versionName, versionCode }. */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject info = new JSObject();
        info.put("sdk", Build.VERSION.SDK_INT);
        info.put("release", Build.VERSION.RELEASE);
        info.put("manufacturer", Build.MANUFACTURER);
        info.put("model", Build.MODEL);
        try {
            Context context = getContext();
            PackageInfo p = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            info.put("versionName", p.versionName);
            info.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
        } catch (Exception ignored) {}
        call.resolve(info);
    }

    // ---- Secrets: the GitHub token and the model and speech keys (Secrets) ----

    @PluginMethod
    public void secretGet(PluginCall call) {
        JSObject out = new JSObject();
        out.put("value", Secrets.read(getContext(), call.getString("key")));
        call.resolve(out);
    }

    @PluginMethod
    public void secretSet(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("No name.");
            return;
        }
        try {
            Secrets.write(getContext(), key, call.getString("value"));
            call.resolve();
        } catch (Exception e) {
            call.reject("The secret could not be kept: " + message(e));
        }
    }

    // ---- Requests to model and speech servers (Ollama, Kokoro on your network; providers) ----
    // As the desktop's main process makes them: no CORS, plain http allowed. The answer's status
    // and headers resolve the call; its body follows as "http" events ({ id, data } in base64,
    // then { id, done } or { id, error }), so a model's reply streams.

    @PluginMethod
    public void httpRequest(PluginCall call) {
        String id = call.getString("id", "");
        String url = call.getString("url", "");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("Only http and https servers are supported.");
            return;
        }
        io.execute(() -> {
            HttpURLConnection conn = null;
            boolean answered = false;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                requests.put(id, conn);
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(300000);
                conn.setRequestMethod(call.getString("method", "GET"));
                JSObject headers = call.getObject("headers", new JSObject());
                for (Iterator<String> keys = headers.keys(); keys.hasNext(); ) {
                    String name = keys.next();
                    conn.setRequestProperty(name, headers.getString(name));
                }
                String body = call.getString("body", null);
                if (body != null) {
                    conn.setDoOutput(true);
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                int status = conn.getResponseCode();
                JSObject meta = new JSObject();
                meta.put("status", status);
                meta.put("statusText", conn.getResponseMessage() == null ? "" : conn.getResponseMessage());
                JSObject answerHeaders = new JSObject();
                for (Map.Entry<String, List<String>> h : conn.getHeaderFields().entrySet()) {
                    if (h.getKey() != null && !h.getValue().isEmpty()) answerHeaders.put(h.getKey().toLowerCase(), h.getValue().get(0));
                }
                meta.put("headers", answerHeaders);
                call.resolve(meta);
                answered = true;
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (in != null) {
                    try (InputStream body2 = in) {
                        byte[] buf = new byte[32 * 1024];
                        int n;
                        while ((n = body2.read(buf)) > 0) {
                            JSObject chunk = new JSObject();
                            chunk.put("id", id);
                            chunk.put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                            notifyListeners("http", chunk);
                        }
                    }
                }
                JSObject done = new JSObject();
                done.put("id", id);
                done.put("done", true);
                notifyListeners("http", done);
            } catch (Exception e) {
                String why = requests.containsKey(id) ? message(e) : "Stopped";
                if (!answered) {
                    // Before the answer came: the call itself fails.
                    call.reject(e instanceof java.net.ConnectException ? "Nothing is listening at " + Uri.parse(url).getHost() : why);
                } else {
                    JSObject failed = new JSObject();
                    failed.put("id", id);
                    failed.put("error", why);
                    notifyListeners("http", failed);
                }
            } finally {
                requests.remove(id);
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void httpAbort(PluginCall call) {
        HttpURLConnection conn = requests.remove(call.getString("id", ""));
        if (conn != null) io.execute(conn::disconnect);
        call.resolve();
    }

    // ---- Notifications of changes while the app is closed (Changes) ----

    /** The page's sync settings: { enabled, api, owner, repo, branch, device, items, documents, devices }. */
    @PluginMethod
    public void notifyConfig(PluginCall call) {
        try {
            Changes.configure(getContext(), new JSONObject(call.getData().toString()));
            call.resolve();
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    /** { enabled, allowed, scheduled, last, error }. */
    @PluginMethod
    public void notifyState(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(Changes.state(getContext())));
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    /** Asks for notifications (Android 13 and later); then as notifyState. */
    @PluginMethod
    public void notifyAsk(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            notifyState(call);
            return;
        }
        requestPermissionForAlias("notifications", call, "notifyAsked");
    }

    @PermissionCallback
    private void notifyAsked(PluginCall call) {
        notifyState(call);
    }

    /** The app's notification settings, where the person turns them on once refused. */
    @PluginMethod
    public void notifySettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        try {
            getActivity().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
        }
        call.resolve();
    }

    /** One check now (as the periodic one): { shown }. */
    @PluginMethod
    public void notifyCheck(PluginCall call) {
        io.execute(() -> {
            try {
                JSObject out = new JSObject();
                out.put("shown", Changes.check(getContext()));
                call.resolve(out);
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    private static String message(Exception e) {
        if (e instanceof SecurityException) return "This app is not allowed to open the file.";
        if (e instanceof FileNotFoundException) return e.getMessage() == null ? "The file is not there." : e.getMessage();
        return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    }

    // ---- Dictation: the phone's speech input (the WebView has no speech recognition) ----

    /** { lang }: the phone listens to one phrase; resolves { text } ('' when nothing was said). */
    @PluginMethod
    public void dictate(PluginCall call) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        String lang = call.getString("lang", "");
        if (lang != null && !lang.isEmpty()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, call.getString("prompt", "Say it"));
        try {
            startActivityForResult(call, intent, "dictated");
        } catch (ActivityNotFoundException e) {
            call.reject("This phone has no speech input (install or turn on Google's).");
        }
    }

    @ActivityCallback
    private void dictated(PluginCall call, ActivityResult result) {
        ArrayList<String> texts = result.getData() == null ? null : result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        JSObject out = new JSObject();
        out.put("text", texts == null || texts.isEmpty() ? "" : texts.get(0));
        call.resolve(out);
    }

    // ---- Listen: Android's own text to speech (Speech.java), as the WebView has none ----

    private Speech speech;

    private synchronized Speech speech() {
        if (speech == null) speech = new Speech(getContext(), (event) -> notifyListeners("tts", event));
        return speech;
    }

    // The engine the page asks for ("engine": a package, "" for the phone's preferred one).
    private Speech speech(PluginCall call) {
        Speech s = speech();
        s.useEngine(call.getString("engine", ""));
        return s;
    }

    /** { engine }: { voices: [{ name, lang, network, quality }], defaultVoice, engine, systemEngine, engines: [{ name, label }] }. */
    @PluginMethod
    public void ttsVoices(PluginCall call) {
        speech(call).voices(call::resolve, call::reject);
    }

    /** Speaks { id, text, voice, lang, rate, pitch } now; how it goes comes as "tts" events with that id. */
    @PluginMethod
    public void ttsSpeak(PluginCall call) {
        String id = call.getString("id", "");
        speech(call).speak(id, call.getString("text", ""), call.getString("voice", ""), call.getString("lang", ""),
            call.getFloat("rate", 1f), call.getFloat("pitch", 1f), (message) -> {
                JSObject event = new JSObject();
                event.put("id", id);
                event.put("type", "error");
                event.put("message", message);
                notifyListeners("tts", event);
            });
        call.resolve();
    }

    /** Makes { id, text, voice, lang, rate, pitch } into audio without playing it: { audio (base64 WAV), mime }. */
    @PluginMethod
    public void ttsSynthesize(PluginCall call) {
        speech(call).synthesize(call.getString("id", ""), call.getString("text", ""), call.getString("voice", ""), call.getString("lang", ""),
            call.getFloat("rate", 1f), call.getFloat("pitch", 1f), call::resolve, call::reject);
    }

    @PluginMethod
    public void ttsStop(PluginCall call) {
        if (speech != null) speech.stop();
        call.resolve();
    }

    /** { on }: the screen stays on while reading aloud. */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (speech != null) speech.shutdown();
    }
}
