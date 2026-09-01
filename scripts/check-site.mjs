import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const siteRoot = path.join(root, "site");
const failures = [];

const required = [
  "index.html",
  "docs.html",
  "app.js",
  "styles.css",
  "robots.txt",
  "sitemap.xml",
  "llms.txt",
  "assets/favicon.svg",
  "assets/runtime-atlas-checkout.png",
  "assets/runtime-atlas-failure.png",
  "assets/runtime-atlas-inspector.png",
  "assets/runtime-atlas-overview.png",
  "assets/runtime-atlas-social.png",
];

for (const file of required) {
  try {
    await access(path.join(siteRoot, file));
  } catch {
    failures.push(`required showcase file is missing: site/${file}`);
  }
}

const htmlFiles = ["index.html", "docs.html"];
const localReference = /(?:href|src)="([^"#][^"]*)"/g;

for (const file of htmlFiles) {
  const absolute = path.join(siteRoot, file);
  const html = await readFile(absolute, "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicates))
    failures.push(`duplicate id in site/${file}: ${id}`);

  for (const match of html.matchAll(localReference)) {
    const reference = match[1];
    if (/^(?:https?:|mailto:|data:|javascript:)/i.test(reference)) continue;
    const clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    if (!clean) continue;
    const target = path.resolve(path.dirname(absolute), clean);
    try {
      await stat(target);
    } catch {
      failures.push(
        `broken local showcase reference: site/${file} -> ${reference}`,
      );
    }
  }

  const title = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim();
  if (!title || title.length < 30 || title.length > 60)
    failures.push(`site/${file} title must contain 30-60 characters`);

  const description = html.match(
    /<meta\s+name="description"\s+content="([^"]+)"/,
  )?.[1];
  if (!description || description.length < 120 || description.length > 160)
    failures.push(`site/${file} description must contain 120-160 characters`);
}

const home = await readFile(path.join(siteRoot, "index.html"), "utf8");
const docs = await readFile(path.join(siteRoot, "docs.html"), "utf8");
const sitemap = await readFile(path.join(siteRoot, "sitemap.xml"), "utf8");
const robots = await readFile(path.join(siteRoot, "robots.txt"), "utf8");

const canonicalHome = "https://othmaneblial.github.io/Runtime-Atlas/";
const canonicalDocs = `${canonicalHome}docs.html`;
if (!home.includes(`rel="canonical"\n      href="${canonicalHome}"`))
  failures.push("showcase home canonical URL is missing or incorrect");
if (!docs.includes(`rel="canonical"\n      href="${canonicalDocs}"`))
  failures.push("showcase docs canonical URL is missing or incorrect");
if (!sitemap.includes(`<loc>${canonicalHome}</loc>`))
  failures.push("showcase home is missing from sitemap.xml");
if (!sitemap.includes(`<loc>${canonicalDocs}</loc>`))
  failures.push("showcase docs are missing from sitemap.xml");
if (!robots.includes(`Sitemap: ${canonicalHome}sitemap.xml`))
  failures.push("robots.txt does not advertise the canonical sitemap");

const social = await readFile(
  path.join(siteRoot, "assets", "runtime-atlas-social.png"),
);
const pngSignature = "89504e470d0a1a0a";
if (social.subarray(0, 8).toString("hex") !== pngSignature) {
  failures.push("social preview is not a PNG");
} else {
  const width = social.readUInt32BE(16);
  const height = social.readUInt32BE(20);
  if (width !== 1280 || height !== 640)
    failures.push(
      `social preview must be 1280x640, received ${width}x${height}`,
    );
}

if (failures.length) {
  process.stderr.write(
    `Showcase check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Showcase verified: ${required.length} required files, ${htmlFiles.length} HTML pages, canonical metadata, local links, sitemap, and social preview.\n`,
);
