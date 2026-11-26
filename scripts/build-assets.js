import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const licenses = await Promise.all([
  readFile(new URL("../LICENSE", import.meta.url), "utf8"),
  readFile(new URL("../node_modules/diff/LICENSE", import.meta.url), "utf8")
]);

await build({
  entryPoints: ["client/app.js"],
  bundle: true,
  format: "esm",
  outfile: "public/assets/app.js",
  banner: { js: `/*!\nWikiDrift\n${licenses[0]}\njsdiff\n${licenses[1]}*/` }
});
