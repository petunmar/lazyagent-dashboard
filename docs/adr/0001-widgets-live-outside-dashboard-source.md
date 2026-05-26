# Widgets live outside dashboard source

Agent Monitor will stay a small base app and load Widgets from independently packaged folders rather than adding each capability directly under `src/`. We chose explicit backend API and frontend slot extension points so Widgets can add useful behavior without depending on dashboard internals; the trade-off is a slightly heavier runtime boundary, but it keeps the base dashboard simple and lets different installations compose different monitor experiences.
