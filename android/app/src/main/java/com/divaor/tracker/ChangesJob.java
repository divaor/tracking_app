package com.divaor.tracker;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** The periodic change check (Changes), run by Android's JobScheduler with a network. */
public class ChangesJob extends JobService {

    @Override
    public boolean onStartJob(JobParameters params) {
        AppLog.init(this, "app.log");
        new Thread(() -> {
            try {
                int shown = Changes.check(this);
                if (shown > 0) AppLog.i("changes", "Told about " + shown + " change(s)");
            } catch (Exception e) {
                AppLog.i("changes", "The check failed: " + e.getMessage());
            }
            jobFinished(params, false);
        }, "changes").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // Stopped (the network went away): the next period tries again.
        return false;
    }
}
