package com.divaor.tracker;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a commit to the data repo says, for a notification (the change checks, Changes): who
 * made it and what, from the messages the tracker writes. "Tracker: sync from Laptop (2 added,
 * 1 updated)" (a device's sync), "Tracker: add “Fix login” (via Claude)" (the connector),
 * "Tracker: update notes.md (from Laptop)". Commits that are not the tracker's (Tracker
 * Editor's), and this device's own, say nothing. No Android classes, so it is tested apart.
 */
final class CommitNote {

    final String who;
    final String what;
    final boolean claude;

    private CommitNote(String who, String what, boolean claude) {
        this.who = who;
        this.what = what;
        this.claude = claude;
    }

    private static final Pattern SYNC = Pattern.compile("^sync from (.+?)(?: \\(([^()]*)\\))?$");
    private static final Pattern BY = Pattern.compile("^(.*?)\\s*\\((via|from) ([^()]+)\\)$");

    /**
     * The note for a commit `message`, or null: not the tracker's, made on `device` (this one),
     * or by another device when `devices` (the setting "my other devices") is off.
     */
    static CommitNote of(String message, String device, boolean devices) {
        if (message == null) return null;
        String line = message.split("\n", 2)[0].trim();
        if (!line.startsWith("Tracker:")) return null;
        String rest = line.substring("Tracker:".length()).trim();
        String who;
        String what;
        boolean claude;
        Matcher sync = SYNC.matcher(rest);
        Matcher by = BY.matcher(rest);
        if (sync.matches()) {
            who = sync.group(1);
            what = sync.group(2) == null || sync.group(2).isEmpty() ? "changed your items" : sync.group(2);
            claude = false;
        } else if (by.matches()) {
            what = by.group(1);
            who = by.group(3).trim();
            claude = "via".equals(by.group(2));
        } else {
            return null;
        }
        if (!claude && who.equals(device)) return null;
        if (!claude && !devices) return null;
        return new CommitNote(who, sentence(what), claude);
    }

    // "add “X”" → "Added “X”"; the first word as a past action, the rest as it is.
    static String sentence(String what) {
        String text = what.trim();
        String[][] verbs = {
            { "add ", "Added " },
            { "update ", "Updated " },
            { "delete ", "Deleted " },
            { "new version of ", "New version of " },
            { "plan for ", "Plan for " },
            { "plans for ", "Plans for " },
            { "week review for ", "Week review for " },
        };
        for (String[] v : verbs) {
            if (text.toLowerCase(Locale.ROOT).startsWith(v[0])) return v[1] + text.substring(v[0].length());
        }
        return text.isEmpty() ? text : text.substring(0, 1).toUpperCase(Locale.ROOT) + text.substring(1);
    }
}
