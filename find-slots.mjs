#!/usr/bin/env node
/**
 * find-slots: read-only report of every Vue 2 → Vue 3 slot change a project needs. It never writes to a file.
 * Keep it next to migrate-slots.mjs, which decides what counts as a change. Node 18+, no dependencies.
 *
 *   node find-slots.mjs <file-or-dir>...            every slot change, as file:line
 *   node find-slots.mjs --manual <file-or-dir>...   only what has to be changed by hand
 *
 * "auto" rows are what `migrate-slots.mjs --write` would change, "manual" rows need you.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrateSlots, collectFiles, pathReporter } from './migrate-slots.mjs';

function run(argv, log = console.log) {
  const manualOnly = argv.includes('--manual');
  const inputs = argv.filter(arg => !arg.startsWith('--'));
  if (!inputs.length || argv.includes('--help')) {
    log('Usage: node find-slots.mjs [--manual] <file-or-dir>...');
    log('  Lists every slot change needed, as file:line. Nothing is changed.');
    log('  --manual   only show the changes that have to be made by hand');
    return inputs.length ? 0 : 1;
  }

  const missing = inputs.filter(input => !fs.existsSync(input));
  if (missing.length) {
    log(`Path not found: ${missing.join(', ')}`);
    return 1;
  }

  const files = collectFiles(inputs);
  const rel = pathReporter(inputs);
  const byType = new Map();
  let auto = 0;
  let manual = 0;
  let filesWithChanges = 0;

  files.forEach(file => {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/);
    const { fixes, reviews } = migrateSlots(source, { filename: file });

    const rows = reviews.map(r => ({ line: r.line, kind: 'manual', rule: r.rule, detail: r.message, code: lines[r.line - 1].trim() }));
    if (!manualOnly) {
      rows.push(...fixes.map(f => ({ line: f.line, kind: 'auto', rule: f.rule, detail: `${f.from}  →  ${f.to}` })));
    }
    if (!rows.length) return;

    filesWithChanges++;
    log('');
    rows.sort((a, b) => a.line - b.line);
    const name = rel(file).replace(/\\/g, '/');
    const width = Math.max(...rows.map(row => `${name}:${row.line}`.length));
    rows.forEach(row => {
      if (row.kind === 'auto') auto++;
      else manual++;
      byType.set(row.rule, (byType.get(row.rule) || 0) + 1);

      log(`${`${name}:${row.line}`.padEnd(width)}  ${row.kind.padEnd(6)}  ${row.rule.padEnd(22)}  ${row.detail}`);
      if (row.code) log(`${' '.repeat(width + 2)}${' '.repeat(6)}  > ${row.code}`);
    });
  });

  const total = auto + manual;
  if (!total) {
    log(`No ${manualOnly ? 'manual ' : ''}slot changes found in ${files.length} file(s) scanned.`);
    return 0;
  }

  log('');
  log(`${total} slot change(s) in ${filesWithChanges} of ${files.length} file(s) scanned. Nothing was changed.`);
  if (!manualOnly) log(`  auto    ${String(auto).padStart(4)}  node migrate-slots.mjs --write <path> applies these`);
  log(`  manual  ${String(manual).padStart(4)}  you need to make these yourself`);
  log('');
  log('By type:');
  [...byType.entries()].sort((a, b) => b[1] - a[1]).forEach(([rule, count]) => {
    log(`  ${String(count).padStart(4)}  ${rule}`);
  });

  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}

export { run };
