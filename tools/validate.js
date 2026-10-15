#!/usr/bin/env node
/*
 * Runs an adapter against a config folder outside the browser and prints what it
 * extracted. Use it here (or anywhere Node exists) to check adapter changes fast.
 *
 *   node tools/validate.js <config-folder> [adapter.js]
 */
const fs = require('fs');
const path = require('path');

const folder = path.resolve(process.argv[2] || path.join(__dirname, '..', 'sample-infra-config'));
// With no adapter argument every adapter is loaded, in the same order as index.html,
// and the first whose detect() matches is used — exactly what the browser does.
const adapterArg = process.argv.slice(3).find((a) => !a.startsWith('--'));
const adapterPaths = adapterArg ? [path.resolve(adapterArg)] : ['default.js', 'gcloud.js', 'terraform.js'].map((f) => path.join(__dirname, '..', 'adapters', f));
const TEXT_EXT = new Set(['json', 'tf', 'tfvars', 'yaml', 'yml', 'hcl', 'md', 'txt']);

function readTree(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (['.git', 'node_modules', '.terraform'].includes(name)) continue;
    const full = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...readTree(full, rel));
    else {
      const ext = name.split('.').pop().toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const f = { path: rel, name, ext, text };
      if (ext === 'json') { try { f.json = JSON.parse(text); } catch (e) { f.parseError = e.message; } }
      out.push(f);
    }
  }
  return out;
}

global.window = {};
for (const p of adapterPaths) require(p);
const files = readTree(folder);
const adapters = global.window.InfraLensAdapters || [];
const adapter = adapters.find(a => a.detect && a.detect(files)) || adapters[0];
if (!adapter) { console.error('Adapter did not register in window.InfraLensAdapters'); process.exit(1); }
const model = adapter.extract(files);

console.log(`adapter: ${adapter.name}`);
console.log(`files read: ${files.length}  (json parse errors: ${files.filter(f => f.parseError).length})`);
const used = new Set();
for (const [k, v] of Object.entries(model)) {
  if (!Array.isArray(v)) continue;
  v.forEach(e => e.source && used.add(e.source.file));
  console.log(`  ${k.padEnd(20)} ${v.length}`);
}
((model.meta && model.meta.read_files) || []).forEach(f => used.add(f));
const unused = files.filter(f => !used.has(f.path));
if (unused.length) { console.log('\nfiles not used by adapter:'); unused.forEach(f => console.log('  ' + f.path)); }
if (model.errors && model.errors.length) { console.log('\nadapter errors:'); model.errors.forEach(e => console.log(`  ${e.file}: ${e.message}`)); }

// Dangling references = adapter emitted ids that do not resolve.
const ids = new Set();
for (const k of ['projects','networks','folders','service_accounts','wif_pools']) (model[k] || []).forEach(e => ids.add(k + '#' + e.id));
const dangling = [];
(model.subnets || []).forEach(s => ids.has('networks#' + s.network) || dangling.push(`subnet ${s.id} → network ${s.network}`));
(model.firewall_rules || []).forEach(r => ids.has('networks#' + r.network) || dangling.push(`firewall ${r.id} → network ${r.network}`));
(model.projects || []).forEach(p => !p.folder || ids.has('folders#' + p.folder) || dangling.push(`project ${p.id} → folder ${p.folder}`));
(model.wif_providers || []).forEach(p => ids.has('wif_pools#' + p.pool) || dangling.push(`provider ${p.id} → pool ${p.pool}`));
if (dangling.length) { console.log('\ndangling references:'); dangling.forEach(d => console.log('  ' + d)); }

if (process.argv.includes('--dump')) fs.writeFileSync('model.json', JSON.stringify(model, null, 2));
