#!/usr/bin/env node
/*
 * Builds demo.html: index.html with the adapter and a config folder inlined, so the
 * dashboard can be opened with sample data and no folder picker (handy for sharing
 * a preview or for a one-file snapshot of an estate).
 *
 *   node tools/make_demo.js [config-folder] [adapter.js] [out.html]
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(root, 'sample-infra-config'));
const adapterArg = process.argv[3];
// hcl.js is always inlined first; then either the named adapter or all adapters.
const adapterPaths = [path.join(root, 'adapters', 'hcl.js')].concat(adapterArg ? [path.resolve(adapterArg)] : ['default.js', 'gcloud.js', 'terraform.js'].map((f) => path.join(root, 'adapters', f)));
const out = process.argv[4] || path.join(root, 'demo.html');
const TEXT_EXT = new Set(['json', 'tf', 'tfvars', 'yaml', 'yml', 'hcl', 'md']);

function readTree(dir, prefix = '') {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (['.git', 'node_modules', '.terraform'].includes(name)) continue;
    const full = path.join(dir, name); const rel = prefix ? prefix + '/' + name : name;
    if (fs.statSync(full).isDirectory()) files.push(...readTree(full, rel));
    else { const ext = name.split('.').pop().toLowerCase(); if (TEXT_EXT.has(ext)) files.push({ path: rel, name, ext, text: fs.readFileSync(full, 'utf8') }); }
  }
  return files;
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const adapter = adapterPaths.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
const demo = { name: path.basename(folder), files: readTree(folder) };
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
// Function replacement: a string replacement would interpret "$&" / "$'" inside the
// adapter code as back-references and corrupt it.
const result = html.replace(/<script src="adapters\/[^"]+"><\/script>\s*/g, '').replace('<script>\n(function () {',
  () => `<script>${safe(adapter)}</script>\n<script>window.__INFRALENS_DEMO__ = ${safe(JSON.stringify(demo))};</script>\n<script>\n(function () {`);
fs.writeFileSync(out, result);
console.log(`wrote ${out} (${(result.length / 1024).toFixed(0)} KB, ${demo.files.length} files inlined)`);
