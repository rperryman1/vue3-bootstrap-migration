#!/usr/bin/env node
/**
 * bs5-migrate: codemod from BootstrapVue (Bootstrap 4, Vue 2) to BootstrapVueNext (Bootstrap 5, Vue 3).
 *
 *   node bs5-migrate.mjs <project-dir | file> [options]
 *
 *   --write             apply the changes. Without it nothing in the project changes except the report.
 *   --diff              print every changed line
 *   --icons=font|keep   font (default): turn <b-icon> into bootstrap-icons <i class="bi bi-…">
 *                       keep: leave icons alone and list them in the report
 *   --report=<file>     report path (default: <project-dir>/bs5-migration-report.md)
 *   --ignore=a,b        more directory names to skip (node_modules, dist, build, coverage, out and
 *                       dot-directories are always skipped)
 *   --force             write even with uncommitted git changes, or after a previous --write run
 *                       (some edits, such as Sass breakpoint shifts, must only run once)
 *
 * It rewrites .vue, .html, .js/.ts(x) and .css/.scss/.sass files: Bootstrap 4 classes, BootstrapVue
 * props, events and components, Vue 2 slot / .sync / .native syntax, imports and Sass helpers.
 * Whatever it cannot change safely goes into the report with file and line.
 * Node 18+, no dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.1';

// ─── Bootstrap 4 → 5 classes ─────────────────────────────────────────────────

// keep: the Bootstrap 5 replacement is a set of utilities rather than a renamed component, so the
// old class stays next to them as a hook for your own CSS (Bootstrap 5 no longer styles it).
// selector: false: renamed in markup, but your CSS rules for the old class are flagged instead of
// renamed, because the new class is a general utility that is used elsewhere too.
const CLASS_EXACT = {
  'dropright': { to: 'dropend' },
  'dropleft': { to: 'dropstart' },
  'no-gutters': { to: 'g-0' },
  'form-group': { to: 'mb-3', keep: true },
  'form-row': { to: 'row g-2', keep: true },
  'custom-select': { to: 'form-select' },
  'custom-select-sm': { to: 'form-select-sm' },
  'custom-select-lg': { to: 'form-select-lg' },
  'custom-control': { to: 'form-check' },
  'custom-checkbox': { to: '' },
  'custom-radio': { to: '' },
  'custom-switch': { to: 'form-switch' },
  'custom-control-inline': { to: 'form-check-inline' },
  'custom-control-input': { to: 'form-check-input' },
  'custom-control-label': { to: 'form-check-label' },
  'custom-range': { to: 'form-range' },
  'form-control-file': { to: 'form-control', selector: false },
  'form-control-range': { to: 'form-range' },
  'badge-pill': { to: 'rounded-pill', selector: false },
  'sr-only': { to: 'visually-hidden' },
  'sr-only-focusable': { to: 'visually-hidden-focusable' },
  'font-weight-bold': { to: 'fw-bold' },
  'font-weight-bolder': { to: 'fw-bolder' },
  'font-weight-normal': { to: 'fw-normal' },
  'font-weight-light': { to: 'fw-light' },
  'font-weight-lighter': { to: 'fw-lighter' },
  'font-italic': { to: 'fst-italic' },
  'text-monospace': { to: 'font-monospace' },
  'close': { to: 'btn-close', note: '.btn-close draws its own icon: remove the &times; content inside it.' },
  'btn-block': { to: 'w-100', keep: true },
  'rounded-sm': { to: 'rounded-1' },
  'rounded-lg': { to: 'rounded-3' },
  'embed-responsive': { to: 'ratio' },
  'embed-responsive-item': { to: '' },
  'thead-dark': { to: 'table-dark', selector: false },
  'thead-light': { to: 'table-light', selector: false },
  'jumbotron': { to: 'p-5 mb-4 bg-light rounded-3', keep: true },
  'jumbotron-fluid': { to: 'rounded-0', keep: true },
  'media': { to: 'd-flex', keep: true },
  'media-body': { to: 'flex-grow-1', keep: true },
};

// Classes Bootstrap 5 removed without a drop-in replacement, with a hint.
const FILE_INPUT = 'use a plain <input type="file" class="form-control">.';
const CLASS_MANUAL = {
  'form-inline': 'lay the form out with row/col or d-flex utilities.',
  'input-group-prepend': 'move its children directly into .input-group.',
  'input-group-append': 'move its children directly into .input-group.',
  'custom-file': FILE_INPUT,
  'custom-file-input': FILE_INPUT,
  'custom-file-label': FILE_INPUT,
  'card-deck': 'use .row.row-cols-* with .col wrappers, or .card-group.',
  'card-columns': 'use the grid or a masonry layout.',
  'text-hide': 'hide the text another way.',
  'text-justify': 'use text-align: justify in your own CSS.',
  'pre-scrollable': 'use max-height + overflow-y: auto in your own CSS.',
  'btn-group-toggle': 'use .btn-check inputs.',
};

// Utility families: [what an added class is, what already sets the same thing]. An added utility
// is skipped when the element already sets that property, and a later one replaces an earlier one.
const FAMILIES = [
  [/^mb-/, /^(m|my|mb)-/],
  [/^p-/, /^p[xytbse]?-/],
  [/^g-/, /^g[xy]?-/],
  [/^w-/, /^w-/],
  [/^bg-/, /^bg-/],
  [/^rounded-\d/, /^rounded(-\d|$)/],
  [/^d-/, /^d-/],
  [/^flex-grow-/, /^flex-grow-/],
];

const VARIANT_RE = /^badge-(primary|secondary|success|danger|warning|info|light|dark)$/;

// Returns { to, keep?, note? } for a rename, { flag } for manual work, or null.
function mapClassToken(tok) {
  if (Object.hasOwn(CLASS_EXACT, tok)) return CLASS_EXACT[tok];
  if (Object.hasOwn(CLASS_MANUAL, tok)) return { flag: `.${tok} is gone in Bootstrap 5: ${CLASS_MANUAL[tok]}` };
  let m;
  // ml-3 → ms-3, pr-md-0 → pe-md-0, ml-auto → ms-auto. A bare "ml-" is a prefix built on at runtime.
  if ((m = /^([mp])([lr])-((?:sm|md|lg|xl)-)?(n?[0-5]|auto)?$/.exec(tok))) {
    const to = `${m[1]}${m[2] === 'l' ? 's' : 'e'}-${m[3] ?? ''}${m[4] ?? ''}`;
    const note = m[4]?.startsWith('n') ? `.${to}: negative margins need $enable-negative-margins: true in Bootstrap 5.` : undefined;
    return { to, note };
  }
  if ((m = /^(float|text)-((?:sm|md|lg|xl)-)?(left|right)$/.exec(tok))) return { to: `${m[1]}-${m[2] ?? ''}${m[3] === 'left' ? 'start' : 'end'}` };
  if ((m = /^(border|rounded)-(left|right)(-0)?$/.exec(tok))) return { to: `${m[1]}-${m[2] === 'left' ? 'start' : 'end'}${m[3] ?? ''}` };
  if ((m = /^dropdown-menu-((?:sm|md|lg|xl)-)?(left|right)$/.exec(tok))) return { to: `dropdown-menu-${m[1] ?? ''}${m[2] === 'left' ? 'start' : 'end'}` };
  if ((m = VARIANT_RE.exec(tok))) return { to: `text-bg-${m[1]}`, selector: false };
  if ((m = /^embed-responsive-(\d+)by(\d+)$/.exec(tok))) return { to: `ratio-${m[1]}x${m[2]}` };
  if (/^(float|badge|dropdown-menu)-((sm|md|lg|xl)-)?$/.test(tok)) {
    return { flag: `"${tok}…" builds a class at runtime: check its values (left/right → start/end, badge-* → text-bg-*).` };
  }
  return null;
}

const familyOf = cls => FAMILIES.findIndex(([added]) => added.test(cls));

// Maps every class in a space-separated list, keeping the surrounding whitespace.
function mapClassList(str, ctx) {
  const core = str.trim();
  if (!core) return str;
  const lead = str.slice(0, str.indexOf(core));
  const trail = str.slice(lead.length + core.length);
  const parts = core.split(/(\s+)/);
  const plan = parts.filter((_, i) => i % 2 === 0).map(tok => ({ tok, r: mapClassToken(tok) }));
  if (!plan.some(p => p.r)) return str;

  // Classes that stay as written, and the utility families they already set.
  const own = plan.filter(p => !p.r || p.r.flag || p.r.keep).map(p => p.tok);
  const ownFamilies = new Set(FAMILIES.flatMap(([, sets], f) => (own.some(c => sets.test(c)) ? [f] : [])));
  const added = [];
  for (const p of plan) {
    if (!p.r) continue;
    if (p.r.flag) {
      ctx.flag('bs5-css', p.r.flag);
      continue;
    }
    if (p.r.note) ctx.flag('bs5-css', p.r.note);
    p.out = p.r.keep ? [{ cls: p.tok }] : [];
    for (const cls of p.r.to.split(' ').filter(Boolean)) {
      const family = familyOf(cls);
      if (family >= 0 && ownFamilies.has(family)) continue;
      added.filter(e => family >= 0 && e.family === family).forEach(e => (e.dropped = true));
      const entry = { cls, family };
      added.push(entry);
      p.out.push(entry);
    }
  }

  const seen = new Set(own);
  let changed = false;
  let removed = false;
  plan.forEach((p, i) => {
    if (!p.out) return;
    const classes = p.out.filter(e => !e.dropped && (e.cls === p.tok || !seen.has(e.cls))).map(e => e.cls);
    classes.forEach(c => seen.add(c));
    const out = classes.join(' ');
    if (out === p.tok) return;
    ctx.change(`class ${p.tok} → ${out || '(removed)'}`);
    parts[i * 2] = out;
    changed = true;
    if (!out) removed = true;
  });
  if (!changed) return str;
  const body = removed ? parts.filter((p, i) => i % 2 === 0 && p).join(' ') : parts.join('');
  return lead + body + trail;
}

// ─── BootstrapVue → BootstrapVueNext ─────────────────────────────────────────
// BootstrapVueNext is pre-1.0 and has renamed things between minor releases. These tables follow
// its docs at the time of writing: check them against the version you install.

// BootstrapVue's v-model prop and event per component. BootstrapVueNext uses modelValue /
// update:modelValue for all of them.
const BVN_MODEL = {
  'b-modal': ['visible', 'change'],
  'b-sidebar': ['visible', 'change'],
  'b-toast': ['visible', 'change'],
  'b-collapse': ['visible', 'input'],
  'b-alert': ['show', 'input'],
  'b-tooltip': ['show'],
  'b-popover': ['show'],
  'b-tabs': ['value', 'input'],
  'b-form-input': ['value', 'input'],
  'b-form-textarea': ['value', 'input'],
  'b-form-select': ['value', 'input'],
  'b-form-spinbutton': ['value', 'input'],
  'b-form-tags': ['value', 'input'],
  'b-form-rating': ['value', 'input'],
  'b-form-file': ['value', 'input'],
  'b-pagination': ['value', 'input'],
  'b-pagination-nav': ['value', 'input'],
  'b-form-checkbox': ['checked', 'input'],
  'b-form-checkbox-group': ['checked', 'input'],
  'b-form-radio': ['checked', 'input'],
  'b-form-radio-group': ['checked', 'input'],
};
// On these the model event is only ever the v-model event, so it is always renamed. On form
// controls @input is renamed only next to a hand-bound model prop (:value + @input).
const MODEL_EVENT_ALWAYS = new Set(['b-modal', 'b-sidebar', 'b-toast', 'b-collapse', 'b-alert']);

const BVN_PROP_RENAMES = {
  'b-modal': { 'hide-footer': 'no-footer', 'hide-header': 'no-header', 'hide-header-close': 'no-header-close', 'hide-backdrop': 'no-backdrop' },
  'b-dropdown': { right: 'end', dropright: 'dropend', dropleft: 'dropstart' },
  'b-nav-item-dropdown': { right: 'end', dropright: 'dropend', dropleft: 'dropstart' },
};

const BVN_EVENT_RENAMES = {
  'b-form-input': { update: 'update:model-value' },
  'b-form-textarea': { update: 'update:model-value' },
};

const BVN_TAG_RENAMES = {
  'b-sidebar': 'b-offcanvas',
  'b-form-row': 'b-row',
  'b-skeleton': 'b-placeholder',
  'b-skeleton-table': 'b-placeholder-table',
  'b-skeleton-wrapper': 'b-placeholder-wrapper',
};

const NO_DATEPICKER = 'not in BootstrapVueNext: use <b-form-input type="date"> / type="time", or a date-picker library.';
const NO_MEDIA = 'Bootstrap 5 dropped the media object: use d-flex with flex-shrink-0 / flex-grow-1 ms-3.';
const BVN_NOT_PORTED = {
  'b-jumbotron': 'Bootstrap 5 dropped the jumbotron: use <div class="p-5 mb-4 bg-light rounded-3">.',
  'b-media': NO_MEDIA,
  'b-media-body': NO_MEDIA,
  'b-media-aside': NO_MEDIA,
  'b-embed': 'use <div class="ratio ratio-16x9"><iframe …></iframe></div>.',
  'b-aspect': 'use <div class="ratio ratio-…"> (Bootstrap 5 ratio helper).',
  'b-calendar': NO_DATEPICKER,
  'b-form-datepicker': NO_DATEPICKER,
  'b-form-timepicker': NO_DATEPICKER,
  'b-time': NO_DATEPICKER,
  'b-iconstack': 'no equivalent: stack bootstrap-icons with CSS.',
  'b-skeleton-img': 'no direct equivalent: use <b-placeholder> or CSS.',
  'b-skeleton-icon': 'no direct equivalent: use <b-placeholder> or CSS.',
  'b-input-group-addon': 'removed: put <b-input-group-text> directly inside <b-input-group>.',
};

const LINK_TAGS = new Set(['router-link', 'b-link', 'b-button', 'b-nav-item', 'b-dropdown-item', 'b-breadcrumb-item', 'b-list-group-item', 'b-badge', 'b-card-link', 'b-navbar-brand']);
const ICON_EXTRAS = new Set(['animation', 'rotate', 'flip-h', 'flip-v', 'scale', 'shift-h', 'shift-v', 'stacked', 'width', 'height']);

// Script imports from 'bootstrap-vue'.
const IMPORT_RENAMES = { BSidebar: 'BOffcanvas', BFormRow: 'BRow', BSkeleton: 'BPlaceholder', BSkeletonTable: 'BPlaceholderTable', BSkeletonWrapper: 'BPlaceholderWrapper' };
const IMPORT_PLUGIN = /^(BootstrapVue|BootstrapVueIcons|IconsPlugin|\w+Plugin)$/;
const IMPORT_ICON = /^BIcon(?!stack$)\w*$/;
const IMPORT_ADDON = /^BInputGroup(Prepend|Append)$/;
const IMPORT_NOT_PORTED = /^(BJumbotron|BMedia\w*|BEmbed|BAspect|BCalendar|BFormDatepicker|BFormTimepicker|BTime|BIconstack|BSkeletonImg|BSkeletonIcon|BInputGroupAddon|VBVisible|VBHover)$/;

// Usages that need hand work, checked in scripts and in template expressions.
const CODE_FLAGS = [
  [/\bnew Vue\(/g, 'plugin-setup', 'Vue 3 entry: createApp(App).use(createBootstrap()).mount(…) replaces new Vue(…); see the setup snippet.'],
  [/\$bvModal\.msgBox(?:Ok|Confirm)\b/g, 'programmatic', '$bvModal.msgBox*: use the useModal() composable (useModalController in older releases).'],
  [/\$bvModal\.(?:show|hide)\b/g, 'programmatic', '$bvModal.show/hide(id): call show()/hide() on a template ref, or bind v-model on the <b-modal>.'],
  [/\$bvToast\b/g, 'programmatic', '$bvToast: use the useToast() composable (useToastController in older releases).'],
  [/\$root\.\$(?:emit|on|once|off)\(\s*['"`]bv::/g, 'programmatic', 'bv:: root events are gone (Vue 3 has no event bus): use template refs, v-model or the BootstrapVueNext composables.'],
  [/\.\$(?:on|off|once)\((?!\s*['"`]bv::)/g, 'vue3', 'Vue 3 removed $on/$off/$once: use emits/props, or a small emitter such as mitt.'],
  [/\$listeners\b/g, 'vue3', '$listeners was merged into $attrs in Vue 3.'],
  [/\$scopedSlots\b/g, 'vue3', '$scopedSlots is $slots in Vue 3.'],
  [/\bVue\.filter\(/g, 'vue3', 'Vue 3 removed filters: use methods or computed properties.'],
  [/^[ \t]*filters\s*:\s*\{/gm, 'vue3', 'Vue 3 removed the filters option: move these to methods.'],
  [/\bVue\.component\(\s*['"][^'"]*['"]\s*,\s*B[A-Z]\w*/g, 'plugin-setup', 'Global BootstrapVue registration: in Vue 3 use app.component(), or auto-import with unplugin-vue-components + BootstrapVueNextResolver.'],
  [/(['"])bootstrap-vue\/(?!dist\/)[^'"]*\1/g, 'plugin-setup', 'Deep import from bootstrap-vue: there is no matching path in bootstrap-vue-next.'],
];

// ─── String and attribute helpers ────────────────────────────────────────────

const toKebab = s => s.replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase();
const toPascal = s => s.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join('');
const sameCase = (orig, kebab) => (/^[A-Z]/.test(orig) ? toPascal(kebab) : kebab);
const bindPrefix = name => (name.startsWith('v-bind:') ? 'v-bind:' : ':');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isClassProp = prop => prop === 'class' || prop.endsWith('-class');
const isComponentTag = name => name === 'component' || /^[A-Z]/.test(name) || name.includes('-');
// Quote for string literals added to an expression, so the attribute never holds both kinds.
const litQuote = expr => (expr.includes('"') ? '"' : "'");

function findQuoteEnd(code, start) {
  const q = code[start];
  let j = start + 1;
  while (j < code.length && code[j] !== q) j += code[j] === '\\' ? 2 : 1;
  return j;
}

function findTemplateEnd(code, start) {
  let j = start + 1;
  while (j < code.length && code[j] !== '`') {
    if (code[j] === '\\') j += 2;
    else if (code[j] === '$' && code[j + 1] === '{') j = findExprEnd(code, j + 2) + 1;
    else j++;
  }
  return j;
}

function findExprEnd(code, start) {
  let depth = 1;
  let j = start;
  while (j < code.length) {
    const c = code[j];
    if (c === '"' || c === "'") j = findQuoteEnd(code, j) + 1;
    else if (c === '`') j = findTemplateEnd(code, j) + 1;
    else {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j;
      j++;
    }
  }
  return code.length;
}

// Runs fn over the static text of every string and template literal in a JS expression.
function mapStringLiterals(code, fn) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const end = findQuoteEnd(code, i);
      out += c + fn(code.slice(i + 1, end)) + (end < code.length ? c : '');
      i = end + 1;
    } else if (c === '`') {
      let j = i + 1;
      let chunk = j;
      out += '`';
      while (j < code.length && code[j] !== '`') {
        if (code[j] === '\\') {
          j += 2;
        } else if (code[j] === '$' && code[j + 1] === '{') {
          const close = findExprEnd(code, j + 2);
          out += fn(code.slice(chunk, j)) + '${' + mapStringLiterals(code.slice(j + 2, close), fn) + '}';
          j = close + 1;
          chunk = j;
        } else {
          j++;
        }
      }
      out += fn(code.slice(chunk, j)) + (j < code.length ? '`' : '');
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function hasFilter(expr) {
  return /(^|[^|])\|(?!\|)/.test(mapStringLiterals(expr, () => ''));
}

// Class values stored under keys such as class, tdClass, thClass, bodyClass (BTable fields, render
// functions). The value runs to the next , ; or newline outside brackets, so functions are covered too.
const CLASS_KEY_RE = /(?:\b[A-Za-z_$][\w$]*Class(?:es)?|\bclass(?:Name)?|(['"])[\w-]*[cC]lass\1)\s*:\s*/g;

function findValueEnd(code, start) {
  let depth = 0;
  let j = start;
  while (j < code.length) {
    const c = code[j];
    if (c === '"' || c === "'") j = findQuoteEnd(code, j) + 1;
    else if (c === '`') j = findTemplateEnd(code, j) + 1;
    else {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c) && depth-- === 0) return j;
      else if (',;\n'.includes(c) && depth === 0) return j;
      j++;
    }
  }
  return j;
}

// Maps class values in code; onKey(offset) may return text to insert before a key (flag markers).
function mapKeyedClasses(code, ctx, onKey = () => '') {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(CLASS_KEY_RE)) {
    if (m.index < last) continue;
    const start = m.index + m[0].length;
    const end = findValueEnd(code, start);
    const value = code.slice(start, end);
    const mapped = mapStringLiterals(value, s => mapClassList(s, ctx));
    out += code.slice(last, m.index) + onKey() + m[0] + mapped;
    last = end;
  }
  return out + code.slice(last);
}

const ATTR_SRC = String.raw`\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const TAG_RE = new RegExp(String.raw`<([A-Za-z][\w.:-]*)((?:${ATTR_SRC})*)(\s*)(\/?)>`, 'g');
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function parseAttrs(src) {
  const re = /(\s+)([^\s"'<>\/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const attrs = [];
  let m;
  while ((m = re.exec(src))) {
    const quote = m[4] !== undefined ? '"' : m[5] !== undefined ? "'" : '';
    attrs.push({ raw: m[0], ws: m[1], name: m[2], eq: m[3], value: m[4] ?? m[5] ?? m[6], quote });
  }
  return attrs;
}

function serializeAttr(a) {
  if (a.removed) return '';
  if (!a.dirty) return a.raw;
  if (a.value === undefined) return a.ws + a.name;
  const q = a.quote && !a.value.includes(a.quote) ? a.quote : a.value.includes('"') ? "'" : '"';
  return `${a.ws}${a.name}${a.eq ?? '='}${q}${a.value}${q}`;
}

function attrInfo(name) {
  let m = /^(?::|v-bind:)([^.]+)((?:\.[\w-]+)*)$/.exec(name);
  if (m) return { kind: 'bind', prop: toKebab(m[1]), mods: m[2] ? m[2].slice(1).split('.') : [] };
  m = /^(?:@|v-on:)([^.]+)((?:\.[\w-]+)*)$/.exec(name);
  if (m) return { kind: 'on', event: m[1], mods: m[2] ? m[2].slice(1).split('.') : [] };
  if (/^(v-|#)/.test(name)) return { kind: 'dir', mods: [] };
  return { kind: 'static', prop: toKebab(name), mods: [] };
}

function renameEvent(a, to) {
  a.name = a.name.replace(/^(@|v-on:)[^.]*/, (_, p) => p + to);
  a.dirty = true;
}

class Tag {
  constructor(name, attrSrc, trail, self) {
    Object.assign(this, { name, newName: name, attrs: parseAttrs(attrSrc), trail, self, after: '' });
  }

  get live() {
    return this.attrs.filter(a => !a.removed);
  }

  byProp(prop) {
    return this.live.filter(a => {
      const i = attrInfo(a.name);
      return (i.kind === 'static' || i.kind === 'bind') && i.prop === prop;
    });
  }

  byEvent(event) {
    return this.live.filter(a => {
      const i = attrInfo(a.name);
      return i.kind === 'on' && i.event === event;
    });
  }

  has(prop) {
    return this.byProp(prop).length > 0;
  }

  remove(a) {
    a.removed = true;
  }

  add(name, value) {
    this.attrs.push({ ws: ' ', name, value, quote: '', dirty: true });
  }

  addClass(cls, first = false) {
    const a = this.live.find(x => x.name === 'class' && x.value !== undefined);
    if (!a) return this.add('class', cls);
    const have = a.value.split(/\s+/).filter(Boolean);
    const extra = cls.split(' ').filter(c => !have.includes(c));
    a.value = (first ? [...extra, ...have] : [...have, ...extra]).join(' ');
    a.dirty = true;
  }

  addStyle(css) {
    const a = this.live.find(x => x.name === 'style' && x.value !== undefined);
    if (!a) return this.add('style', css);
    a.value = `${a.value.replace(/[\s;]*$/, '')}; ${css}`;
    a.dirty = true;
  }

  get changed() {
    return this.newName !== this.name || this.after !== '' || this.attrs.some(a => a.dirty || a.removed);
  }

  toString() {
    return `<${this.newName}${this.attrs.map(serializeAttr).join('')}${this.trail}${this.self ? '/' : ''}>${this.after}`;
  }
}

function findElementEnd(src, from, name) {
  const re = new RegExp(`<(/?)${escapeRe(name)}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>`, 'g');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) {
      if (--depth === 0) return { start: m.index, end: m.index + m[0].length };
    } else if (!m[0].endsWith('/>')) {
      depth++;
    }
  }
  return null;
}

const NESTING_SRC = String.raw`<!--[\s\S]*?-->|<\/([A-Za-z][\w.:-]*)\s*>|${TAG_RE.source}`;

// Names of the elements still open at src[index], outermost first.
function openElements(src, index) {
  const re = new RegExp(NESTING_SRC, 'g');
  const stack = [];
  let m;
  while ((m = re.exec(src)) && m.index < index) {
    if (m[1]) {
      const i = stack.lastIndexOf(m[1]);
      if (i >= 0) stack.length = i;
    } else if (m[2] && !m[5] && !VOID_TAGS.has(m[2].toLowerCase())) {
      stack.push(m[2]);
    }
  }
  return stack;
}

// Vue 3 takes <template #name> only as a direct child of a component: says why a slot can't go where
// it is, or returns null.
function slotProblem(open, name) {
  const [parent, grand] = [open.at(-1), open.at(-2)];
  if (parent && isComponentTag(parent)) return null;
  if (parent === 'template' && grand && isComponentTag(grand)) {
    return `slot="${name}" sits inside a <template> wrapper: Vue 3 needs it directly under <${grand}>; write <template #${name}> there by hand, moving the wrapper's v-if / v-for onto it.`;
  }
  return `slot="${name}" is not on a direct child of a component, so it never filled a slot: delete the attribute, or move the element directly under the component inside <template #${name}>.`;
}

