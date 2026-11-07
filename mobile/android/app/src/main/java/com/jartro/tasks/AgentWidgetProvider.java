package com.jartro.tasks;

/**
 * Home-screen widget: Agent — what needs your answer, then what Claude and Lupa are on, what's
 * queued and what they just finished. (It took over from the separate Agent status widget.)
 */
public class AgentWidgetProvider extends ListWidgetProvider {
    @Override String mode() { return "agent"; }
    @Override String title() { return "Agent"; }
    @Override String emptyText() { return "Nothing running or waiting on you."; }
    @Override String tabToOpen() { return "agent"; }
    @Override int requestBase() { return 400; }
}
