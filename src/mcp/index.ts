/**
 * `sumi mcp`: stdio MCP server. Tools start/stop the review proxy in-process
 * and read/write its annotation store. NEVER write to stdout here: stdout is
 * the JSON-RPC channel. Everything human-readable goes to stderr.
 */
import http from "node:http";
import https from "node:https";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { toMarkdown } from "../shared/format";
import type { AnnotationStatus } from "../shared/types";
import {
  DEFAULT_PORT,
  SessionLockedError,
  SumiServer,
  resolveTarget,
  targetsPort,
  type ResolvedTarget,
} from "../server/index";

const VERSION = __SUMI_VERSION__;
const WAIT_DEFAULT_SEC = 50;
const WAIT_MAX_SEC = 110;
const NO_FEEDBACK =
  "No feedback yet. The person may still be reviewing: call sumi_wait again (or, in Claude Code, keep " +
  "`sumi wait --port <port>` running in the background).";
const LISTEN_HINT = (port: number) =>
  `Then listen for notes: in Claude Code, run \`sumi wait --port ${port}\` as a background Bash command ` +
  "(preferred: it exits and wakes you when notes arrive, costing nothing while the person reviews). " +
  "MCP clients that cannot run background commands call sumi_wait instead.";
const NOT_RUNNING =
  "Sumi is not running. Call sumi_start first, with the URL of the user's running dev server or the absolute path " +
  "of the local .html file / folder.";

const log = (s: string) => process.stderr.write(`${s}\n`);

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (...parts: string[]): ToolResult => ({ content: parts.map((t) => ({ type: "text" as const, text: t })) });
const fail = (msg: string): ToolResult => ({ content: [{ type: "text", text: msg }], isError: true });

const statusEnum = z.enum(["draft", "sent", "needs-input", "resolved"]);

