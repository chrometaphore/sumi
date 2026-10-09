/**
 * sumi CLI.
 *   sumi <url> [--port N]            start the review proxy for a running dev server
 *   sumi <file|folder> [--port N]    serve a local .html file or folder (static mode, live reload)
 *   sumi mcp [--port N]              run the stdio MCP server (for Claude Code)
 *   sumi wait [--port N] [--timeout S]  block until notes are sent, print them, exit (for background use)
 *
 * The Node version check lives in the bundle banner (scripts/build.mjs) so it runs before anything else.
 */
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, SessionLockedError, SumiServer, isLoopbackHost, readKeyFile, resolveTarget } from "../server/index";
import { runMcp } from "../mcp/index";

const VERSION = __SUMI_VERSION__;

const USAGE = `sumi — point at your web page, leave notes, hand Claude the exact DOM context.

Usage:
  sumi <url> [--port N] [--allow-remote]
                                  Review a running dev server through a local proxy (default port ${DEFAULT_PORT}).
                                  Only servers on this computer, unless --allow-remote.
  sumi <file|folder> [--port N]   Review a local .html file or folder; Sumi serves it, with live reload
  sumi mcp [--port N]             Run as an MCP server over stdio (for Claude Code)
  sumi wait [--port N] [--timeout S]
                                  Wait until notes are sent to a running Sumi, print them and exit
                                  (default timeout 6600 s; meant to run in the background)
  sumi --version                  Print the version
  sumi --help                     Show this help

Examples:
  sumi http://localhost:3000
  sumi localhost:5173 --port 4900
  sumi 3000
  sumi ./index.html
  sumi ./site
`;

interface Args {
  command: "help" | "version" | "mcp" | "serve" | "wait";
  target?: string;
  port?: number;
  timeout?: number;
  allowRemote?: boolean;
}

function parseArgs(argv: string[]): Args {
  let port: number | undefined;
  let timeout: number | undefined;
  let allowRemote = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help" || a === "help") return { command: "help" };
    if (a === "-v" || a === "--version" || a === "version") return { command: "version" };
    if (a === "--allow-remote") {
      allowRemote = true;
    } else if (a === "--port" || a === "-p") {
      port = parsePort(argv[++i]);
    } else if (a.startsWith("--port=")) {
      port = parsePort(a.slice("--port=".length));
    } else if (a === "--timeout" || a.startsWith("--timeout=")) {
      const v = a === "--timeout" ? argv[++i] : a.slice("--timeout=".length);
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n <= 0) throw new Error(`--timeout needs a number of seconds (got ${v ?? "nothing"}).`);
      timeout = n;
    } else if (a.startsWith("-") && !/^-\d/.test(a)) {
      throw new Error(`Unknown option ${a}. Run sumi --help.`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) return { command: "help" };
  if (positional[0] === "mcp") {
    if (positional.length > 1) throw new Error(`Unexpected argument ${positional[1]}.`);
    if (allowRemote) throw new Error("--allow-remote only applies to `sumi <url>`.");
    return { command: "mcp", port };
  }
  if (positional[0] === "wait") {
    if (positional.length > 1) throw new Error(`Unexpected argument ${positional[1]}.`);
    return { command: "wait", port, timeout };
  }
  if (positional.length > 1) throw new Error(`Unexpected argument ${positional[1]}. Run sumi --help.`);
  return { command: "serve", target: positional[0], port, allowRemote };
}

