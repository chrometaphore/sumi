#!/usr/bin/env node
/**
 * Unit-ish checks of the static-mode HTML tokenizer (src/server/stamp.ts) on tricky inputs.
 *
 *   node scripts/smoke-static.mjs
 *
 * Also imported by scripts/smoke-mcp.mjs. Loads the TypeScript source directly through esbuild
 * (a dev dependency), so it does not need a build.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadStamp() {
  const r = await esbuild.build({
    entryPoints: [join(repo, "src", "server", "stamp.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  return import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
}

/** "line:col" (1-based) of index `i`, counting \r\n, \r and \n as line breaks. */
export function lineCol(src, i) {
  const lines = src.slice(0, i).split(/\r\n|\r|\n/);
  return `${lines.length}:${lines[lines.length - 1].length + 1}`;
}

const STAMP_RE = / data-sumi-src="[^"]*"/g;

export async function tokenizerChecks(ok) {
  const { stampHtml, injectStamped } = await loadStamp();

  const stampsOf = (html) =>
    [...html.matchAll(/<([^\s/<>]+) data-sumi-src="[^"]*?:(\d+:\d+)"/g)].map((m) => `${m[1]}@${m[2]}`);

  /** Each needle locates one stamped tag: the last "<" in the needle, searched in order. */
  const expect = (src, needles) => {
    let from = 0;
    return needles.map((nd) => {
      const at = src.indexOf(nd, from);
      if (at === -1) throw new Error(`needle ${nd} not in input`);
      const lt = at + nd.lastIndexOf("<");
      from = lt + 1;
      const name = /^<([^\s/>]+)/.exec(src.slice(lt))[1];
      return `${name}@${lineCol(src, lt)}`;
    });
  };

  const check = (label, src, needles) => {
    let r;
    try {
      r = stampHtml(src, "f.html");
    } catch (e) {
      ok(false, `tokenizer: ${label}`, `threw ${e}`);
      return null;
    }
    const want = expect(src, needles);
    const got = stampsOf(r.html);
    const unchanged = r.html.replace(STAMP_RE, "") === src;
    ok(
      unchanged && JSON.stringify(got) === JSON.stringify(want),
      `tokenizer: ${label}`,
      `want ${JSON.stringify(want)}\n       got  ${JSON.stringify(got)}${unchanged ? "" : "\n       (text other than stamps changed)"}\n       html ${JSON.stringify(r.html)}`,
    );
    return r;
  };

  let r = check("nested elements", "<div><p>Hi <b>x</b></p></div>", ["<div>", "<p>", "<b>"]);
  ok(r?.html.startsWith('<div data-sumi-src="f.html:1:1"><p data-sumi-src="f.html:1:6">'), "tokenizer: stamp goes right after the tag name");

  r = check("uppercase tags, unquoted attributes", "<DIV CLASS=x><Span id=y>t</Span></DIV>", ["<DIV", "<Span"]);
  ok(r?.html.startsWith('<DIV data-sumi-src="f.html:1:1" CLASS=x>'), "tokenizer: original case and attributes kept");

  check("'>' inside quoted attribute values", `<a title="x>y" data-x='<p>'>t</a><i>`, ["<a ", "<i>"]);
  check("unquoted value ends at '>'", "<a href=x>y</a><b>", ["<a ", "<b>"]);

  r = check("self-closing tags", "<br/><img src=x /><input disabled/>", ["<br", "<img", "<input"]);
  ok(r?.html.startsWith('<br data-sumi-src="f.html:1:1"/>'), "tokenizer: self-closing '/>' kept");

  check(
    "comments, incl. <!--> <!---> and --!>",
    "<!-- <p>a</p> --><p>b</p><!--><i>c</i><!---><u>d</u><!-- x --!><s>e</s>",
    ["<p>b", "<i>", "<u>", "<s>"],
  );
  check("unterminated comment swallows the rest", "<p>a</p><!-- <b>never</b>", ["<p>"]);

  check(
    "script with markup in strings",
    `<script>const s = "<p>"; if (a</b) {} /* </div> */</script><p>after</p>`,
    ["<p>after"],
  );
  check(
    "script double-escaped <!-- <script></script> -->",
    `<script><!-- document.write("<script>x<\\/script>"); document.write("<script></script>") --></script><em>ok</em>`,
    ["<em>"],
  );
  check("script escaped: </script> still ends it", "<script><!-- a </script><b>x</b>", ["<b>"]);
  check("script <!--> opens and closes the escape", "<script><!--></script><b>", ["<b>"]);
  check("script end tag is case-insensitive", "<script>x</SCRIPT ><b>", ["<b>"]);

  check(
    "raw-text elements are not scanned",
    `<style>p > a { content: "<b>" }</style><textarea><i>x</i></textarea><xmp><u></u></xmp>` +
      `<iframe><s></s></iframe><noscript><p></p></noscript><noembed><q></q></noembed>` +
      `<noframes><q></q></noframes><title><b></b></title><div>`,
    ["<textarea>", "<xmp>", "<iframe>", "<noscript>", "<noembed>", "<noframes>", "<div>"],
  );
  check("raw-text end tag needs a delimiter", "<textarea></textareax></TEXTAREA ><b>", ["<textarea>", "<b>"]);
  check("unterminated raw text swallows the rest", "<p>x</p><style>a{}<b>", ["<p>"]);
  check("plaintext swallows the rest", "<plaintext><p>x</p>", ["<plaintext>"]);

  check("CDATA in svg", "<svg><![CDATA[ <rect/> ]]><rect/></svg>", ["<svg>", "]]><rect"]);
  check("doctype and processing instruction", `<!DOCTYPE html><?xml version="1.0"?><p>`, ["<p>"]);
  check("end tag with '>' in an attribute", `<p>a</p foo=">"><i>`, ["<p>", "<i>"]);
  check("lone '<' is text", "a < b <3 <<p>", ["<p>"]);
  check("'</>' and bogus end tags", "</><p></ 3><b>", ["<p>", "<b>"]);
  check("unterminated tag at EOF is not stamped", `<p>ok</p><div class="x`, ["<p>"]);
  check("attribute '=' with missing value", "<input disabled><option selected=>x", ["<input", "<option"]);
  check("custom elements", `<my-el data-a="1"></my-el><x-y/>`, ["<my-el", "<x-y"]);
  check("template content", "<template><li>a</li></template>", ["<template>", "<li>"]);
  check("svg self-closing <script/> is not raw text", "<svg><script/><style/></svg><p>", ["<svg>", "<p>"]);
  check("html <script/> still starts raw text", "<script src=a.js /><p>x</p></script><i>", ["<i>"]);
  check(
    "never stamped: html head meta link base title script style",
    "<html><head><meta charset=utf-8><link rel=x href=y><base href=/><title>t</title><script>1</script><style></style></head><body><p>",
    ["<body>", "<p>"],
  );
  check("CRLF and CR line endings", "\r\n\r\n  <p>\r  <i>", ["<p>", "<i>"]);
  check("multi-line tags", `<div\n  class="a"\n>\n  <span>x</span>\n</div>`, ["<div", "<span>"]);

  r = stampHtml("﻿<p>", "f.html");
  ok(r.html === '﻿<p data-sumi-src="f.html:1:1">', "tokenizer: BOM does not shift columns", JSON.stringify(r.html));

  r = stampHtml(`<p data-sumi-src="x.html:9:9">a</p><i>`, "f.html");
  ok(
    r.html === `<p data-sumi-src="x.html:9:9">a</p><i data-sumi-src="f.html:1:36">`,
    "tokenizer: existing data-sumi-src is left alone",
    r.html,
  );

  r = stampHtml("<p>", `a"b&c.html`);
  ok(r.html === '<p data-sumi-src="a&quot;b&amp;c.html:1:1">', "tokenizer: file path is attribute-escaped", r.html);

  const head = `<head><script>var s = "</head>";</script><!-- </head> --></head><body></body>`;
  const injected = injectStamped(stampHtml(head, "f.html"), "<X>");
  ok(
    injected ===
      `<head><script>var s = "</head>";</script><!-- </head> --><X></head><body data-sumi-src="f.html:${lineCol(head, head.indexOf("<body"))}"></body>`,
    "tokenizer: overlay goes before the real </head>, not one in a script or comment",
    injected,
  );
  ok(
    injectStamped(stampHtml("<body><p>x</p></body>", "f.html"), "<X>").endsWith("<X></body>"),
    "tokenizer: without </head> the overlay goes before </body>",
  );
  ok(injectStamped(stampHtml("<p>x", "f.html"), "<X>").endsWith("x<X>"), "tokenizer: otherwise it is appended");

  // Fuzz: random soup of tricky fragments never throws and never changes anything but stamps.
  const frags = [
    "<div>", "</div>", "<p class=", '"', "'", ">", "<", "</", "<!--", "-->", "--!>", "<!-->", "<script>", "</script>",
    "<style>", "</style>", "<textarea>", "</textarea>", "<![CDATA[", "]]>", "<!DOCTYPE html>", "<?x?>", "\n", "\r\n",
    "text", " ", "=", "/>", "<svg>", "</svg>", "<title>", "<b", "<plaintext>", "<SCRIPT >", "</SCRIPT", "<!",
  ];
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let fuzzBad = "";
  for (let k = 0; k < 2000 && !fuzzBad; k++) {
    let s = "";
    const len = 1 + rand(40);
    for (let j = 0; j < len; j++) s += frags[rand(frags.length)];
    try {
      const out = stampHtml(s, "f.html");
      if (out.html.replace(STAMP_RE, "") !== s) fuzzBad = `changed text for ${JSON.stringify(s)}`;
    } catch (e) {
      fuzzBad = `threw ${e} for ${JSON.stringify(s)}`;
    }
  }
  ok(!fuzzBad, "tokenizer: 2000 random fragment soups never throw and only add stamps", fuzzBad);
}

// Standalone run.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let failures = 0;
  const ok = (cond, label, extra = "") => {
    if (cond) console.log(`  ok   ${label}`);
    else {
      failures++;
      console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
    }
  };
  console.log("sumi static tokenizer checks");
  await tokenizerChecks(ok);
  if (failures) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}