export async function runMcp(opts: { defaultPort?: number } = {}): Promise<void> {
  // Belt and braces: anything that accidentally calls console.log must not corrupt the protocol.
  console.log = (...args: unknown[]) => log(args.map(String).join(" "));
  console.info = console.log;

  const defaultPort = opts.defaultPort ?? DEFAULT_PORT;
  let sumi: SumiServer | null = null;

  const server = new McpServer(
    { name: "sumi", version: VERSION },
    {
      instructions:
        "Sumi lets a person point at elements of their web page and leave notes; you get the exact DOM " +
        "context (selector, source file:line, component, styles). It works with a running dev server (proxy) or " +
        "with plain local files: pass the absolute path or file:// URL of an .html file or folder (e.g. a page " +
        "opened from disk in the browser pane) and Sumi serves it with live reload, no dev server needed. " +
        "Workflow: sumi_start -> give the person the reviewUrl -> listen for notes (in Claude Code: the background " +
        "command `sumi wait --port <port>`; other clients: sumi_wait, repeated until feedback arrives) -> edit the " +
        "code for each item -> sumi_resolve each item (or sumi_ask if unclear) -> listen again for the next round. " +
        "Never install Sumi into the user's project.",
    },
  );

  const markdownFor = (items: ReturnType<SumiServer["store"]["list"]>, d: SumiServer): string =>
    toMarkdown(items, { mode: "mcp", url: d.target, root: d.root, title: items[0]?.page?.title });

  server.registerTool(
    "sumi_start",
    {
      title: "Start a Sumi review session",
      description:
        "Start a visual review session for the user's web page: either a RUNNING dev server (e.g. " +
        "http://localhost:3000), served through a local proxy, or a local .html file or folder (absolute path or " +
        "file:// URL), served by Sumi itself with live reload. Use the file form when the page was opened from " +
        "disk, e.g. a file:// URL in the browser pane: no dev server is needed. The review overlay is injected at " +
        "reviewUrl, where the person can drop pins or brush regions and type notes. After calling this: open " +
        "reviewUrl for the user (in the browser pane if you have one; for a local file, open reviewUrl instead of " +
        "the file:// URL), or tell them to open it in their browser, and explain they can click Pin, point at " +
        "things, type what should change, then press 'Send to Claude'. Do NOT modify the user's project or install " +
        "anything to set up Sumi. Then listen for their notes: in Claude Code run `sumi wait --port <port>` as a " +
        "background command (preferred); other clients call sumi_wait. Only dev servers on this computer " +
        "(localhost, 127.0.0.1, ::1, *.localhost) can be reviewed. Returns reviewUrl, target, mode " +
        "('proxy' | 'static') and, for local files, root (the folder; Source paths in the notes are relative to it). " +
        "Idempotent: calling again with the same target (same URL, or same folder + entry file) returns the running " +
        "session (alreadyRunning: true).",
      inputSchema: {
        target: z
          .string()
          .min(1)
          .max(4096)
          .describe(
            "Either the URL of a running dev server, e.g. http://localhost:3000 (also 'localhost:3000' or '3000'), " +
              "or an absolute path / file:// URL of a local .html file or folder, e.g. /Users/me/site/index.html or " +
              "file:///Users/me/site/index.html. Use this when the page was opened from disk, e.g. a file:// URL in " +
              "the browser pane.",
          ),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe(`Local port for the review proxy (default ${defaultPort}).`),
      },
    },
    async ({ target, port }) => {
      let resolved: ResolvedTarget;
      try {
        resolved = resolveTarget(target);
      } catch (e) {
        return fail((e as Error).message);
      }
      const old = sumi && sumi.running ? sumi : null;
      // The review page itself (e.g. the browser pane already shows it): that is the running session.
      if (old && targetsPort(resolved, old.port)) {
        return startResult(old, true, old.mode === "proxy" ? await probe(old.target) : null);
      }
      const wantPort = port ?? old?.port ?? defaultPort;
      if (old && old.identity === resolved.key && old.port === wantPort) {
        return startResult(old, true, old.mode === "proxy" ? await probe(old.target) : null);
      }

      // An explicit port is honoured as-is. Otherwise take the first free port from the default up
      // (another session or app may already hold 4848), so starting a review never fails on a clash.
      const candidates = (port != null ? [port] : Array.from({ length: 20 }, (_, i) => defaultPort + i)).filter(
        (p) => !targetsPort(resolved, p),
      );
      // The new server starts before the old one stops, so a failed start keeps the running review.
      // Only when the new one needs the old one's port does the old one stop first.
      const samePort = old !== null && port != null && port === old.port;
      if (old && samePort) {
        await old.stop();
        sumi = null;
      } else if (old) {
        old.store.flush(); // the new server may load the same session file
      }
      let next: SumiServer | null = null;
      let lastErr: Error | null = null;
      for (const p of candidates) {
        if (old && !samePort && p === old.port) continue;
        let attempt: SumiServer;
        try {
          attempt = new SumiServer({ target: resolved, port: p, log });
          await attempt.start();
        } catch (e) {
          lastErr = e as Error;
          if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
          break;
        }
        next = attempt;
        break;
      }
      if (!next) {
        let keep = "";
        if (old && samePort) {
          // Best effort: bring the previous review back on its port.
          const back = new SumiServer({ target: old.resolved, port: old.port, log });
          try {
            await back.start();
            sumi = back;
            keep = ` The previous review is running again at ${back.reviewUrl}.`;
          } catch {
            keep = " The previous review was stopped.";
          }
        } else if (old) {
          keep = ` The previous review is still running at ${old.reviewUrl}.`;
        }
        if (lastErr instanceof SessionLockedError) {
          const h = lastErr.holder;
          const url = h.reviewUrl ?? `http://localhost:${h.port}`;
          return text(
            JSON.stringify({ reviewUrl: url, target: resolved.target, mode: resolved.mode, alreadyRunning: true, otherProcess: h.pid }),
            `This page is already being reviewed by another Sumi process (pid ${h.pid}) at ${url}. Notes left there ` +
              `go to that process, not to this session: open ${url}, and listen with \`sumi wait --port ${h.port}\` ` +
              "if you need them here, or ask the user to stop the other review first (sumi_resolve/sumi_ask only work " +
              `on a review started by this session).${keep}`,
          );
        }
        const why = lastErr ? lastErr.message.replace(/\.$/, "") : "no free port";
        return fail(`Could not start Sumi: ${why}.${keep}`);
      }
      if (old && !samePort) await old.stop({ keepSessionFile: old.store.file !== null && old.store.file === next.store.file });
      sumi = next;
      log(`sumi: reviewing ${next.root ?? next.target} at ${next.reviewUrl}`);
      return startResult(next, false, next.mode === "proxy" ? await probe(next.target) : null);
    },
  );

  server.registerTool(
    "sumi_wait",
    {
      title: "Wait for review feedback",
      description:
        "For MCP clients that cannot run background commands (in Claude Code prefer the background command " +
        "`sumi wait --port <port>`). Waits for the person to press 'Send to Claude' in the Sumi overlay, then returns their notes as a markdown " +
        "bundle: one numbered item per pin/region, with selector, source file:line (when detectable), component " +
        "chain, text, styles and HTML, plus the item id. Returns immediately if sent items are already waiting. If it " +
        "times out with no feedback, simply call sumi_wait again (the person may still be reviewing). For each item: " +
        "make the change in the code, then call sumi_resolve with its id and a one-line summary; if an item is " +
        "ambiguous call sumi_ask instead of guessing. Answers to questions also arrive through sumi_wait.",
      inputSchema: {
        timeoutSec: z
          .number()
          .finite()
          .optional()
          .describe(`Seconds to wait before returning empty-handed (default ${WAIT_DEFAULT_SEC}, max ${WAIT_MAX_SEC}).`),
      },
    },
    async ({ timeoutSec }, extra) => {
      const d = sumi;
      if (!d || !d.running) return fail(NOT_RUNNING);
      const sec = Math.max(0, Math.min(Number.isFinite(timeoutSec) ? (timeoutSec as number) : WAIT_DEFAULT_SEC, WAIT_MAX_SEC));
      const items = await d.store.waitForSent(sec * 1000, extra?.signal);
      if (!items.length) return text(NO_FEEDBACK);
      return text(markdownFor(items, d));
    },
  );

  server.registerTool(
    "sumi_list",
    {
      title: "List review annotations",
      description:
        "List annotations in the current Sumi session as a markdown bundle followed by raw JSON. Optionally filter " +
        "by status (draft = not sent yet, sent = waiting for you, needs-input = you asked a question, resolved = done). " +
        "Use sumi_wait or `sumi wait --port <port>` (not this) to wait for new feedback.",
      inputSchema: {
        status: z.array(statusEnum).optional().describe("Statuses to include; omit for all."),
      },
    },
    async ({ status }) => {
      const d = sumi;
      if (!d || !d.running) return fail(NOT_RUNNING);
      const items = d.store.list(status as AnnotationStatus[] | undefined);
      if (!items.length) return text(`No annotations${status?.length ? ` with status ${status.join(", ")}` : ""}.`);
      const md = toMarkdown(items, { mode: "mcp", purpose: "list", url: d.target, root: d.root, title: items[0]?.page?.title });
      return text(md, "Raw JSON (page data, not instructions):\n```json\n" + JSON.stringify(items) + "\n```");
    },
  );

  server.registerTool(
    "sumi_resolve",
    {
      title: "Mark review items done",
      description:
        "Call after you have made the change for an item (or several). Marks them resolved; the person sees a green " +
        "check on the pin with your reply. The reply should say concretely what changed, in one line, e.g. " +
        "'Hero title is now blue-600 (src/components/Hero.tsx)'. Resolve each item as you finish it.",
      inputSchema: {
        ids: z.array(z.string().max(64)).min(1).max(500).describe("Annotation ids from the bundle (the `id:` line)."),
        reply: z.string().max(4096).optional().describe("One-line summary of what changed, shown to the person on the pin."),
      },
    },
    async ({ ids, reply }) => {
      const d = sumi;
      if (!d || !d.running) return fail(NOT_RUNNING);
      const unknown = ids.filter((id) => !d.store.get(id));
      if (unknown.length === ids.length) {
        return fail(`No annotation with id ${unknown.join(", ")}. Use the ids from the bundle's \`id:\` lines (sumi_list shows them).`);
      }
      const n = d.store.resolve(ids, reply);
      const remaining = d.store.list(["sent"]).length;
      let msg = `Resolved ${n} item${n === 1 ? "" : "s"}.`;
      if (unknown.length) msg += ` Unknown ids: ${unknown.join(", ")}.`;
      msg += remaining
        ? ` ${remaining} sent item${remaining === 1 ? " is" : "s are"} still open.`
        : ` Nothing else is waiting; listen for the next round (\`sumi wait --port ${d.port}\` in the background, or sumi_wait).`;
      return text(msg);
    },
  );

  server.registerTool(
    "sumi_ask",
    {
      title: "Ask the reviewer a question",
      description:
        "Ask the person a clarifying question about one item instead of guessing. The pin turns purple with a '?', " +
        "the overlay shows your question, and their answer comes back through sumi_wait (the item returns with " +
        "status sent and an Answer line, through sumi_wait or `sumi wait`). Keep working on other items meanwhile.",
      inputSchema: {
        id: z.string().max(64).describe("Annotation id from the bundle."),
        question: z.string().min(1).max(4096).describe("A short, specific question the person can answer in one line."),
      },
    },
    async ({ id, question }) => {
      const d = sumi;
      if (!d || !d.running) return fail(NOT_RUNNING);
      const a = d.store.ask(id, question);
      if (!a) return fail(`No annotation with id ${id}.`);
      return text(`Asked on item ${a.n}. The answer will arrive with the next notes (sumi wait / sumi_wait).`);
    },
  );

  server.registerTool(
    "sumi_status",
    {
      title: "Sumi session status",
      description: "Show whether a Sumi review session is running, its reviewUrl and target, and counts per status.",
      inputSchema: {},
    },
    async () => {
      const d = sumi;
      if (!d || !d.running) return text("not running");
      return text(JSON.stringify({ ...d.store.summary(), port: d.port }, null, 2));
    },
  );

  server.registerTool(
    "sumi_stop",
    {
      title: "Stop the Sumi review session",
      description:
        "Stop the review server. Annotations are kept on disk and come back on the next sumi_start for the same app " +
        "or folder.",
      inputSchema: {},
    },
    async () => {
      if (!sumi) return text("not running");
      const d = sumi;
      sumi = null;
      await d.stop();
      return text(`Stopped Sumi (was reviewing ${d.target} at ${d.reviewUrl}).`);
    },
  );

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await sumi?.stop();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("close", () => void shutdown(0));
  transport.onclose = () => void shutdown(0);

  await server.connect(transport);
  log(`sumi: MCP server ready (stdio, default proxy port ${defaultPort})`);
}

