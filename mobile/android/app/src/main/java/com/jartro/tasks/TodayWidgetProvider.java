package com.jartro.tasks;

/** Home-screen widget: Today. */
public class TodayWidgetProvider extends ListWidgetProvider {
    @Override String mode() { return "today"; }
    @Override String title() { return "Today"; }
    @Override String emptyText() { return "Nothing due today. Nice."; }
    @Override String tabToOpen() { return "list"; }
    @Override int requestBase() { return 300; }
}
