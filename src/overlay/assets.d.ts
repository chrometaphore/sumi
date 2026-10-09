/** Figma SVG assets are bundled by esbuild as text (see scripts/build.mjs) and parsed in icons.ts. */
declare module "*.svg" {
  const markup: string;
  export default markup;
}

/** Injected at build time from package.json (see scripts/build.mjs). */
declare const __SUMI_VERSION__: string;
