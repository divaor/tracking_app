package com.divaor.tracker;

import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.webkit.WebViewRenderProcess;
import android.webkit.WebViewRenderProcessClient;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    private final MainThreadWatch watch = new MainThreadWatch();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        AppLog.init(this, "app.log");
        AppLog.catchCrashes();
        try {
            PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            AppLog.i("app", "Started " + p.versionName + " on Android " + Build.VERSION.RELEASE + " (" + Build.MANUFACTURER + " " + Build.MODEL + ")");
        } catch (Exception ignored) {}
        new Thread(() -> LogReport.logNewExits(this), "exits").start();
        // The app's own plugin (things shared with it, secrets, Back, voices): before the bridge starts.
        registerPlugin(TrackerNativePlugin.class);
        super.onCreate(savedInstanceState);
        watchPage();
    }

    // The page's own process (the WebView's renderer): when it ends, the app would end with it;
    // instead the log says why and the page loads again. When it stops answering (busy), the
    // log says so too.
    private void watchPage() {
        if (bridge == null) return;
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    AppLog.i("page", "The page's process ended (" + (detail.didCrash() ? "it crashed" : "Android ended it to free memory") + "); loading it again");
                    runOnUiThread(MainActivity.this::recreate);
                    return true;
                }
            }
        );
        if (Build.VERSION.SDK_INT >= 29) {
            bridge.getWebView().setWebViewRenderProcessClient(
                new WebViewRenderProcessClient() {
                    private boolean busy;

                    @Override
                    public void onRenderProcessUnresponsive(WebView view, WebViewRenderProcess renderer) {
                        if (busy) return;
                        busy = true;
                        AppLog.i("page", "The page does not answer (busy)");
                    }

                    @Override
                    public void onRenderProcessResponsive(WebView view, WebViewRenderProcess renderer) {
                        if (!busy) return;
                        busy = false;
                        AppLog.i("page", "The page answers again");
                    }
                }
            );
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        watch.start();
    }

    @Override
    public void onPause() {
        watch.stop();
        super.onPause();
    }

    /**
     * While the app is in front: when its main thread (the screen, touches) does not answer for
     * a few seconds, the log says where it is stuck, and when it answers again.
     */
    private static final class MainThreadWatch implements Runnable {

        private final Handler main = new Handler(Looper.getMainLooper());
        private volatile long beat;
        private volatile boolean running;

        void start() {
            if (running) return;
            running = true;
            beat = SystemClock.uptimeMillis();
            Thread t = new Thread(this, "main-watch");
            t.setDaemon(true);
            t.start();
        }

        void stop() {
            running = false;
        }

        @Override
        public void run() {
            boolean stuck = false;
            while (running) {
                main.post(() -> beat = SystemClock.uptimeMillis());
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException e) {
                    return;
                }
                long late = SystemClock.uptimeMillis() - beat;
                if (late > 3000 && !stuck) {
                    stuck = true;
                    AppLog.i("freeze", "The main thread has not answered for " + late + " ms.\n" + stacks());
                } else if (late < 1500 && stuck) {
                    stuck = false;
                    AppLog.i("freeze", "The main thread answers again.");
                }
            }
        }

        // The main thread and the app's own background threads, where they are now.
        private static String stacks() {
            StringBuilder out = new StringBuilder();
            for (Map.Entry<Thread, StackTraceElement[]> e : Thread.getAllStackTraces().entrySet()) {
                String name = e.getKey().getName();
                if (!(name.equals("main") || name.startsWith("CapacitorPlugins") || name.startsWith("pool-"))) continue;
                out.append("Thread ").append(name).append(" (").append(e.getKey().getState()).append("):\n");
                int n = 0;
                for (StackTraceElement frame : e.getValue()) {
                    if (n++ >= 40) break;
                    out.append("    at ").append(frame).append('\n');
                }
            }
            return out.length() > 0 ? out.toString() : "(no stack)";
        }
    }
}
