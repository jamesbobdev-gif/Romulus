package com.jartro.tasks;

/** Home-screen widget: Agent status — what Claude and the mini PC are on, what's queued, what they finished. */
public class AgentStatusWidgetProvider extends ListWidgetProvider {
    @Override String mode() { return "status"; }
    @Override String title() { return "Agent status"; }
    @Override String emptyText() { return "Nothing queued or running."; }
    @Override String tabToOpen() { return "agent"; }
    @Override int requestBase() { return 600; }
}