function parsePort(v: string | undefined): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port needs a number between 1 and 65535 (got ${v ?? "nothing"}).`);
  return n;
}

async function serve(targetArg: string, port: number | undefined, allowRemote: boolean): Promise<void> {
  const target = resolveTarget(targetArg, { cwd: process.cwd(), allowRemote });
  const server = new SumiServer({
    target,
    cwd: process.cwd(),
    port: port ?? DEFAULT_PORT,
    log: (s) => process.stderr.write(s + "\n"),
  });
  let reviewUrl: string;
  try {
    ({ reviewUrl } = await server.start());
  } catch (e) {
    if (e instanceof SessionLockedError) {
      const h = e.holder;
      throw new Error(
        `this page is already being reviewed by another Sumi (process ${h.pid}) at ${h.reviewUrl ?? `http://localhost:${h.port}`}. ` +
          "Open that review, or stop the other Sumi first.",
      );
    }
    throw e;
  }
  if (target.mode === "proxy" && !isLoopbackHost(server.targetUrl.hostname)) {
    process.stderr.write(`sumi: warning: proxying ${server.targetUrl.origin}, which is not on this computer (--allow-remote).\n`);
  }
  const cliPath = fileURLToPath(import.meta.url);
  const out = process.stdout;
  const where =
    server.mode === "static"
      ? [
          `  Serving ${server.root}`,
          `  Live reload: ${server.liveReload === "off" ? "off (file watching unavailable)" : "on"}`,
          ...(server.entry ? [] : [`  (no index.html: the review page lists the folder's .html files)`]),
        ]
      : [`  Target:  ${server.target}`];
  out.write(
    [
      "",
      `  Sumi is running`,
      "",
      `  Review:  ${reviewUrl}`,
      ...where,
      "",
      `  Open the review URL, use Pin (P), Marquee (M) or Brush (B), leave notes, then Send to Claude`,
      `  (or use "Copy for Claude" and paste into claude.ai).`,
      "",
      `  Using Claude Code without the Sumi plugin? Only then, add it as an MCP server:`,
      `    claude mcp add sumi -- node ${cliPath} mcp`,
      "",
      `  Press Ctrl+C to stop.`,
      "",
    ].join("\n") + "\n",
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    await server.stop();
    process.stdout.write("  Sumi stopped.\n");
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "help":
      process.stdout.write(USAGE);
      return;
    case "version":
      process.stdout.write(`sumi ${VERSION}\n`);
      return;
    case "mcp":
      await runMcp({ defaultPort: args.port });
      return;
    case "serve":
      await serve(args.target!, args.port, args.allowRemote === true);
      return;
    case "wait":
      process.exitCode = await waitForNotes(args.port ?? DEFAULT_PORT, args.timeout ?? 6600);
      return;
  }
}

/**
 * Long-poll a running Sumi until notes are sent, then print the agent bundle and exit 0.
 * Meant to run as a background command: the agent is woken when it exits, so it never sits in a
 * blocking wait between rounds. Exit 0 with "No new notes" on timeout, 2 if Sumi isn't running or
 * refuses the request, 1 on other errors.
 */
async function waitForNotes(port: number, timeoutSec: number): Promise<number> {
  const base = `http://127.0.0.1:${port}/__sumi/api`;
  const notRunning = (why: string) => {
    process.stdout.write(`Sumi is not running on port ${port} (${why}). Start a review again with /sumi:review.\n`);
    return 2;
  };
  const key = readKeyFile(port);
  if (!key) return notRunning("no session key in ~/.sumi/run");
  const headers = { "x-sumi-key": key, accept: "application/json" };

  // Quick check first, so a dead port is reported in about a second, not after a long poll.
  try {
    const r = await fetch(`${base}/state`, { headers, signal: AbortSignal.timeout(3000) });
    if (r.status === 403) return notRunning("the server on that port did not accept the session key; it may be a different Sumi or another app");
    if (!r.ok) return notRunning(`HTTP ${r.status}`);
    await r.body?.cancel();
  } catch (e) {
    return notRunning(errorCode(e));
  }

  const deadline = Date.now() + timeoutSec * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    const slice = Math.max(1000, Math.min(100_000, deadline - Date.now()));
    try {
      const r = await fetch(`${base}/wait?timeout=${slice}`, { headers, signal: AbortSignal.timeout(slice + 15_000) });
      if (r.status === 403) return notRunning("the session key changed: that review was restarted");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { annotations?: unknown[] };
      failures = 0;
      if (Array.isArray(body.annotations) && body.annotations.length > 0) {
        const md = await fetch(`${base}/markdown?status=sent&mode=mcp`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!md.ok) {
          process.stdout.write(`Sumi on port ${port} has new notes, but reading them failed (HTTP ${md.status}). Call sumi_list to read them.\n`);
          return 1;
        }
        process.stdout.write(await md.text());
        process.stdout.write(`\n(Sumi on port ${port}: when done, run \`sumi wait --port ${port}\` in the background again.)\n`);
        return 0;
      }
    } catch (e) {
      // A dev restart or a live reload can drop one request; give up only if Sumi is really gone.
      if (++failures >= 3) return notRunning(errorCode(e));
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  process.stdout.write(
    `No new notes yet (timed out after ${formatDuration(timeoutSec)}). Start \`sumi wait --port ${port}\` in the background again to keep listening.\n`,
  );
  return 0;
}

function errorCode(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError") return "no answer in time";
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
}

function formatDuration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} s`;
  const min = Math.round(sec / 60);
  if (min < 120) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

main().catch((err) => {
  process.stderr.write(`sumi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
