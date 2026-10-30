package com.divaor.tracker;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Read aloud with Android's own text to speech, for the page (its WebView has no
 * speechSynthesis): the voices, one passage spoken at a time (the page queues them, so it can
 * pause, skip and highlight), and stopping. Each utterance reports start, done, stopped or
 * error through `events`, with the page's id for it. Passages can also be made into audio
 * without playing them (`synthesize`), so the page makes the next ones while one plays: an
 * engine slower than speech (Kokoro on the phone) then reads without waiting between them.
 */
final class Speech {

    interface Events {
        void emit(JSObject event);
    }

    interface Fail {
        void with(String message);
    }

    interface Failed {
        void with(String message, String code);
    }

    /** A passage being made into a file: where, and who waits for it. */
    private static final class Making {
        final File file;
        final Callback<JSObject> done;
        final Failed fail;

        Making(File file, Callback<JSObject> done, Failed fail) {
            this.file = file;
            this.done = done;
            this.fail = fail;
        }
    }

    private final Map<String, Making> making = new HashMap<>();

    private final Context context;
    private final Events events;
    private TextToSpeech tts;
    private String engine = ""; // the engine's package asked for, "" for the phone's preferred one
    private int status = 0; // 0 starting, 1 ready, -1 failed
    private final List<Runnable> waiting = new ArrayList<>();
    private final List<Fail> waitingFails = new ArrayList<>();

    Speech(Context context, Events events) {
        this.context = context.getApplicationContext();
        this.events = events;
    }

    /** Runs `then` once the engine is ready (started the first time it is needed). */
    private synchronized void whenReady(Runnable then, Fail fail) {
        if (status == 1) {
            then.run();
            return;
        }
        if (status == -1) {
            status = 0;
            tts = null;
        }
        waiting.add(then);
        waitingFails.add(fail);
        if (tts != null) return;
        tts = engine.isEmpty()
            ? new TextToSpeech(context, (result) -> started(result == TextToSpeech.SUCCESS))
            : new TextToSpeech(context, (result) -> started(result == TextToSpeech.SUCCESS), engine);
    }

    /**
     * Speaks with the engine of package `name` ("" for the phone's preferred one) from now on:
     * what the old one was doing is stopped and it is let go.
     */
    void useEngine(String name) {
        String wanted = name == null ? "" : name;
        synchronized (this) {
            if (wanted.equals(engine)) return;
        }
        stop();
        synchronized (this) {
            if (tts != null) tts.shutdown();
            tts = null;
            status = 0;
            engine = wanted;
        }
    }

