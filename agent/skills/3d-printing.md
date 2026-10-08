---
name: 3d-printing
description: Finding and preparing 3D-printable models (MakerWorld, Printables), filament and print advice
match: \b(3d|print(ed|ing|able)?|printer|stl|3mf|makerworld|printables|thingiverse|filament|pla|petg|tpu|bambu|ams|nozzle)\b
---
# 3D printing

- **His printer:** check his preferences (e.g. a Bambu Lab printer with an AMS). Prefer models
  that suit it.
- **Where to look:** MakerWorld first for Bambu printers, since its pages have "Open in Bambu Studio"
  and print profiles. Then Printables, then Thingiverse. Link the exact model page, never a search
  page. The app adds each page's preview picture itself.
- **Options:** give 6–10 when there are that many, best first. In `desc`, cover what matters for
  printing: fits what he described (sizes in mm, e.g. desk thickness for a clamp), extra hardware
  (screws, magnets, inserts), whether it needs supports, and multi-color (AMS) or single color.
- **Check before recommending:** open at least the top pick's page and confirm the details. MakerWorld
  and Printables block WebFetch with a bot check: open them in Claude's browser instead, which gets
  through. If you didn't open the others, say their details come from the title and search summary.
- **Measurements:** if fit depends on something he has (desk edge, bottle diameter, bike tube), ask
  for the number in mm, or say which range the model fits so he can check.
- **Filament:** PLA for most indoor parts, PETG for outdoor, heat or bike parts, TPU for flexible
  parts or grips. If he asks what to buy, the shopping skill applies.
- **Printing:** the app's card button for these sites is "Print this". It emails him the model to
  print. You never start a print.
- **Designing a custom part:** if nothing fits, say so and describe what to model (dimensions and
  features), or suggest a parametric model on MakerWorld he can adjust.