// Removes src[start, end); when that leaves an empty line, removes the line too.
function cutRange(src, start, end) {
  const lineStart = src.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = src.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = src.length;
  if (/^[ \t]*$/.test(src.slice(lineStart, start)) && /^[ \t\r]*$/.test(src.slice(end, lineEnd))) {
    return src.slice(0, lineStart) + src.slice(lineEnd + 1);
  }
  return src.slice(0, start) + src.slice(end);
}

// ─── Per-file context: changes and flags ─────────────────────────────────────
// A flag is recorded where it is found by inserting a private-use marker into the text. The markers
// ride along through later edits, so line numbers are read from the final text.

const S_OPEN = '';
const S_CLOSE = '';
const SENTINEL_RE = /(\d+)/g;

class FileCtx {
  constructor(rel, opts) {
    this.rel = rel;
    this.opts = opts;
    this.flags = [];
    this.changes = new Map();
  }

  flag(rule, msg) {
    this.flags.push({ rule, msg });
    return `${S_OPEN}${this.flags.length - 1}${S_CLOSE}`;
  }

  change(label) {
    this.changes.set(label, (this.changes.get(label) ?? 0) + 1);
  }

  // For edits made inside a tag or expression: flags are collected and placed in front of it.
  scoped() {
    const pending = [];
    return { pending, opts: this.opts, flag: (rule, msg) => pending.push(this.flag(rule, msg)), change: label => this.change(label) };
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

function transformTemplate(src, fc) {
  if (!src.includes('<')) return src;
  src = unwrapInputGroupAddons(src, fc);
  src = wrapSlotElements(src, fc);
  src = renameClosingTags(src, fc.opts);
  src = src.replace(TAG_RE, (all, name, attrSrc, trail, self, offset, whole) =>
    processTag(all, name, attrSrc, trail, self === '/', fc, () => openElements(whole, offset)));
  return src.replace(/\{\{([\s\S]*?)\}\}/g, (all, expr) =>
    (hasFilter(expr) ? fc.flag('vue3', 'Vue 3 removed filters ({{ value | filter }}): call a method instead.') : '') + all);
}

// <b-input-group-prepend> / -append: Bootstrap 5 input groups take their addons as direct children.
function unwrapInputGroupAddons(src, fc) {
  const re = new RegExp(`<(b-input-group-(?:prepend|append)|BInputGroup(?:Prepend|Append))(?=[\\s/>])((?:${ATTR_SRC})*)(\\s*)(\\/?)>`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const [open, name, attrSrc, trail, self] = m;
    const start = m.index;
    const t = new Tag(name, attrSrc, trail, self === '/');
    const isText = t.live.filter(a => toKebab(a.name) === 'is-text');
    const rest = t.live.filter(a => toKebab(a.name) !== 'is-text');
    if (self) {
      src = cutRange(src, start, start + open.length);
      re.lastIndex = start;
      continue;
    }
    const close = findElementEnd(src, start + open.length, name);
    const structural = rest.every(a => /^(v-if|v-else-if|v-else|v-for|:key|key)$/.test(a.name));
    if (!close || (!isText.length && !structural)) {
      const why = close ? `${rest.map(a => a.name).join(', ')} would be lost` : 'no closing tag found';
      const s = fc.flag('bs5-css', `<${name}>: Bootstrap 5 has no prepend/append wrapper; move its children into the input group by hand (${why}).`);
      src = src.slice(0, start) + s + src.slice(start);
      re.lastIndex = start + s.length + open.length;
      continue;
    }
    if (isText.length) {
      isText.forEach(a => t.remove(a));
      t.newName = sameCase(name, 'b-input-group-text');
    } else if (rest.length) {
      t.newName = 'template';
    }
    if (t.newName !== name) {
      const inner = src.slice(start + open.length, close.start);
      src = src.slice(0, start) + t.toString() + inner + `</${t.newName}>` + src.slice(close.end);
      re.lastIndex = start + 1;
    } else {
      // Dedent the children to where the wrapper was, then drop the wrapper's tags.
      const inner = src.slice(start + open.length, close.start);
      const indent = /[ \t]*$/.exec(src.slice(src.lastIndexOf('\n', start - 1) + 1, start))[0].length;
      const lines = inner.split('\n');
      const depths = lines.slice(1).filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)[0].length);
      const extra = depths.length ? Math.min(...depths) - indent : 0;
      const dedented = extra > 0 ? lines.map((l, i) => (i ? l.slice(Math.min(extra, /^[ \t]*/.exec(l)[0].length)) : l)).join('\n') : inner;
      const closeStart = start + open.length + dedented.length;
      src = src.slice(0, start + open.length) + dedented + src.slice(close.start);
      src = cutRange(src, closeStart, closeStart + (close.end - close.start));
      src = cutRange(src, start, start + open.length);
      re.lastIndex = start;
    }
    fc.change(isText.length ? '<b-input-group-prepend/append is-text> → <b-input-group-text>' : '<b-input-group-prepend/append> unwrapped');
  }
  return src;
}

