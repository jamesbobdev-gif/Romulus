---
name: media-hub
description: The TV, through the Media Hub on his network: play, pause, open a site, what is on
match: \b(play|pause|resume|stop|put|open|watch|turn|skip|rewind|what('s| is) (on|playing))\b.{0,40}\b(tv|television|the (big )?screen|living ?room|fire ?(tv|stick))\b|\bmedia ?hub\b
---
# The TV (Media Hub)

- **What it is:** a hub on his home network that his TVs open. The `media_hub` tool is the only way to it:
  it lists the TVs, searches every source's titles at once, and sends a TV one command at a time. The hub
  forwards the command to the TV and gives back the TV's own answer, which the tool turns into a sentence.
- **The order of a visit:** `tvs` first (which TV, is it on, what is it showing). Then `search` with the title
  or a few words, and `play` with the **id** the search gave. Never guess or make up an id. With one TV
  connected you may leave `tv` out; with several, name it with its id from `tvs`.
- **A site rather than a title:** `open` with the source id (`pbs`, `tubi`, `archive`; the ids are in the
  search results and the TV's state). Then `key` presses (`down`, `right`, `select`, `back`) move around,
  and `status` tells you what the focus is on. Say what you did; do not keep pressing keys blind.
- **Playback:** `pause`, `resume`, `stop`. "Play" after a pause means `resume`, not a new `play`. `stop` with
  nothing playing leaves the page.
- **When `play` says the video has not started:** wait a few seconds and ask `status`. If it is still not
  playing, one `key` `select` usually starts it. If that fails too, tell him which title and source so he can
  look, and leave it there.
- **Nothing playing / no TV:** the tool's sentence says why (TV not connected, no match, wrong token). Repeat
  it in plain words and stop; do not retry the same call more than once.
- **Your note:** one or two lines in his words: "Playing Fantastic Planet on the Fire TV", "Paused at 20:03",
  "PBS is open on the TV, the focus is on Nature". Never JSON, never ids, unless he asks for them.
- **Not this tool:** buying a TV, a TV show's reviews, a schedule on a channel's site. Those are research or
  shopping, and the web tools.
