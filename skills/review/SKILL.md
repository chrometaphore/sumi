---
name: review
description: Start a Sumi visual review of a web page (a local .html file or folder, or a localhost dev server). The person pins elements and types notes in the page; you get exact DOM and source context, make each change, and resolve the pin.
argument-hint: "[file, folder or URL]"
disable-model-invocation: true
allowed-tools: mcp__plugin_sumi_sumi__sumi_start mcp__plugin_sumi_sumi__sumi_list mcp__plugin_sumi_sumi__sumi_resolve mcp__plugin_sumi_sumi__sumi_ask mcp__plugin_sumi_sumi__sumi_status mcp__plugin_sumi_sumi__sumi_stop mcp__Claude_Browser__preview_start mcp__Claude_Browser__tabs_context mcp__Claude_Browser__tabs_close mcp__Claude_Browser__tabs_select Bash(sumi wait:*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait:*) Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" wait:*)
---

# Sumi review

Target requested: $ARGUMENTS

## 1. Start (no questions, no setup)

If the browser pane already shows a Sumi review (a `http://localhost:<port>` or `http://127.0.0.1:<port>` page Sumi opened earlier), call `sumi_status`: if it is running, reuse it (its `reviewUrl` and port) and go to step 2.

Otherwise pick the target in this order and call `sumi_start { target }` right away:
1. The target above, if given (make relative paths absolute).
2. The page in the browser pane: a `file://` URL → its absolute path; a `localhost` URL → that URL (unless it is a Sumi review page).
3. The `.html` file you most recently created or opened in this conversation (absolute path).
4. A running dev server for this project (e.g. http://localhost:5173), or the current folder if it has `.html` files.

Never install Sumi into the project or start a dev server only for Sumi. Ask one short question only if none of these exist.

Open the returned `reviewUrl` with `preview_start` and remember its tab id (the review tab). Call `tabs_context` and `tabs_close` every tab showing the reviewed page as a `file://` URL: the overlay only exists at `reviewUrl`. If there is no browser pane, give the link instead. Say one line: "Click the black drop, press P and click anything to leave a note, then Send to Claude."

## 2. Listen in the background

Start the listener with Bash, `run_in_background: true`, timeout 7200000, using the port from `reviewUrl`:

`sumi wait --port <port>`

If `sumi` is not found, run exactly `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" wait --port <port>` instead, as its own command. Never chain the two with `||` or `&&`. Then end your turn without writing anything else. Do not call `sumi_wait`, and never sleep or poll: you are woken up when the listener exits.

- Output with notes: handle them (below), then start the listener again the same way and end your turn.
- "No new notes" (about 2 hours idle): start the listener again silently and end your turn. After 4 of these in a row with no notes in between, say "Review paused, type /sumi:review to pick it up again." and stop.
- "not running", or the background task was stopped: say that one line and stop. If the person ran `/sumi:stop`, say nothing.

The person ends the review with `/sumi:stop`.

## 3. Each note

- Find the code with **Source** (`file:line`; for local files it is relative to the `Files:` folder), else the component name, visible text, then selector.
- Make exactly the change asked, in the file that owns the element.
- Call `sumi_resolve { ids: [id], reply }` with one plain line on what changed, and in the same message `tabs_select { tabId: <review tab> }`: the app opens an edited HTML file in a new tab, which would hide the review. Use `sumi_ask { id, question }` only if the note has two reasonable readings.

Don't open, reload or screenshot the page to check a change; the review tab reloads by itself (dev server hot reload, or Sumi for local files).

## Style

One line per change at most. Never ask the person to describe or locate an element. Don't narrate tool calls: the pins clearing are the progress report.
