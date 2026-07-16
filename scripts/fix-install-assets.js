"use strict";

// `lms dev --install` bundles the TS source but doesn't know to carry along
// runtime data files that aren't imported by any module — namely the OCR
// language file. Without it in the installed plugin's directory, tesseract.js
// falls back to fetching it from the network on first OCR run.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const projectRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

const installDir = path.join(
    os.homedir(),
    ".lmstudio",
    "extensions",
    "plugins",
    manifest.owner,
    manifest.name,
);

if (!fs.existsSync(installDir)) {
    console.error(`[fix-install-assets] Install directory not found: ${installDir}`);
    console.error(`[fix-install-assets] Run "lms dev --install -y" first.`);
    process.exit(1);
}

const asset = "eng.traineddata";
const src = path.join(projectRoot, asset);
const dest = path.join(installDir, asset);

fs.copyFileSync(src, dest);
console.log(`[fix-install-assets] Copied ${asset} -> ${dest}`);