// <div slot="footer" slot-scope="x" v-if="y"> → <template v-if="y" #footer="x"><div>…</div></template>.
// v-if / v-else-if / v-else move to the <template>, so the slot itself stays conditional as in Vue 2.
function wrapSlotElements(src, fc) {
  const re = new RegExp(TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(src))) {
    const [all, name, attrSrc, trail, self] = m;
    if (name === 'template' || !/\s(:|v-bind:)?slot\s*=/.test(attrSrc)) continue;
    if (src.lastIndexOf('<!--', m.index) > src.lastIndexOf('-->', m.index)) continue;
    const t = new Tag(name, attrSrc, trail, self === '/');
    const slot = t.live.find(a => a.name === 'slot' && a.value !== undefined);
    const scope = t.live.find(a => a.name === 'slot-scope');
    const bound = t.live.find(a => /^(:|v-bind:)slot$/.test(a.name));
    const cond = t.live.filter(a => /^v-(if|else-if|else)$/.test(a.name));
    let problem = null;
    if (bound) problem = 'dynamic :slot: use <template #[name]> in Vue 3.';
    else if (!slot) continue;
    else if (!/^[\w$-]+(\([^.\s()]*\))?$/.test(slot.value)) problem = `slot="${slot.value}": wrap it in <template #…> by hand (names with "." need dynamic slot syntax).`;
    else if (cond.length && t.live.some(a => a.name === 'v-for')) problem = `slot="${slot.value}" with v-for and v-if / v-else: wrap it in <template #${slot.value}> by hand.`;
    else problem = slotProblem(openElements(src, m.index), slot.value);
    const close = !problem && !self && !VOID_TAGS.has(name.toLowerCase()) ? findElementEnd(src, m.index + all.length, name) : null;
    if (!problem && !self && !VOID_TAGS.has(name.toLowerCase()) && !close) problem = `slot="${slot.value}": no closing tag found; wrap it in <template #${slot.value}> by hand.`;
    if (problem) {
      const s = fc.flag('slots', problem);
      src = src.slice(0, m.index) + s + src.slice(m.index);
      re.lastIndex = m.index + s.length + all.length;
      continue;
    }
    t.remove(slot);
    if (scope) t.remove(scope);
    cond.forEach(a => t.remove(a));
    const q = scope?.value.includes('"') ? "'" : '"';
    const open = `<template${cond.map(a => ` ${a.raw.trim()}`).join('')} #${slot.value}${scope ? `=${q}${scope.value}${q}` : ''}>`;
    const tag = t.toString();
    if (close) {
      src = src.slice(0, m.index) + open + tag + src.slice(m.index + all.length, close.end) + '</template>' + src.slice(close.end);
    } else {
      src = src.slice(0, m.index) + open + tag + '</template>' + src.slice(m.index + all.length);
    }
    re.lastIndex = m.index + open.length + tag.length;
    fc.change('slot="…" on an element → <template #…>');
  }
  return src;
}

