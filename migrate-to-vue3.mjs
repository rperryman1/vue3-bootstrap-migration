#!/usr/bin/env node
/**
 * migrate-to-vue3: Vue 2 → Vue 3 helper for apps using the vee-validate 2 Vue 3 fork
 * and BootstrapVue's <b-modal> (→ BootstrapVueNext <BModal>). Node 18+, no dependencies.
 * Keep it next to migrate-slots.mjs, whose slot conversion it uses.
 *
 *   node migrate-to-vue3.mjs <file-or-dir>...           dry run: prints what would change
 *   node migrate-to-vue3.mjs --write <file-or-dir>...   applies the "fix" items in place
 *
 * "fix" items are mechanical renames. "review" items are only reported: each one needs a decision.
 * Line numbers always refer to the file as it was before the run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slotTemplateEdits,
  regionsOf,
  collectTags,
  applyEdits,
  kebab,
  short,
  lineIndex,
  collectFiles,
  pathReporter
} from './migrate-slots.mjs';

// ─── BootstrapVue <b-modal> → BootstrapVueNext <BModal> ──────────────────────

const MODAL_PROP_RENAMES = {
  'hide-header-close': 'no-header-close',
  'hide-footer': 'no-footer',
  'hide-header': 'no-header',
  'hide-backdrop': 'no-backdrop',
  'no-enforce-focus': 'no-trap',
  'title-sr-only': 'title-visually-hidden',
  'auto-focus-button': 'focus'
};

const MODAL_PROP_REVIEWS = {
  'static': 'removed: use `teleport-disabled` (modals now teleport to <body> by default)',
  'return-focus': 'removed: delete it, focus returns to the trigger automatically',
  'ignore-enforce-focus-selector': 'removed: delete it, or disable focus trapping with `no-trap`',
  'header-close-content': 'removed: put the content in the `#header-close` slot',
  'title-html': 'removed: use the `#title` slot',
  'ok-title-html': 'removed: use the `#ok` slot',
  'cancel-title-html': 'removed: use the `#cancel` slot',
  'header-tag': 'removed: render your own element in the `#header` slot',
  'footer-tag': 'removed: render your own element in the `#footer` slot',
  'aria-label': 'still works, but `aria-labelledby` is no longer dropped: add `no-header` or keep the label descriptive',
  'no-stacking': 'removed: stacking is automatic'
};

// Whole-file text rules (scripts and template expressions).
const TEXT_FIXES = [
  { pattern: /(['"`])headerclose\1/g, replace: '$1close$1', rule: 'modal trigger' },
  { pattern: /\bBvModalEvent\b/g, replace: 'BvTriggerableEvent', rule: 'modal event type' }
];

const TEXT_REVIEWS = [
  {
    pattern: /\$bvModal\.(show|hide)\s*\(/g,
    rule: m => `$bvModal.${m[1]}`,
    message: m => `use a v-model boolean, a template ref (this.$refs.myModal.${m[1]}()) or \`const { ${m[1]} } = useToggle('modal-id')\``
  },
  {
    pattern: /\$bvModal\.msgBoxOk\s*\(/g,
    rule: () => '$bvModal.msgBoxOk',
    message: () => 'await useModal().create({ ..., okOnly: true }).show()  (needs <BApp> around the app)'
  },
  {
    pattern: /\$bvModal\.msgBoxConfirm\s*\(/g,
    rule: () => '$bvModal.msgBoxConfirm',
    message: () => 'await useModal().create({ ... }).show()  (needs <BApp> around the app)'
  },
  {
    pattern: /\$bvModal\b(?!\.(?:show|hide|msgBoxOk|msgBoxConfirm)\s*\()/g,
    rule: () => '$bvModal',
    message: () => '$bvModal is gone: see useModal / useToggle'
  },
  {
    pattern: /\$root\.\$emit\(\s*['"`]bv::(show|hide|toggle)::modal['"`]/g,
    rule: m => `bv::${m[1]}::modal`,
    message: () => '$root modal events are gone: use a v-model boolean, a template ref or useToggle(\'modal-id\')'
  },
  {
    pattern: /\$root\.\$on\(\s*['"`]bv::modal::(\w+)['"`]/g,
    rule: m => `bv::modal::${m[1]}`,
    message: m => `no $root modal events in BootstrapVueNext: listen on the <BModal> itself (@${m[1]})`
  },
  {
    pattern: /\.vueTarget\b/g,
    rule: () => 'vueTarget',
    message: () => 'not available on BvTriggerableEvent: use a template ref'
  },
  {
    pattern: /\bVue\.use\(\s*VeeValidate\b/g,
    rule: () => 'Vue.use(VeeValidate)',
    message: () => 'Vue 3: createApp(App).use(VeeValidate, options)'
  }
];

const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function splitAttr(name) {
  let prefix = '';
  let rest = name;
  for (const p of ['v-bind:', 'v-on:', 'v-slot:', ':', '@', '#']) {
    if (rest.startsWith(p)) {
      prefix = p;
      rest = rest.slice(p.length);
      break;
    }
  }
  const [base, ...modifiers] = rest.split('.');

  return { prefix, base, modifiers };
}

// ─── template transforms ─────────────────────────────────────────────────────

function templateEdits(src, ctx) {
  const tags = collectTags(src);
  const edits = [];

  // <b-modal> props, v-model
  tags.filter(t => kebab(t.name) === 'b-modal').forEach(tag => {
    tag.attrs.forEach(attr => {
      const { prefix, base, modifiers } = splitAttr(attr.name);
      const key = kebab(base);
      const camelStyle = /[A-Z]/.test(base);
      const isBind = prefix === ':' || prefix === 'v-bind:';
      const isOn = prefix === '@' || prefix === 'v-on:';
      const line = ctx.lineOf(attr.start);
      const mods = modifiers.map(m => `.${m}`).join('');
      let to = null;
      let rule = 'b-modal prop';

      if (!isOn && MODAL_PROP_RENAMES[key]) {
        to = prefix + (camelStyle ? camel(MODAL_PROP_RENAMES[key]) : MODAL_PROP_RENAMES[key]) + mods;
      } else if (isBind && key === 'visible') {
        // `visible` is only the initial state in BootstrapVueNext, v-model is the reactive one.
        to = modifiers.includes('sync') ? 'v-model' : prefix + 'model-value' + mods;
        rule = 'b-modal v-model';
      } else if (isOn && key === 'change') {
        to = `${prefix}update:model-value${mods}`;
        rule = 'b-modal v-model';
      } else if (!isOn && MODAL_PROP_REVIEWS[key]) {
        ctx.review(line, `b-modal ${key}`, MODAL_PROP_REVIEWS[key]);
      }

      if (to) {
        edits.push({ start: attr.start, end: attr.start + attr.name.length, text: to, order: 1 });
        ctx.fix(line, rule, attr.name, to);
      }
    });
  });

  // usages of components still on the Vue 2 v-model contract
  if (ctx.contracts.size) {
    tags.forEach(tag => {
      const info = ctx.contracts.get(kebab(tag.name));
      if (!info || !tag.attrs.some(a => a.name === 'v-model' || a.name.startsWith('v-model.'))) return;
      ctx.review(ctx.lineOf(tag.start), 'v-model contract', `<${tag.name} v-model> needs ${info.where} updated to modelValue / update:modelValue`);
    });
  }

  return edits;
}

// ─── components on the Vue 2 v-model contract ────────────────────────────────

function detectModelContract(source, filename) {
  const declaresValue = [
    /props\s*:\s*\[[^\]]*['"]value['"]/,
    /props\s*:\s*\{[\s\S]*?\bvalue\s*:/,
    /defineProps\(\s*\[[^\]]*['"]value['"]/,
    /defineProps\(\s*\{[\s\S]*?\bvalue\s*:/,
    /defineProps<\s*\{[^}]*\bvalue\??\s*:/
  ].some(re => re.test(source));
  const emitInput = /\bemit\(\s*['"]input['"]/.exec(source);
  const modelOption = /\bmodel\s*:\s*\{\s*(?:prop|event)\s*:/.exec(source);
  if (!(declaresValue && emitInput) && !modelOption) return null;

  const ext = path.extname(filename);
  let base = path.basename(filename, ext);
  if (base === 'index') base = path.basename(path.dirname(filename));
  const names = new Set([kebab(base)]);
  const nameOption = /\bname\s*:\s*['"]([\w-]+)['"]/.exec(source);
  if (nameOption) names.add(kebab(nameOption[1]));

  return {
    names: [...names],
    line: lineIndex(source)((modelOption || emitInput).index),
    reason: modelOption ? 'the `model: { prop, event }` option' : 'a `value` prop + `$emit(\'input\')`'
  };
}

// ─── per file ────────────────────────────────────────────────────────────────

/**
 * Migrates one file's source. Returns the new source plus the fix / review items.
 * `contracts`: Map of kebab-case component name → { where } for components on the old v-model contract.
 */
