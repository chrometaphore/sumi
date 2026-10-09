---
name: stop
description: End the Sumi review in this session. Stops the Sumi server and its background listener and closes the review tab. Notes are kept, so /sumi:review picks them up again later.
disable-model-invocation: true
allowed-tools: mcp__plugin_sumi_sumi__sumi_status mcp__plugin_sumi_sumi__sumi_stop mcp__Claude_Browser__tabs_context mcp__Claude_Browser__tabs_close
---

# Stop the Sumi review

1. Call `sumi_stop`. This stops the Sumi server. The background `sumi wait` listener notices within a few seconds and exits on its own; do not start it again.
2. Call `tabs_context` and `tabs_close` the browser tab showing the Sumi review address (the `reviewUrl` from this session, on `localhost` or `127.0.0.1`). Skip this if there is no browser pane.
3. Say one line: "Sumi review stopped. Your notes are saved; type /sumi:review to pick it up again."

If `sumi_stop` says nothing is running, say "No Sumi review is running in this session." and stop.

When the listener's exit later wakes you with "not running", say nothing and do not restart it.