function renameClosingTags(src, opts) {
  for (const [from, to] of Object.entries(BVN_TAG_RENAMES)) {
    src = src.replace(new RegExp(`</(${from}|${toPascal(from)})(\\s*)>`, 'g'), (_, n, ws) => `</${sameCase(n, to)}${ws}>`);
  }
  if (opts.icons === 'font') src = src.replace(/<\/(b-icon(?:-[\w-]+)?|BIcon(?!stack\b)\w*)\s*>/g, '</i>');
  return src;
}

function processTag(all, name, attrSrc, trail, self, fc, ancestors) {
  const t = new Tag(name, attrSrc, trail, self);
  t.ancestors = ancestors;
  const ctx = fc.scoped();
  const kebab = toKebab(name);
  componentRules(t, kebab, ctx);
  genericRules(t, ctx);
  return ctx.pending.join('') + (t.changed ? t.toString() : all);
}

function genericRules(t, ctx) {
  const isComponent = isComponentTag(t.name);
  for (const a of t.live) {
    const info = attrInfo(a.name);
    if (info.kind === 'on' && info.mods.includes('native')) {
      a.name = a.name.replace('.native', '');
      a.dirty = true;
      ctx.change('@event.native → @event');
    }
    if (info.kind === 'bind' && info.mods.includes('sync')) {
      const rest = info.mods.filter(x => x !== 'sync');
      a.name = `v-model:${info.prop}${rest.length ? '.' + rest.join('.') : ''}`;
      a.dirty = true;
      ctx.change(':prop.sync → v-model:prop');
    }
    if (a.value === undefined) continue;
    if (info.kind === 'static' && isClassProp(info.prop)) {
      const v = mapClassList(a.value, ctx);
      if (v !== a.value) Object.assign(a, { value: v, dirty: true });
    } else if (info.kind !== 'static') {
      const v = info.kind === 'bind' && isClassProp(info.prop)
        ? mapStringLiterals(a.value, s => mapClassList(s, ctx))
        : mapKeyedClasses(a.value, ctx);
      if (v !== a.value) Object.assign(a, { value: v, dirty: true });
      if (info.kind === 'bind' && hasFilter(a.value)) ctx.flag('vue3', `Vue 3 removed filters (${a.name}="… | filter"): call a method instead.`);
      for (const [re, rule, msg] of CODE_FLAGS) {
        re.lastIndex = 0;
        if (re.test(a.value)) ctx.flag(rule, msg);
      }
    }
  }
  for (const a of t.live) {
    const m = /^v-b-(visible|hover)\b/.exec(a.name);
    if (m) ctx.flag('not-ported', `v-b-${m[1]}: not in BootstrapVueNext; use VueUse's ${m[1] === 'visible' ? 'useElementVisibility' : 'useElementHover'}.`);
  }
  if (t.name === 'template') {
    convertTemplateSlot(t, ctx);
    // BModal's slots lost their modal- prefix. Other components keep their slot names.
    for (const a of t.live) {
      const m = /^(#|v-slot:)modal-(header-close|header|title|footer|ok|cancel)$/.exec(a.name);
      if (!m || toKebab(t.ancestors().at(-1) ?? '') !== 'b-modal') continue;
      a.name = m[1] + m[2];
      a.dirty = true;
      ctx.change('<b-modal> slot modal-* → *');
    }
  }
  // Bootstrap's own JavaScript API (data-toggle etc.) on plain elements is data-bs-* in Bootstrap 5.
  if (!isComponent && t.live.some(a => /^(:|v-bind:)?data-(toggle|dismiss|ride|spy|slide|slide-to)$/.test(a.name))) {
    for (const a of t.live) {
      const m = /^(:|v-bind:)?data-(toggle|target|dismiss|ride|slide|slide-to|parent|spy|offset|placement|content|trigger|container|backdrop|keyboard|interval|boundary|display|reference|html|delay|animation|focus)$/.exec(a.name);
      if (!m) continue;
      a.name = `${m[1] ?? ''}data-bs-${m[2]}`;
      a.dirty = true;
      ctx.change('data-* → data-bs-*');
    }
  }
}

function convertTemplateSlot(t, ctx) {
  const slot = t.live.find(a => a.name === 'slot' && a.value !== undefined);
  const scope = t.live.find(a => (a.name === 'slot-scope' || a.name === 'scope') && a.value !== undefined);
  if (t.live.some(a => /^(:|v-bind:)slot$/.test(a.name))) {
    ctx.flag('slots', 'dynamic :slot: use <template #[name]> in Vue 3.');
    return;
  }
  if (!slot && !scope) return;
  const name = slot ? slot.value : 'default';
  if (!/^[\w$-]+(\([^.\s()]*\))?$/.test(name)) {
    ctx.flag('slots', `slot="${name}": convert to v-slot by hand (names with "." need dynamic slot syntax).`);
    return;
  }
  const problem = slotProblem(t.ancestors(), name);
  if (problem) {
    ctx.flag('slots', problem);
    return;
  }
  const target = slot ?? scope;
  Object.assign(target, { name: `#${name}`, value: scope?.value, quote: scope?.quote ?? '', eq: scope?.eq, dirty: true });
  if (slot && scope) t.remove(scope);
  ctx.change('slot / slot-scope → #slot');
}

function componentRules(t, kebab, ctx) {
  if (kebab === 'b-icon' || kebab.startsWith('b-icon-')) return convertIcon(t, kebab, ctx);
  if (BVN_NOT_PORTED[kebab]) ctx.flag('not-ported', `<${t.name}>: ${BVN_NOT_PORTED[kebab]}`);
  if (BVN_MODEL[kebab]) convertModel(t, kebab, ctx);
  for (const [from, to] of Object.entries(BVN_PROP_RENAMES[kebab] ?? {})) renameProp(t, from, to, kebab, ctx);
  for (const [from, to] of Object.entries(BVN_EVENT_RENAMES[kebab] ?? {})) {
    for (const a of t.byEvent(from)) {
      renameEvent(a, to);
      ctx.change(`<${kebab}> @${from} → @${to}`);
    }
  }
  if (BVN_TAG_RENAMES[kebab]) {
    t.newName = sameCase(t.name, BVN_TAG_RENAMES[kebab]);
    ctx.change(`<${kebab}> → <${BVN_TAG_RENAMES[kebab]}>`);
  }
  if (LINK_TAGS.has(kebab)) {
    for (const a of [...t.byProp('exact'), ...t.byProp('exact-path')]) {
      ctx.flag('router', `${a.name} on <${t.name}>: Vue Router 4 removed exact matching; use exact-active-class or compare route.path.`);
    }
  }
  switch (kebab) {
    case 'b-button':
      propToClass(t, 'block', 'w-100', kebab, ctx);
      break;
    case 'b-row':
      propToClass(t, 'no-gutters', 'g-0', kebab, ctx);
      break;
    case 'b-form-row':
      t.addClass('g-2');
      break;
    case 'b-img':
    case 'b-img-lazy':
      propToClass(t, 'left', 'float-start', kebab, ctx);
      propToClass(t, 'right', 'float-end', kebab, ctx);
      if (kebab === 'b-img-lazy') ctx.flag('verify-props', `<${t.name}>: check your BootstrapVueNext version has it; otherwise use <b-img loading="lazy">.`);
      break;
    case 'b-form-input':
    case 'b-form-textarea':
      inputModifiers(t, kebab, ctx);
      break;
    case 'b-sidebar':
      sidebarPlacement(t, ctx);
      ctx.flag('verify-props', '<b-sidebar> is now <b-offcanvas>: check width, shadow, backdrop, bg-variant, sidebar-class and the default slot.');
      break;
    case 'b-skeleton':
    case 'b-skeleton-table':
    case 'b-skeleton-wrapper':
      ctx.flag('verify-props', `<${t.name}> is now <${t.newName}>: check its props (animation, width, rows/columns).`);
      break;
    case 'b-table':
    case 'b-table-lite':
      tableFlags(t, ctx);
      break;
    case 'b-tabs':
      if (t.live.some(a => /^v-model(\.|$)|model-value$/.test(a.name))) {
        ctx.flag('verify-props', '<b-tabs> v-model: BootstrapVueNext binds the active tab differently (tab id vs. index, v-model:index); check yours.');
      }
      break;
    case 'b-alert':
      for (const ev of ['dismissed', 'dismiss-count-down']) {
        if (t.byEvent(ev).length) ctx.flag('verify-props', `<b-alert @${ev}>: check the event name and the countdown API in BootstrapVueNext.`);
      }
      break;
    case 'b-collapse':
      if (t.has('accordion')) ctx.flag('verify-props', '<b-collapse accordion>: use <b-accordion> / <b-accordion-item>.');
      break;
    case 'b-tooltip':
    case 'b-popover':
      if (t.has('triggers')) ctx.flag('verify-props', `<${t.name} triggers>: BootstrapVueNext uses different trigger props (e.g. click, manual); check yours.`);
      break;
    case 'b-form':
      if (t.has('inline')) ctx.flag('bs5-css', '<b-form inline>: Bootstrap 5 removed inline forms; use the grid or flex utilities.');
      break;
    case 'b-form-file':
      ctx.flag('verify-props', '<b-form-file>: browse-text, drop-placeholder and file-name-formatter changed; check its props.');
      break;
    case 'b-card-group':
      if (t.has('deck') || t.has('columns')) ctx.flag('bs5-css', '<b-card-group deck/columns>: Bootstrap 5 removed card decks and columns; use the grid (row-cols-*).');
      break;
    case 'b-modal':
      if (t.has('static')) ctx.flag('verify-props', '<b-modal static>: BootstrapVueNext teleports modals; check teleport-disabled / teleport-to.');
      break;
  }
}

function convertModel(t, kebab, ctx) {
  const [prop, event] = BVN_MODEL[kebab];
  let manual = false;
  for (const a of t.byProp(prop)) {
    const info = attrInfo(a.name);
    if (info.kind === 'static') {
      if (a.value === undefined) Object.assign(a, { name: ':model-value', value: 'true' });
      else a.name = 'model-value';
    } else if (info.mods.includes('sync')) {
      a.name = 'v-model';
    } else {
      a.name = bindPrefix(a.name) + 'model-value';
      manual = true;
    }
    a.dirty = true;
    ctx.change(`<${kebab}> ${prop} → model-value`);
  }
  if (event && (manual || MODEL_EVENT_ALWAYS.has(kebab))) {
    for (const a of t.byEvent(event)) {
      renameEvent(a, 'update:model-value');
      ctx.change(`<${kebab}> @${event} → @update:model-value`);
    }
  }
}

function renameProp(t, from, to, kebab, ctx) {
  for (const a of t.byProp(from)) {
    const info = attrInfo(a.name);
    a.name = (info.kind === 'bind' ? bindPrefix(a.name) : '') + to + (info.mods.length ? '.' + info.mods.join('.') : '');
    a.dirty = true;
    ctx.change(`<${kebab}> ${from} → ${to}`);
  }
}

function propToClass(t, prop, cls, kebab, ctx) {
  for (const a of t.byProp(prop)) {
    if (attrInfo(a.name).kind === 'static' && (a.value === undefined || a.value === '' || a.value === 'true')) {
      t.remove(a);
      t.addClass(cls);
      ctx.change(`<${kebab}> ${prop} → class="${cls}"`);
    } else {
      ctx.flag('verify-props', `<${t.name}> ${a.name}: bound value; add class "${cls}" with :class instead.`);
    }
  }
}

function inputModifiers(t, kebab, ctx) {
  const mods = [];
  for (const p of ['trim', 'number', 'lazy']) {
    for (const a of t.byProp(p)) {
      if (attrInfo(a.name).kind === 'static' && a.value === undefined) mods.push([p, a]);
      else ctx.flag('verify-props', `<${t.name}> ${a.name}: use the v-model.${p} modifier instead.`);
    }
  }
  if (!mods.length) return;
  const vm = t.live.find(a => /^v-model(\.|$)/.test(a.name));
  if (!vm) {
    ctx.flag('verify-props', `<${t.name}> ${mods.map(([p]) => p).join('/')}: BootstrapVueNext uses v-model modifiers (v-model.trim etc.).`);
    return;
  }
  vm.name = ['v-model', ...new Set([...vm.name.split('.').slice(1), ...mods.map(([p]) => p)])].join('.');
  vm.dirty = true;
  mods.forEach(([, a]) => t.remove(a));
  ctx.change(`<${kebab}> trim/number/lazy → v-model modifiers`);
}

function sidebarPlacement(t, ctx) {
  for (const a of t.byProp('right')) {
    if (attrInfo(a.name).kind === 'static') {
      Object.assign(a, { name: 'placement', value: 'end', eq: '=', dirty: true });
    } else {
      const q = litQuote(a.value);
      Object.assign(a, { name: bindPrefix(a.name) + 'placement', value: `(${a.value}) ? ${q}end${q} : ${q}start${q}`, dirty: true });
    }
    ctx.change('<b-sidebar> right → placement="end"');
  }
}

function tableFlags(t, ctx) {
  if (t.has('sort-by') || t.has('sort-desc')) {
    ctx.flag('table', '<b-table> sorting: BootstrapVueNext binds v-model:sort-by as an array of { key, order: "asc" | "desc" }; sort-desc is gone.');
  }
  if (t.has('selectable') || t.byEvent('row-selected').length) {
    ctx.flag('table', '<b-table selectable>: the selection API changed (selected rows are bound with v-model); check select-mode and @row-selected.');
  }
  if (['api-url', 'no-provider-paging', 'no-provider-sorting', 'no-provider-filtering', 'no-local-sorting'].some(p => t.has(p))) {
    ctx.flag('table', '<b-table> provider props: items-provider functions moved to a separate provider prop; check paging, sorting and filtering.');
  }
  if (t.has('sort-compare')) ctx.flag('table', '<b-table sort-compare>: check how your BootstrapVueNext version customises sorting.');
}

function convertIcon(t, kebab, ctx) {
  if (ctx.opts.icons !== 'font') {
    ctx.flag('icons', `<${t.name}>: BootstrapVueNext has no icon components; use bootstrap-icons or unplugin-icons.`);
    return;
  }
  const staticCls = ['bi'];
  const dynCls = [];
  if (kebab === 'b-icon') {
    const [a] = t.byProp('icon');
    if (!a) {
      ctx.flag('icons', '<b-icon> without an icon prop: convert it by hand.');
      return;
    }
    if (attrInfo(a.name).kind === 'bind') {
      const q = litQuote(a.value);
      dynCls.push(`${q}bi-${q} + (${a.value})`);
    } else {
      staticCls.push(`bi-${a.value}`);
    }
    t.remove(a);
  } else {
    if (/^[A-Z]/.test(t.name) && /\d/.test(t.name)) {
      ctx.flag('icons', `<${t.name}>: check the icon name bi-${kebab.slice(7)} (digits in PascalCase names are ambiguous).`);
    }
    staticCls.push(`bi-${kebab.slice(7)}`);
  }
  for (const a of t.byProp('variant')) {
    if (attrInfo(a.name).kind === 'bind') {
      const q = litQuote(a.value);
      dynCls.push(`${q}text-${q} + (${a.value})`);
    } else {
      staticCls.push(`text-${a.value}`);
    }
    t.remove(a);
  }
  for (const a of t.byProp('font-scale')) {
    if (attrInfo(a.name).kind === 'static') {
      t.remove(a);
      t.addStyle(`font-size: ${a.value}em`);
    } else {
      ctx.flag('icons', `<${t.name}> ${a.name}: set font-size yourself; font-scale has no equivalent on <i>.`);
    }
  }
  const extras = t.live.filter(a => ICON_EXTRAS.has(attrInfo(a.name).prop));
  if (extras.length) ctx.flag('icons', `<${t.name}> ${extras.map(a => a.name).join(', ')}: no bootstrap-icons equivalent; use CSS transforms or animations.`);
  if (dynCls.length) {
    const bound = t.live.find(a => /^(:|v-bind:)class$/.test(a.name));
    const value = bound ? `[${dynCls.join(', ')}, ${bound.value}]` : dynCls.length === 1 ? dynCls[0] : `[${dynCls.join(', ')}]`;
    if (value.includes('"') && value.includes("'")) {
      ctx.flag('icons', `<${t.name}>: convert this icon by hand (mixed quotes in its bindings).`);
      return;
    }
    if (bound) Object.assign(bound, { value, dirty: true });
    else t.add(':class', value);
  }
  t.newName = 'i';
  t.addClass(staticCls.join(' '), true);
  if (!t.live.some(a => /^(:|v-bind:)?(aria-label|aria-hidden|title)$/.test(a.name))) t.add('aria-hidden', 'true');
  if (t.self) {
    t.self = false;
    t.trail = t.trail.replace(/[ \t]+$/, '');
    t.after = '</i>';
  }
  ctx.change(`<${kebab.startsWith('b-icon-') ? 'b-icon-*' : 'b-icon'}> → <i class="bi …">`);
}

// ─── Scripts ─────────────────────────────────────────────────────────────────

function transformScript(src, fc) {
  const { opts } = fc;
  src = src.replace(/(['"])bootstrap-vue\/dist\/bootstrap-vue(?:\.min)?\.css\1/g, (_, q) => {
    fc.change('bootstrap-vue.css → bootstrap-vue-next.css');
    return `${q}bootstrap-vue-next/dist/bootstrap-vue-next.css${q}`;
  });
  src = src.replace(/(['"])bootstrap-vue\/dist\/bootstrap-vue-icons(?:\.min)?\.css\1/g, (m, q) => {
    if (opts.icons !== 'font') return fc.flag('icons', 'bootstrap-vue-icons.css: BootstrapVueNext has no icons; use bootstrap-icons or unplugin-icons.') + m;
    fc.change('bootstrap-vue-icons.css → bootstrap-icons.css');
    return `${q}bootstrap-icons/font/bootstrap-icons.css${q}`;
  });
  src = src.replace(/(['"])bootstrap-vue\/nuxt\1/g, (_, q) => {
    fc.change('bootstrap-vue/nuxt → @bootstrap-vue-next/nuxt');
    return fc.flag('plugin-setup', 'The Nuxt module is now @bootstrap-vue-next/nuxt; its options differ from bootstrap-vue/nuxt.') + `${q}@bootstrap-vue-next/nuxt${q}`;
  });

  const renames = new Map();
  const unregister = [];
  const plugins = [];
  src = src.replace(/import\s+(?:(\w+)\s*,\s*)?\{([^}]*)\}\s*from\s*(['"])bootstrap-vue\3(;?)/g, (all, def, specs, q, semi) => {
    const flags = [];
    const kept = [];
    if (def) {
      plugins.push(def);
      flags.push(fc.flag('plugin-setup', `Removed the default import ${def} (the BootstrapVue plugin): register BootstrapVueNext with app.use(createBootstrap()).`));
    }
    for (const spec of specs.split(',').map(s => s.trim()).filter(Boolean)) {
      const [orig, alias] = spec.split(/\s+as\s+/);
      if (IMPORT_RENAMES[orig]) {
        kept.push(alias ? `${IMPORT_RENAMES[orig]} as ${alias}` : IMPORT_RENAMES[orig]);
        if (!alias) renames.set(orig, IMPORT_RENAMES[orig]);
        fc.change(`import ${orig} → ${IMPORT_RENAMES[orig]}`);
      } else if (IMPORT_PLUGIN.test(orig)) {
        plugins.push(alias ?? orig);
        flags.push(fc.flag('plugin-setup', `Removed ${orig} from the import: register BootstrapVueNext with app.use(createBootstrap()).`));
      } else if ((opts.icons === 'font' && IMPORT_ICON.test(orig)) || IMPORT_ADDON.test(orig)) {
        unregister.push(alias ?? orig);
        fc.change(`import ${IMPORT_ADDON.test(orig) ? orig : 'BIcon*'} removed (converted in templates)`);
      } else {
        if (IMPORT_NOT_PORTED.test(orig) || IMPORT_ICON.test(orig)) {
          flags.push(fc.flag('not-ported', `${orig} does not exist in bootstrap-vue-next: replace its usages, then drop it from this import.`));
        }
        kept.push(spec);
      }
    }
    fc.change("import from 'bootstrap-vue' → 'bootstrap-vue-next'");
    if (!kept.length) return flags.join('');
    const multiline = specs.includes('\n');
    const indent = multiline ? (/\n([ \t]*)\S/.exec(specs)?.[1] ?? '  ') : '';
    const comma = /,\s*$/.test(specs) ? ',' : '';
    const list = multiline ? `{\n${indent}${kept.join(`,\n${indent}`)}${comma}\n}` : `{ ${kept.join(', ')} }`;
    return `${flags.join('')}import ${list} from ${q}bootstrap-vue-next${q}${semi}`;
  });
  src = src.replace(/import\s+(\w+)\s+from\s*(['"])bootstrap-vue\2;?/g, (_, def) => {
    plugins.push(def);
    fc.change("import from 'bootstrap-vue' removed");
    return fc.flag('plugin-setup', `Removed import ${def} from 'bootstrap-vue' (the plugin): register BootstrapVueNext with app.use(createBootstrap()).`);
  });
  src = src.replace(/import\s+\*\s+as\s+\w+\s+from\s*(['"])bootstrap-vue\1/g, m =>
    fc.flag('plugin-setup', "Namespace import from 'bootstrap-vue': import the components you use from 'bootstrap-vue-next'.") + m);

  for (const [from, to] of renames) src = src.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  if (unregister.length) {
    const hit = new RegExp(`(^|[^\\w$])(${unregister.map(escapeRe).join('|')})([^\\w$]|$)`);
    src = src.replace(/(\bcomponents\s*:\s*\{)([^{}]*)(\})/g, (all, open, inner, close) => {
      const entries = inner.split(',');
      const kept = entries.filter(e => !hit.test(e));
      if (kept.length === entries.length) return all;
      return open + kept.join(',').replace(/\s*$/, '') + /\s*$/.exec(inner)[0] + close;
    });
  }

  const pluginNames = ['BootstrapVue', 'BootstrapVueIcons', 'IconsPlugin', '\\w+Plugin', ...plugins.map(escapeRe)];
  src = src.replace(new RegExp(`\\b(?:Vue|app)\\.use\\(\\s*(?:${pluginNames.join('|')})\\b`, 'g'), m =>
    fc.flag('plugin-setup', 'BootstrapVue plugins are gone: use app.use(createBootstrap()) from bootstrap-vue-next (see the setup snippet above).') + m);

  // Flags raised inside a value are placed in front of its key.
  const keyCtx = fc.scoped();
  src = mapKeyedClasses(src, keyCtx, () => keyCtx.pending.splice(0).join(''));

  for (const [re, rule, msg] of CODE_FLAGS) src = src.replace(re, m => fc.flag(rule, msg) + m);
  return src.replace(/(['"])bootstrap-vue\1/g, m =>
    fc.flag('plugin-setup', "Remaining reference to 'bootstrap-vue' (require, config, transpileDependencies…): update or remove it.") + m);
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function transformStyle(src, fc, lang) {
  // Selectors aimed at renamed Bootstrap classes follow the rename. Classes kept as hooks stay.
  src = src.replace(/(?<![\w$@.\-])\.(-?[A-Za-z_][\w-]*)/g, (all, tok) => {
    const r = mapClassToken(tok);
    if (!r || r.keep) return all;
    if (r.flag) return fc.flag('bs5-css', `Selector ${r.flag}`) + all;
    if (r.selector === false) {
      return fc.flag('bs5-css', `Selector .${tok}: the markup now uses .${r.to}, a general utility that this rule should not restyle everywhere; re-target it.`) + all;
    }
    const to = r.to.split(' ').filter(Boolean);
    if (to.length !== 1) return fc.flag('bs5-css', `Selector .${tok}: Bootstrap 5 has no single class for this; re-target the rule.`) + all;
    fc.change(`selector .${tok} → .${to[0]}`);
    return `.${to[0]}`;
  });
  if (lang !== 'scss' && lang !== 'sass') return src;

  src = src.replace(/(?<![\w-])theme-color\(\s*\)/g, () => {
    fc.change('theme-color() → $primary');
    return '$primary';
  });
  src = src.replace(/(?<![\w-])theme-color\(/g, () => {
    fc.change('theme-color(…) → map-get($theme-colors, …)');
    return 'map-get($theme-colors, ';
  });
  src = src.replace(/(?<![\w-])theme-color-level\(/g, m => fc.flag('scss', 'theme-color-level() was removed: use tint-color() / shade-color().') + m);
  src = src.replace(/(?<![\w-])color-yiq\(/g, () => {
    fc.change('color-yiq() → color-contrast()');
    return 'color-contrast(';
  });
  src = src.replace(/(?<![\w$.-])(gray|color)\(\s*(["'][\w-]+["'])\s*\)/g, (_, fn, key) => {
    fc.change(`${fn}() → map-get()`);
    return `map-get(${fn === 'gray' ? '$grays' : '$colors'}, ${key})`;
  });

  // Bootstrap 4's media-breakpoint-down(md) meant "below lg"; Bootstrap 5's means "below md".
  const next = { xs: 'sm', sm: 'md', md: 'lg', lg: 'xl' };
  const shift = (m, pre, bp) => {
    if (bp === 'xl') return fc.flag('scss', `${m.trim()}…): in Bootstrap 4 this had no upper bound; pick the Bootstrap 5 breakpoint you mean (xxl is < 1400px).`) + m;
    fc.change('media-breakpoint-down/between upper bound shifted to the Bootstrap 5 meaning');
    return pre + next[bp];
  };
  src = src.replace(/(media-breakpoint-down\(\s*)(xs|sm|md|lg|xl)\b/g, shift);
  src = src.replace(/(media-breakpoint-between\(\s*[\w-]+\s*,\s*)(xs|sm|md|lg|xl)\b/g, shift);

  src = src.replace(/@import\s+(['"])~?bootstrap-vue\/[^'"]*\1;?/g, m =>
    fc.flag('scss', "BootstrapVue's Sass is gone: remove this import; load bootstrap-vue-next/dist/bootstrap-vue-next.css from your entry file.") + m);
  return src.replace(/\$(custom-(?:select|control|checkbox|radio|switch|file|range)[\w-]*|yiq-[\w-]+|jumbotron-[\w-]+|card-columns-[\w-]+|card-deck-[\w-]+|embed-responsive-[\w-]+|display\d-[\w-]+)/g, m =>
    fc.flag('scss', `${m} was removed or renamed in Bootstrap 5 (custom-* → form-*, yiq → $min-contrast-ratio, display sizes → $display-font-sizes).`) + m);
}

// ─── Files ───────────────────────────────────────────────────────────────────

function transformSfc(src, fc) {
  const pug = /<template\b[^>]*\blang\s*=\s*["']pug["']/i.test(src);
  const tpl = s => (pug ? s : transformTemplate(s, fc));
  const block = /(<(script|style)\b([^>]*)>)([\s\S]*?)(<\/\2\s*>)/gi;
  let out = pug ? fc.flag('skipped', 'Pug template: not converted, migrate it by hand.') : '';
  let last = 0;
  let m;
  while ((m = block.exec(src))) {
    const [all, open, kind, attrs, body, close] = m;
    out += tpl(src.slice(last, m.index));
    let next = body;
    if (kind.toLowerCase() === 'script') {
      const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
      if (/x-template/i.test(type)) next = tpl(body);
      else if (!/\bsrc\s*=/i.test(attrs) && (!type || /javascript|module|babel|typescript/i.test(type))) next = transformScript(body, fc);
    } else {
      const lang = /\blang\s*=\s*["'](\w+)["']/i.exec(attrs)?.[1]?.toLowerCase() ?? 'css';
      if (['css', 'scss', 'sass'].includes(lang)) next = transformStyle(body, fc, lang);
      else if (body.trim()) out += fc.flag('skipped', `<style lang="${lang}">: not converted.`);
    }
    out += open + next + close;
    last = m.index + all.length;
  }
  return out + tpl(src.slice(last));
}

const SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
const STYLE_EXTS = new Set(['.css', '.scss', '.sass']);
const SFC_EXTS = new Set(['.vue', '.html', '.htm']);

function transformFile(src, ext, fc) {
  if (SFC_EXTS.has(ext)) return transformSfc(src, fc);
  if (SCRIPT_EXTS.has(ext)) return transformScript(src, fc);
  return transformStyle(src, fc, ext.slice(1));
}

function resolveSentinels(out, fc) {
  const placed = [];
  let line = 1;
  let last = 0;
  for (const m of out.matchAll(SENTINEL_RE)) {
    for (let i = last; i < m.index; i++) if (out.charCodeAt(i) === 10) line++;
    last = m.index;
    placed.push({ ...fc.flags[+m[1]], line });
  }
  const text = out.replace(SENTINEL_RE, '');
  const lines = text.split(/\r?\n/);
  for (const f of placed) f.text = (lines[f.line - 1] ?? '').trim().slice(0, 160);
  return { text, flags: placed };
}

function* walk(dir, ignore, skip) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !ignore.has(e.name)) yield* walk(p, ignore, skip);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (!SFC_EXTS.has(ext) && !SCRIPT_EXTS.has(ext) && !STYLE_EXTS.has(ext)) continue;
    if (/\.min\.|\.d\.[mc]?ts$/.test(e.name) || skip.has(path.resolve(p))) continue;
    yield p;
  }
}

function gitStatus(dir) {
  try {
    return execSync('git status --porcelain', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return null;
  }
}

function lineDiff(a, b) {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length;
  let eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) {
    ea--;
    eb--;
  }
  const a2 = A.slice(s, ea);
  const b2 = B.slice(s, eb);
  const n = a2.length;
  const k = b2.length;
  if (n * k > 4e6) return [...a2.map((t, i) => ['-', s + i + 1, t]), ...b2.map((t, i) => ['+', s + i + 1, t])];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(k + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < k) {
    if (i < n && j < k && a2[i] === b2[j]) {
      i++;
      j++;
    } else if (i < n && (j === k || dp[i + 1][j] >= dp[i][j + 1])) {
      ops.push(['-', s + i + 1, a2[i++]]);
    } else {
      ops.push(['+', s + j + 1, b2[j++]]);
    }
  }
  return ops;
}

// ─── Report ──────────────────────────────────────────────────────────────────

const RULES = [
  ['plugin-setup', 'Setup and imports', 'Entry file, plugin registration, imports and config that still mention BootstrapVue.'],
  ['programmatic', '$bvModal, $bvToast and bv:: events', 'These are composables in BootstrapVueNext (useModal / useToast; useModalController / useToastController in older releases). They need an orchestrator mounted once in App.vue; which component that is depends on your version.'],
  ['not-ported', 'Not in BootstrapVueNext', 'No equivalent component. Rebuild with plain markup and utilities, or another library. These imports were left in place so the build points at them.'],
  ['table', 'BTable', 'Sorting, selection and provider APIs changed.'],
  ['verify-props', 'Props and events to check', 'Renamed or reworked in BootstrapVueNext: compare with the component docs for your version.'],
  ['bs5-css', 'Bootstrap 5 markup', 'Classes and layouts Bootstrap 5 removed or restructured.'],
  ['icons', 'Icons', 'What the bootstrap-icons conversion could not carry over.'],
  ['slots', 'Slot syntax', 'Vue 3 only supports v-slot / #name.'],
  ['vue3', 'Vue 3', 'Vue 2 APIs that Vue 3 removed.'],
  ['router', 'Vue Router 4', 'Vue Router 4 dropped exact / exact-path.'],
  ['scss', 'Sass', 'Functions, mixin arguments and variables Bootstrap 5 removed or renamed.'],
  ['skipped', 'Skipped', 'Not converted at all.'],
];

const mdText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const mdCode = s => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);

function analyzePackage(dir, iconsUsed) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const remove = ['bootstrap-vue', 'portal-vue', 'popper.js', 'jquery'].filter(d => deps[d]);
  const add = ['bootstrap@^5.3', 'bootstrap-vue-next'];
  if (iconsUsed) add.push('bootstrap-icons');
  if (deps.nuxt) add.push('@bootstrap-vue-next/nuxt');
  return { remove, add, vue: deps.vue };
}

function buildReport({ baseDir, opts, results, pkg, iconsUsed }) {
  const changed = results.filter(r => r.text !== r.original);
  const flags = results.flatMap(r => r.flags.map(f => ({ ...f, file: r.rel })));
  const edits = changed.reduce((n, r) => n + [...r.changes.values()].reduce((a, b) => a + b, 0), 0);
  const L = [];
  L.push('# Bootstrap 5 migration report', '');
  L.push(`bs5-migrate ${VERSION}, ${new Date().toISOString().slice(0, 10)}, on ${mdCode(baseDir)}.`, '');
  L.push(opts.write ? 'The changes below were written to disk.' : '**Dry run:** no project files were changed. Run again with `--write` to apply.', '');
  L.push('## Summary', '');
  L.push(`- Files scanned: ${results.length}`);
  L.push(`- Files ${opts.write ? 'changed' : 'that would change'}: ${changed.length} (${edits} automatic edits)`);
  L.push(`- Items to review by hand: ${flags.length} in ${new Set(flags.map(f => f.file)).size} files`, '');

  L.push('## Next steps', '');
  if (pkg) {
    if (pkg.remove.length) L.push('```bash', `npm uninstall ${pkg.remove.join(' ')}`, '```', '');
    L.push('```bash', `npm install ${pkg.add.join(' ')}`, '```', '');
    if (pkg.remove.includes('jquery')) L.push('Keep jquery if something other than Bootstrap 4 uses it.', '');
    if (/^[\^~]?2\./.test(pkg.vue ?? '')) L.push('package.json still lists Vue 2: BootstrapVueNext needs Vue 3.', '');
  }
  L.push('Register BootstrapVueNext in the Vue 3 entry file (newer releases also offer a `<BApp>` root component; check the docs for your version):', '');
  L.push('```js', "import { createApp } from 'vue'", "import { createBootstrap } from 'bootstrap-vue-next'", "import 'bootstrap/dist/css/bootstrap.css'", "import 'bootstrap-vue-next/dist/bootstrap-vue-next.css'");
  if (iconsUsed) L.push("import 'bootstrap-icons/font/bootstrap-icons.css'");
  L.push("import App from './App.vue'", '', "createApp(App).use(createBootstrap()).mount('#app')", '```', '');

  L.push('## Review by hand', '');
  if (!flags.length) L.push('Nothing flagged.', '');
  for (const [rule, title, help] of RULES) {
    const items = flags.filter(f => f.rule === rule);
    if (!items.length) continue;
    L.push(`### ${title} (${items.length})`, '', mdText(help), '');
    for (const f of items) L.push(`- ${mdCode(`${f.file}:${f.line}`)} ${mdText(f.msg)}${f.text ? `<br>${mdCode(f.text)}` : ''}`);
    L.push('');
  }

  L.push('## Automatic changes', '');
  const totals = new Map();
  for (const r of changed) for (const [k, n] of r.changes) totals.set(k, (totals.get(k) ?? 0) + n);
  if (totals.size) {
    L.push('| Change | Count |', '| --- | --- |');
    for (const [k, n] of [...totals].sort((a, b) => b[1] - a[1])) L.push(`| ${mdCode(k)} | ${n} |`);
    L.push('', '| File | Edits |', '| --- | --- |');
    for (const r of changed) L.push(`| ${mdCode(r.rel)} | ${[...r.changes.values()].reduce((a, b) => a + b, 0)} |`);
  } else {
    L.push('None.');
  }
  L.push('');
  L.push('## Not handled by this script', '');
  L.push('- The Vue 2 → 3 core migration: `createApp`, lifecycle renames, `v-model` on your own components, Vue Router 4, Vuex. Use `@vue/compat` and the Vue 3 migration guide.');
  L.push('- Pug templates, JSX / render-function markup (only object keys such as `class:` and `tdClass:` are converted), and templates kept in JS strings.');
  L.push('- Class names assembled at runtime. The ones with a visible Bootstrap 4 prefix are flagged above.');
  L.push('- Look and feel: Bootstrap 5 changed spacing, colors, form controls and navbar markup. Check every page.');
  L.push('');
  return L.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `bs5-migrate ${VERSION}: BootstrapVue (Bootstrap 4) → BootstrapVueNext (Bootstrap 5)

  node bs5-migrate.mjs <project-dir | file> [--write] [--diff] [--icons=font|keep]
                       [--report=<file>] [--ignore=a,b] [--force]

Without --write it is a dry run: it prints what would change and writes the report.`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { write: false, diff: false, force: false, icons: 'font', report: null, ignore: new Set(['node_modules', 'dist', 'build', 'coverage', 'out']) };
  let target = null;
  for (const a of argv) {
    if (a === '--write') opts.write = true;
    else if (a === '--diff') opts.diff = true;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--icons=')) opts.icons = a.slice(8);
    else if (a.startsWith('--report=')) opts.report = a.slice(9);
    else if (a.startsWith('--ignore=')) a.slice(9).split(',').filter(Boolean).forEach(d => opts.ignore.add(d));
    else if (a === '-h' || a === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (a.startsWith('-')) fail(`Unknown option ${a}\n\n${HELP}`);
    else if (target) fail('Give a single project directory or file.');
    else target = a;
  }
  if (!target) fail(HELP);
  if (!['font', 'keep'].includes(opts.icons)) fail('--icons must be font or keep.');
  return { target, opts };
}

function main() {
  const { target, opts } = parseArgs(process.argv.slice(2));
  const root = path.resolve(target);
  if (!fs.existsSync(root)) fail(`Not found: ${root}`);
  const isFile = fs.statSync(root).isFile();
  const baseDir = isFile ? path.dirname(root) : root;
  const reportPath = path.resolve(opts.report ?? path.join(baseDir, 'bs5-migration-report.md'));
  const marker = path.join(baseDir, '.bs5-migrate.json');
  const color = process.stdout.isTTY;
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

  if (opts.write && !opts.force) {
    if (fs.existsSync(marker)) fail(`${marker} shows this project was already migrated. Running again would shift Sass breakpoints twice; use --force if you are sure.`);
    const git = gitStatus(baseDir);
    if (git === null) console.warn(paint(33, 'Not a git repository: make a backup before writing.'));
    else if (git.trim()) fail('There are uncommitted git changes. Commit or stash them first so you can review and revert the codemod (or pass --force).');
  } else if (!opts.write && fs.existsSync(marker)) {
    console.warn(paint(33, `${marker} shows this project was already migrated: Sass breakpoint shifts in this dry run would be applied twice.`));
  }

  const skip = new Set([fileURLToPath(import.meta.url), reportPath].map(p => path.resolve(p)));
  const files = isFile ? [root] : [...walk(root, opts.ignore, skip)];
  const results = [];
  let iconsUsed = false;
  console.log(`bs5-migrate ${VERSION}: ${opts.write ? 'writing changes in' : 'dry run on'} ${baseDir}\n`);
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const rel = path.relative(baseDir, file).split(path.sep).join('/');
    if (original.includes(S_OPEN) || original.includes(S_CLOSE)) {
      console.warn(`  skipped ${rel}: contains private-use characters this script uses as markers`);
      continue;
    }
    const fc = new FileCtx(rel, opts);
    let out;
    try {
      out = transformFile(original, path.extname(file).toLowerCase(), fc);
    } catch (e) {
      console.error(paint(31, `  failed ${rel}: ${e.message}`));
      continue;
    }
    const { text, flags } = resolveSentinels(out, fc);
    if ([...fc.changes.keys()].some(k => k.includes('<i class="bi'))) iconsUsed = true;
    results.push({ rel, original, text, flags, changes: fc.changes });
    if (text === original && !flags.length) continue;
    const edits = [...fc.changes.values()].reduce((a, b) => a + b, 0);
    const status = [text !== original ? `${edits} edits` : '', flags.length ? paint(33, `${flags.length} to review`) : ''].filter(Boolean).join(', ');
    console.log(`  ${rel.padEnd(48)} ${status}`);
    if (opts.diff && text !== original) {
      for (const [op, n, t] of lineDiff(original, text)) console.log(paint(op === '-' ? 31 : 32, `      ${op}${String(n).padStart(5)} | ${t}`));
    }
    if (opts.write && text !== original) fs.writeFileSync(file, text);
  }

  const changed = results.filter(r => r.text !== r.original);
  const flagCount = results.reduce((n, r) => n + r.flags.length, 0);
  const pkg = analyzePackage(baseDir, iconsUsed);
  fs.writeFileSync(reportPath, buildReport({ baseDir, opts, results, pkg, iconsUsed }));
  if (opts.write && changed.length) {
    fs.writeFileSync(marker, JSON.stringify({ tool: 'bs5-migrate', version: VERSION, date: new Date().toISOString(), files: changed.map(r => r.rel) }, null, 2) + '\n');
  }
  console.log(`\n${results.length} files scanned, ${changed.length} ${opts.write ? 'changed' : 'would change'}, ${flagCount} items to review by hand.`);
  console.log(`Report: ${reportPath}`);
  if (!opts.write) console.log('Dry run: nothing in the project was changed. Add --write to apply.');
}

main();