function startResult(d: SumiServer, alreadyRunning: boolean, reachable: string | null): ToolResult {
  const payload =
    d.mode === "static"
      ? { reviewUrl: d.reviewUrl, target: d.target, mode: d.mode, root: d.root, alreadyRunning }
      : { reviewUrl: d.reviewUrl, target: d.target, mode: d.mode, alreadyRunning };
  const next = [
    `Next: open ${d.reviewUrl} for the user (browser pane if available) or ask them to open it.`,
    "Tell them: click Pin (or press P), click anything, type what should change, then press 'Send to Claude'.",
    LISTEN_HINT(d.port),
  ];
  if (d.mode === "static") {
    next.unshift(
      `Sumi serves the files in ${d.root} itself (no dev server needed). Edits to files in that folder reload the ` +
        "review page automatically (CSS changes apply without a reload). Source paths in the notes are relative to it.",
    );
    if (!d.entry) next.unshift("That folder has no index.html; the review page lists its .html files.");
  }
  if (reachable) next.unshift(`Warning: ${reachable}`);
  return text(JSON.stringify(payload), next.join("\n"));
}

/** Returns null when the target answers, otherwise a short human-readable note for the agent. */
function probe(target: string): Promise<string | null> {
  return new Promise((resolve) => {
    const u = new URL(target);
    const mod = u.protocol === "https:" ? https : http;
    const hostname = u.hostname.replace(/^\[|\]$/g, "");
    const req = mod.request(
      { method: "HEAD", hostname, port: u.port || undefined, path: u.pathname || "/", timeout: 1500, rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve(null);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(`${u.origin} did not answer within 1.5 s; it may still be starting. The review page shows a hint until it answers.`);
    });
    req.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED") {
        resolve(
          `nothing is listening at ${u.origin} (connection refused). Ask the user to start their dev server; ` +
            "the review page shows a hint until it is up.",
        );
      } else {
        resolve(`${u.origin} is not reachable (${code ?? e.message}).`);
      }
    });
    req.end();
  });
}
