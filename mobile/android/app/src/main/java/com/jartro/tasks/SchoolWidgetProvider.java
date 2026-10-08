package com.jartro.tasks;

/** Home-screen widget: School. */
public class SchoolWidgetProvider extends ListWidgetProvider {
    @Override String mode() { return "school"; }
    @Override String title() { return "School"; }
    @Override String emptyText() { return "No upcoming assignments."; }
    @Override String tabToOpen() { return "school"; }
    @Override int requestBase() { return 500; }
}