function migrateSource(source, { filename = 'file.vue', contracts = new Map() } = {}) {
  const ext = path.extname(filename).toLowerCase();
  const lineOf = lineIndex(source);
  const fixes = [];
  const reviews = [];
  const ctx = {
    contracts,
    fix: (line, rule, from, to) => fixes.push({ line, rule, from: short(from), to: short(to) }),
    review: (line, rule, message) => reviews.push({ line, rule, message })
  };

  const { templates } = regionsOf(source, ext, (pos, rule, message) => ctx.review(lineOf(pos), rule, message));
  const edits = [];
  templates.forEach(([start, end]) => {
    const text = source.slice(start, end);
    const local = Object.assign({}, ctx, { lineOf: i => lineOf(start + i) });
    [...slotTemplateEdits(text, local), ...templateEdits(text, local)]
      .forEach(e => edits.push(Object.assign({}, e, { start: e.start + start, end: e.end + start })));
  });

  let output = applyEdits(source, edits, edit => {
    ctx.review(lineOf(edit.start), 'overlap', 'two changes touch the same tag: this one was skipped, review it by hand');
  });

  TEXT_FIXES.forEach(({ pattern, replace, rule }) => {
    for (const m of source.matchAll(pattern)) {
      ctx.fix(lineOf(m.index), rule, m[0], m[0].replace(new RegExp(pattern.source), replace));
    }
    output = output.replace(pattern, replace);
  });

  TEXT_REVIEWS.forEach(({ pattern, rule, message }) => {
    for (const m of source.matchAll(pattern)) ctx.review(lineOf(m.index), rule(m), message(m));
  });

  const own = detectModelContract(source, filename);
  if (own) {
    ctx.review(own.line, 'v-model contract', `component uses ${own.reason}: switch to a \`modelValue\` prop + \`$emit('update:modelValue')\``);
  }

  const byLine = (a, b) => a.line - b.line;

  return { output, fixes: fixes.sort(byLine), reviews: reviews.sort(byLine) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function run(argv, log = console.log) {
  const write = argv.includes('--write');
  const inputs = argv.filter(arg => !arg.startsWith('--'));
  if (!inputs.length || argv.includes('--help')) {
    log('Usage: node migrate-to-vue3.mjs [--write] <file-or-dir>...');
    log('  Without --write nothing is changed: the planned fixes and the review items are printed.');
    return inputs.length ? 0 : 1;
  }

  const missing = inputs.filter(input => !fs.existsSync(input));
  if (missing.length) {
    log(`Path not found: ${missing.join(', ')}`);
    return 1;
  }

  const files = collectFiles(inputs);
  const sources = new Map(files.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const rel = pathReporter(inputs);

  const contracts = new Map();
  files.forEach(file => {
    const info = detectModelContract(sources.get(file), file);
    if (info) info.names.forEach(name => contracts.set(name, { where: `${rel(file)}:${info.line}` }));
  });

  let fixCount = 0;
  let reviewCount = 0;
  let changedFiles = 0;
  files.forEach(file => {
    const source = sources.get(file);
    const { output, fixes, reviews } = migrateSource(source, { filename: file, contracts });
    if (!fixes.length && !reviews.length) return;

    log(`\n${rel(file)}`);
    const items = fixes.map(f => Object.assign({ kind: 'fix' }, f)).concat(reviews.map(r => Object.assign({ kind: 'review' }, r)));
    items.sort((a, b) => a.line - b.line).forEach(item => {
      const detail = item.kind === 'fix' ? `${item.from}  →  ${item.to}` : item.message;
      log(`  ${item.kind.padEnd(7)}${String(item.line).padStart(5)}  ${item.rule.padEnd(22)} ${detail}`);
    });

    fixCount += fixes.length;
    reviewCount += reviews.length;
    if (output !== source) {
      changedFiles++;
      if (write) fs.writeFileSync(file, output);
    }
  });

  log('');
  log(write
    ? `Applied ${fixCount} fix(es) in ${changedFiles} file(s). ${reviewCount} item(s) need a manual review.`
    : `Dry run: ${fixCount} fix(es) in ${changedFiles} file(s) would be applied (rerun with --write). ${reviewCount} item(s) need a manual review.`);

  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}

export { migrateSource, detectModelContract, run, splitAttr, camel };
