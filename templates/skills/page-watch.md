---
name: page-watch
description: Use when asked to watch a web page (a price, a status page, a list, a changelog) and say when it changes
---
# Watching a page for changes

Keep one snapshot per page in `/work/watch/<short-name>.txt`.

1. Open the page and `read` it. Keep only the part that matters (the price, the list, the status) — not menus,
   timestamps or ads, which change every time.
2. If there is no snapshot yet: save this one and report "watching from now on" with what it says now.
3. Otherwise compare with the snapshot. If nothing that matters changed, say so in one line.
4. If it changed: say exactly what changed (old → new), then save the new snapshot.

On a check-in, report only real changes; if there are none, there is nothing to report.
