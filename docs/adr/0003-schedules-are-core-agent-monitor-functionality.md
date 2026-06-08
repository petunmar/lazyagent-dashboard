# Schedules are core Agent Monitor functionality

Schedules will be implemented inside the Agent Monitor base app rather than as a Widget. Although Widgets are the preferred boundary for add-on dashboard capabilities, Schedules are a launch path for normal Agent runs and need first-class access to prompt assembly, run tracking, catch-up behavior, and dashboard navigation; treating them as a Widget would obscure that they are part of Agent Monitor's core control surface.
