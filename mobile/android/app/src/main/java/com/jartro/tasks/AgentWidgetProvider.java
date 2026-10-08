package com.jartro.tasks;

/** Home-screen widget: Claude needs you. */
public class AgentWidgetProvider extends ListWidgetProvider {
    @Override String mode() { return "agent"; }
    @Override String title() { return "Claude needs you"; }
    @Override String emptyText() { return "Nothing waiting on you."; }
    @Override String tabToOpen() { return "agent"; }
    @Override int requestBase() { return 400; }
}