    private void started(boolean ok) {
        List<Runnable> run;
        List<Fail> fails;
        synchronized (this) {
            if (!ok && !engine.isEmpty()) {
                // That engine is gone (uninstalled): the phone's preferred one instead.
                if (tts != null) tts.shutdown();
                engine = "";
                tts = new TextToSpeech(context, (result) -> started(result == TextToSpeech.SUCCESS));
                return;
            }
            status = ok ? 1 : -1;
            run = new ArrayList<>(waiting);
            fails = new ArrayList<>(waitingFails);
            waiting.clear();
            waitingFails.clear();
            if (ok) {
                tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String id) {
                        if (!isMaking(id)) report(id, "start", 0);
                    }

                    @Override
                    public void onDone(String id) {
                        if (!made(id)) report(id, "done", 0);
                    }

                    @Override
                    public void onError(String id) {
                        onError(id, TextToSpeech.ERROR);
                    }

                    @Override
                    public void onError(String id, int code) {
                        Making m = take(id);
                        if (m != null) m.fail.with(messageFor(code), "error");
                        else report(id, "error", code);
                    }

                    @Override
                    public void onStop(String id, boolean interrupted) {
                        Making m = take(id);
                        if (m != null) m.fail.with("stopped", "interrupted");
                        else report(id, "stopped", 0);
                    }
                });
            } else if (tts != null) {
                tts.shutdown();
            }
        }
        if (ok) {
            for (Runnable r : run) r.run();
        } else {
            for (Fail f : fails) f.with("This phone has no text-to-speech engine. Install Speech Services by Google from the Play Store, or choose a speech server in Settings → Read aloud.");
        }
    }

    private void report(String id, String type, int code) {
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("type", type);
        if ("error".equals(type)) event.put("message", messageFor(code));
        events.emit(event);
    }

    private static String messageFor(int code) {
        switch (code) {
            case TextToSpeech.ERROR_NETWORK:
            case TextToSpeech.ERROR_NETWORK_TIMEOUT:
                return "this voice needs a connection; choose one on the phone in Settings → Read aloud";
            case TextToSpeech.ERROR_NOT_INSTALLED_YET:
                return "the voice is still being downloaded; try again in a moment";
            case TextToSpeech.ERROR_OUTPUT:
                return "the phone could not play the sound";
            case TextToSpeech.ERROR_SERVICE:
                return "the text-to-speech engine stopped";
            case TextToSpeech.ERROR_SYNTHESIS:
                return "the voice could not read this text";
            case TextToSpeech.ERROR_INVALID_REQUEST:
                return "the text-to-speech engine refused the text";
            default:
                return "the text-to-speech engine failed";
        }
    }

    /**
     * { voices: [{ name, lang, network, quality }], defaultVoice, engine, systemEngine, engines: [{ name, label }] }:
     * the installed voices of the engine in use, and the engines on the phone.
     */
    void voices(Callback<JSObject> done, Fail fail) {
        whenReady(() -> {
            JSObject out = new JSObject();
            JSArray list = new JSArray();
            Set<Voice> all = null;
            try {
                all = tts.getVoices();
            } catch (Exception ignored) {}
            if (all != null) {
                for (Voice v : all) {
                    Set<String> features = v.getFeatures();
                    if (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("lang", v.getLocale().toLanguageTag());
                    o.put("network", v.isNetworkConnectionRequired());
                    o.put("quality", v.getQuality());
                    list.put(o);
                }
            }
            out.put("voices", list);
            Voice def = null;
            try {
                def = tts.getDefaultVoice();
            } catch (Exception ignored) {}
            out.put("defaultVoice", def != null ? def.getName() : "");
            String preferred = tts.getDefaultEngine();
            String using;
            synchronized (this) {
                using = engine.isEmpty() ? preferred : engine;
            }
            out.put("engine", using);
            out.put("systemEngine", preferred);
            JSArray engines = new JSArray();
            try {
                for (TextToSpeech.EngineInfo e : tts.getEngines()) {
                    JSObject o = new JSObject();
                    o.put("name", e.name);
                    o.put("label", e.label);
                    engines.put(o);
                }
            } catch (Exception ignored) {}
            out.put("engines", engines);
            done.with(out);
        }, fail);
    }

    /** Speaks `text` now (what was speaking stops), as utterance `id`. */
    void speak(String id, String text, String voiceName, String lang, float rate, float pitch, Fail fail) {
        whenReady(() -> {
            setVoiceFor(voiceName, lang);
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            int result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id);
            if (result != TextToSpeech.SUCCESS) report(id, "error", TextToSpeech.ERROR);
        }, fail);
    }

    /**
     * Makes `text` into audio without playing it, after the passages asked for before:
     * `done` gets { audio: base64 WAV, mime }. A stop fails it with the code "interrupted".
     */
    void synthesize(String id, String text, String voiceName, String lang, float rate, float pitch, Callback<JSObject> done, Failed fail) {
        whenReady(() -> {
            File dir = new File(context.getCacheDir(), "tts");
            if (!dir.isDirectory() && !dir.mkdirs()) {
                fail.with("the phone has no room for the audio", "error");
                return;
            }
            File file = new File(dir, id.replaceAll("[^A-Za-z0-9_-]", "_") + ".wav");
            setVoiceFor(voiceName, lang);
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            synchronized (making) {
                making.put(id, new Making(file, done, fail));
            }
            int result = tts.synthesizeToFile(text, new Bundle(), file, id);
            if (result != TextToSpeech.SUCCESS) {
                Making m = take(id);
                if (m != null) m.fail.with(messageFor(TextToSpeech.ERROR), "error");
            }
        }, (message) -> fail.with(message, "error"));
    }

    private boolean isMaking(String id) {
        synchronized (making) {
            return making.containsKey(id);
        }
    }

    private Making take(String id) {
        Making m;
        synchronized (making) {
            m = making.remove(id);
        }
        if (m != null && m.file.exists() && !m.file.delete()) m.file.deleteOnExit();
        return m;
    }

    // A passage made into its file: handed over and the file removed. False when it was spoken instead.
    private boolean made(String id) {
        Making m;
        synchronized (making) {
            m = making.remove(id);
        }
        if (m == null) return false;
        try (FileInputStream in = new FileInputStream(m.file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(1024, m.file.length()));
            byte[] buffer = new byte[64 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            JSObject result = new JSObject();
            result.put("audio", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            result.put("mime", "audio/wav");
            m.done.with(result);
        } catch (IOException e) {
            m.fail.with("the audio could not be read back", "error");
        } finally {
            if (!m.file.delete()) m.file.deleteOnExit();
        }
        return true;
    }

    private void setVoiceFor(String voiceName, String lang) {
        Voice voice = null;
        if (voiceName != null && !voiceName.isEmpty()) {
            try {
                for (Voice v : tts.getVoices()) {
                    if (v.getName().equals(voiceName)) voice = v;
                }
            } catch (Exception ignored) {}
        }
        if (voice != null) tts.setVoice(voice);
        else if (lang != null && !lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
    }

    void stop() {
        synchronized (this) {
            if (status != 1 || tts == null) return;
        }
        tts.stop();
        // What was still being made is not wanted any more (the engine may not say so for each).
        List<String> ids;
        synchronized (making) {
            ids = new ArrayList<>(making.keySet());
        }
        for (String id : ids) {
            Making m = take(id);
            if (m != null) m.fail.with("stopped", "interrupted");
        }
    }

    synchronized void shutdown() {
        if (tts != null) tts.shutdown();
        tts = null;
        status = 0;
        File[] left = new File(context.getCacheDir(), "tts").listFiles();
        if (left != null) for (File f : left) f.delete();
    }

    interface Callback<T> {
        void with(T value);
    }
}
