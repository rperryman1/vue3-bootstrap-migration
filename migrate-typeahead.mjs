#!/usr/bin/env node
/**
 * migrate-typeahead: vue-bootstrap-typeahead (Vue 2) → vue3-bootstrap-typeahead (Vue 3). Node 18+, no dependencies.
 * Keep it next to migrate-slots.mjs and migrate-to-vue3.mjs, whose helpers it uses. Run it after migrate-slots.mjs.
 *
 *   node migrate-typeahead.mjs <file-or-dir>...           dry run: prints what would change
 *   node migrate-typeahead.mjs --write <file-or-dir>...   applies the "fix" items in place
 *
 * "fix" items keep the Vue 2 behavior where the new component allows it. "review" items are only reported:
 * each one needs a decision. docs/typeahead-vue2-vs-vue3.md explains the differences behind every rule.
 * Line numbers always refer to the file as it was before the run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  regionsOf,
  collectTags,
  findCloseEnd,
  applyEdits,
  kebab,
  short,
  lineIndex,
  collectFiles,
  pathReporter
} from './migrate-slots.mjs';
import { splitAttr, camel } from './migrate-to-vue3.mjs';

const OLD_PACKAGE = 'vue-bootstrap-typeahead';
const NEW_PACKAGE = 'vue3-bootstrap-typeahead';
const DOC = 'docs/typeahead-vue2-vs-vue3.md';

const PROP_RENAMES = {
  'data': 'items',
  'serializer': 'item-projection',
  'max-matches': 'max-items',
  'min-matching-chars': 'min-input-length'
};

// Vue 2 defaults the new component doesn't share: at most 10 rows, in a list as wide as the input.
const MAX_ITEMS = ':max-items="10"';
const MENU_CLASS = 'dropdown-menu-class="dropdown-menu w-100"';
const FORM_TAGS = new Set(['form', 'b-form']);

const SINGLE_PARAM_ARROW = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*(?!\{)([\s\S]+?)\s*$/;
const SIMPLE_ASSIGN = /^\s*([A-Za-z_$][\w$.[\]]*)\s*=\s*\$event\s*;?\s*$/;

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readAttr = attr => {
  const { prefix, base, modifiers } = splitAttr(attr.name);

  return {
    attr,
    prefix,
    modifiers,
    key: kebab(base),
    camelStyle: /[A-Z]/.test(base),
    isBind: prefix === ':' || prefix === 'v-bind:',
    isOn: prefix === '@' || prefix === 'v-on:'
  };
};

const valueRange = attr => {
  const end = attr.end - (attr.quote ? attr.quote.length : 0);

  return [end - attr.value.length, end];
};

// A string literal that can sit inside this attribute's quotes.
const literal = (text, quote) => {
  const q = quote === "'" ? '"' : "'";

  return `${q}${text}${q}`;
};

/**
 * The suggestion as highlighted HTML, escaped the way Vue 2's `htmlText` was. boldMatchText doesn't escape, and the
 * compiler decodes `&lt;` inside an attribute, so the ampersand is written as a JS escape.
 */
const safeHtml = (ctx, item, quote, scope = '') => {
  const lt = literal(`${ctx.ampersand}lt;`, quote);
  const gt = literal(`${ctx.ampersand}gt;`, quote);

  return `${scope}boldMatchText(${scope}itemProjection(${item}).replace(/</g, ${lt}).replace(/>/g, ${gt}))`;
};

// ─── which tags are the typeahead ────────────────────────────────────────────

/**
 * Kebab-case tag names this file gives the component: its import name and what it's registered as.
 */
function detectNames(source) {
  const pkg = `['"]${OLD_PACKAGE}(?:/[^'"]*)?['"]`;
  const locals = new Set();
  const names = new Set();
  const collect = (pattern, group, target) => {
    for (const m of source.matchAll(pattern)) target.add(m[group]);
  };

  collect(new RegExp(`\\bimport\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*${pkg}`, 'g'), 1, locals);
  collect(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*${pkg}\\s*\\)`, 'g'), 1, locals);
  collect(new RegExp(`(['"]?)([A-Za-z_$][\\w$-]*)\\1\\s*:\\s*\\(\\s*\\)\\s*=>\\s*import\\(\\s*${pkg}`, 'g'), 2, names);

  locals.forEach(local => {
    names.add(local);
    const name = escapeRe(local);
    collect(new RegExp(`\\bcomponent\\(\\s*['"]([\\w-]+)['"]\\s*,\\s*${name}\\b`, 'g'), 1, names);
    for (const block of source.matchAll(/\bcomponents\s*:\s*\{([^{}]*)\}/g)) {
      for (const m of block[1].matchAll(new RegExp(`(['"]?)([A-Za-z_$][\\w$-]*)\\1\\s*:\\s*${name}\\b`, 'g'))) names.add(m[2]);
    }
  });

  return [...names].map(kebab);
}

// ─── script and style text ───────────────────────────────────────────────────

function packageEdits(source, ctx) {
  const edits = [];

  // The stylesheet import is a whole statement: the new package ships no CSS.
  const cssImport = new RegExp(`^[ \\t]*(?:import\\s+|require\\(\\s*)['"]${OLD_PACKAGE}/dist/VueBootstrapTypeahead\\.css['"][ \\t]*\\)?;?[ \\t]*\\r?\\n?`, 'gm');
  for (const m of source.matchAll(cssImport)) {
    edits.push({ start: m.index, end: m.index + m[0].length, text: '', order: 1 });
    ctx.fix(ctx.lineOf(m.index), 'package css', m[0], '(removed)');
  }

  const removed = edits.slice();
  for (const m of source.matchAll(new RegExp(`(['"])~?${OLD_PACKAGE}(/[^'"]*)?\\1`, 'g'))) {
    if (removed.some(e => m.index >= e.start && m.index < e.end)) continue;
    const sub = m[2] || '';
    if (/^(?:\/src\/components\/VueBootstrapTypeahead(?:\.vue)?|\/dist\/VueBootstrapTypeahead\.(?:common|umd|umd\.min)\.js)?$/.test(sub)) {
      const to = `${m[1]}${NEW_PACKAGE}${m[1]}`;
      edits.push({ start: m.index, end: m.index + m[0].length, text: to, order: 1 });
      ctx.fix(ctx.lineOf(m.index), 'package import', m[0], to);
    } else if (/\.s?css$/.test(sub)) {
      ctx.review(ctx.lineOf(m.index), 'package css', `remove this stylesheet: ${NEW_PACKAGE} ships no CSS`);
    } else {
      ctx.review(ctx.lineOf(m.index), 'deep import', `${m[0]} has no counterpart in ${NEW_PACKAGE}, which only exports its default component`);
    }
  }

  return edits;
}

// The options-API `watch: { ... }` block, found by counting braces.
function watchBlock(source) {
  const m = /\bwatch\s*:\s*\{/.exec(source);
  if (!m) return '';
  let depth = 1;
  let i = m.index + m[0].length;
  while (i < source.length && depth) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }

  return source.slice(m.index, i);
}

function isWatched(source, name) {
  const n = escapeRe(name);

  return new RegExp(`['"]?\\b${n}\\b['"]?\\s*[:(]`).test(watchBlock(source))
    || new RegExp(`\\bwatch\\(\\s*${n}\\b|\\$watch\\(\\s*['"]${n}['"]`).test(source);
}

function textReviews(source, ctx) {
  const each = (pattern, rule, message) => {
    for (const m of source.matchAll(pattern)) ctx.review(ctx.lineOf(m.index), rule, message(m));
  };

  each(/\.(vbst-item|vbt-autcomplete-list)\b/g, 'old css class', m => `.${m[1]} no longer exists: rows are .dropdown-item, the list is .dropdown-menu`);
  each(new RegExp(`\\(\\s*\\)\\s*=>\\s*import\\(\\s*['"]${OLD_PACKAGE}`, 'g'), 'async component', () => 'Vue 3 needs defineAsyncComponent(() => import(...)) here');
  each(new RegExp(`unpkg\\.com/${OLD_PACKAGE}`, 'g'), 'cdn', () => `load ${NEW_PACKAGE} instead: its browser global is window['Vue3 Bootstrap TypeAhead']`);
  each(/\bVue\.component\(\s*['"]([\w-]+)['"]\s*,/g, 'global registration', m => {
    return ctx.names.has(kebab(m[1])) ? `Vue 3: app.component('${m[1]}', ...)` : null;
  });
  ctx.refs.forEach(name => {
    each(new RegExp(`\\$refs\\.${escapeRe(name)}\\b`, 'g'), 'template ref', () => {
      return `the component exposes nothing, so inputValue and $refs.input are gone: set the text with v-model, reach the input with $refs.${name}.$el.querySelector('input')`;
    });
  });
}

// ─── the #suggestion slot ────────────────────────────────────────────────────

function convertSuggestion(src, tags, slot, attr, ctx, edits) {
  const line = ctx.lineOf(slot.start);
  const newName = attr.name.replace('suggestion', 'item');
  const closeEnd = findCloseEnd(src, slot);
  if (closeEnd === null) {
    ctx.review(line, 'suggestion slot', 'no closing </template> found: convert it by hand');
    return;
  }
  const bodyStart = slot.end;
  const bodyEnd = src.lastIndexOf('</', closeEnd - 1);
  const body = src.slice(bodyStart, bodyEnd);
  const inner = tags.filter(t => t.start >= bodyStart && t.start < bodyEnd);
  // A single-quoted attribute needs double-quoted strings in the expression that goes into it.
  const quoteAt = pos => {
    const hit = inner.flatMap(t => t.attrs).find(a => pos >= a.start && pos < a.end);

    return hit ? hit.quote : '"';
  };
  const bodyEdit = (index, length, text) => edits.push({ start: bodyStart + index, end: bodyStart + index + length, text, order: 1 });
  const giveUp = why => ctx.review(line, 'suggestion slot', `${why}: rename the slot to #item (item, index, itemProjection, boldMatchText) by hand`);

  if (attr.value === null) {
    edits.push({ start: attr.start, end: attr.end, text: newName, order: 1 });
    ctx.fix(line, 'suggestion slot', attr.name, newName);
    return;
  }

  const whole = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(attr.value);
  if (whole) {
    const s = whole[1];
    const rest = body.replace(new RegExp(`\\b${escapeRe(s)}\\.(?:data|htmlText)\\b`, 'g'), '');
    if (new RegExp(`\\b${escapeRe(s)}\\b`).test(rest)) {
      giveUp(`\`${s}\` is used as a whole`);
      return;
    }
    for (const m of body.matchAll(new RegExp(`\\b${escapeRe(s)}\\.(data|htmlText)\\b`, 'g'))) {
      bodyEdit(m.index, m[0].length, m[1] === 'data' ? `${s}.item` : safeHtml(ctx, `${s}.item`, quoteAt(bodyStart + m.index), `${s}.`));
    }
    edits.push({ start: attr.start, end: attr.start + attr.name.length, text: newName, order: 1 });
    ctx.fix(line, 'suggestion slot', attr.name, newName);
    return;
  }

  const destructured = /^\s*\{([^{}]*)\}\s*$/.exec(attr.value);
  if (!destructured) {
    giveUp('its slot data is too complex to rewrite');
    return;
  }
  const bindings = {};
  for (const part of destructured[1].split(',').map(p => p.trim()).filter(Boolean)) {
    const m = /^(data|htmlText)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(part);
    if (!m) {
      giveUp(`\`${part}\` can't be rewritten`);
      return;
    }
    bindings[m[1]] = m[2] || m[1];
  }
  if (!bindings.data && /\bitem\b/.test(body)) {
    giveUp('its content already uses a name `item`');
    return;
  }

  const item = bindings.data || 'item';
  const parts = [item === 'item' ? 'item' : `item: ${item}`];
  if (bindings.htmlText) {
    parts.push('itemProjection', 'boldMatchText');
    for (const m of body.matchAll(new RegExp(`\\b${escapeRe(bindings.htmlText)}\\b`, 'g'))) {
      bodyEdit(m.index, m[0].length, safeHtml(ctx, item, quoteAt(bodyStart + m.index)));
    }
  }
  const q = attr.quote;
  const to = `${newName}=${q}{ ${parts.join(', ')} }${q}`;
  edits.push({ start: attr.start, end: attr.end, text: to, order: 1 });
  ctx.fix(line, 'suggestion slot', src.slice(attr.start, attr.end), to);
}

// A slot with the escaped, highlighted row: the component's own row is unescaped HTML.
function addEscapedSlot(src, tag, closeEnd, ctx, edits) {
  const lineStart = src.lastIndexOf('\n', tag.start) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart, tag.start))[0];
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const slot = `${nl}${indent}  <template #item="{ item, itemProjection, boldMatchText }">`
    + `${nl}${indent}    <span v-html="${safeHtml(ctx, 'item', '"')}"></span>`
    + `${nl}${indent}  </template>`;

  if (tag.selfClosing) {
    let start = tag.end - 2;
    while (start > tag.start && /\s/.test(src[start - 1])) start--;
    edits.push({ start, end: tag.end, text: `>${slot}${nl}${indent}</${tag.name}>`, order: 2 });
  } else {
    const closeStart = src.lastIndexOf('</', closeEnd - 1);
    if (!src.slice(tag.end, closeStart).trim()) edits.push({ start: tag.end, end: closeStart, text: `${slot}${nl}${indent}`, order: 2 });
    else edits.push({ start: tag.end, end: tag.end, text: slot, order: 2 });
  }
  ctx.fix(ctx.lineOf(tag.start), 'escape suggestions', '(component renders raw HTML)', '#item slot with escaping');
}

// ─── one typeahead tag ───────────────────────────────────────────────────────

function convertTag(src, tags, tag, ctx, edits) {
  const line = ctx.lineOf(tag.start);
  const attrs = tag.attrs.map(readAttr);
  const prop = key => attrs.find(a => !a.isOn && a.key === key);
  const event = key => attrs.find(a => a.isOn && a.key === key);
  const rename = (a, to) => {
    edits.push({ start: a.attr.start, end: a.attr.start + a.attr.name.length, text: to, order: 1 });
    ctx.fix(line, 'renamed', a.attr.name, to);
  };
  const remove = a => {
    let start = a.attr.start;
    while (start > tag.start && /\s/.test(src[start - 1])) start--;
    edits.push({ start, end: a.attr.end, text: '', order: 1 });
  };
  const setValue = (a, text) => {
    const [start, end] = valueRange(a.attr);
    edits.push({ start, end, text, order: 1 });
  };
  const added = [];
  const add = (text, rule) => {
    added.push(text);
    if (rule) ctx.fix(line, rule, '(new attribute)', text);
  };

  // Already on the new API, or a tag this script can't read.
  if (prop('items')) return;
  if (tag.attrs.some(a => a.escaped)) {
    ctx.review(line, 'escaped template', 'a template string with escaped quotes: convert this typeahead by hand');
    return;
  }
  if (attrs.some(a => a.key === 'v-bind' && !a.prefix)) ctx.review(line, 'v-bind object', 'props passed in an object aren\'t converted: rename them by hand');
  if (!prop('data')) return;

  const serializer = prop('serializer');
  const model = attrs.find(a => a.key === 'v-model') || prop('value');
  const modelName = model && model.attr.value ? model.attr.value.trim() : null;

  // Plain renames.
  attrs.filter(a => !a.isOn && PROP_RENAMES[a.key]).forEach(a => {
    const to = PROP_RENAMES[a.key];
    rename(a, a.prefix + (a.camelStyle ? camel(to) : to) + a.modifiers.map(m => `.${m}`).join(''));
  });

  // The projection is also called with the v-model value, which can be null.
  if (serializer && serializer.isBind) {
    const m = SINGLE_PARAM_ARROW.exec(serializer.attr.value || '');
    if (m && !m[2].includes('?.')) {
      const to = `${m[1]} => (${m[1]} == null ? ${literal('', serializer.attr.quote)} : ${m[2]})`;
      setValue(serializer, to);
      ctx.fix(line, 'null-safe projection', serializer.attr.value, to);
    } else if (!m) {
      ctx.review(line, 'item-projection', `${short(serializer.attr.value || '')} also gets the v-model value, which can be null: return '' for null or it crashes on render`);
    }
  }

  // size and input-class: the Vue 2 component always kept form-control, the new prop replaces it.
  const size = prop('size');
  const inputClasses = ['form-control'];
  if (size && size.isBind) {
    ctx.review(line, 'size', `${size.attr.name}="${short(size.attr.value || '')}": size is gone, put form-control-lg / form-control-sm in input-class yourself`);
  } else if (size) {
    inputClasses.push(`form-control-${size.attr.value}`);
    remove(size);
    ctx.fix(line, 'size', `size="${size.attr.value}"`, `form-control-${size.attr.value}`);
  }
  const inputClass = prop('input-class');
  if (inputClass && inputClass.isBind) {
    const to = `${literal(`${inputClasses.join(' ')} `, inputClass.attr.quote)} + (${inputClass.attr.value})`;
    setValue(inputClass, to);
    ctx.fix(line, 'input-class', inputClass.attr.value, to);
  } else if (inputClass && inputClass.attr.value !== null) {
    const own = inputClass.attr.value.split(/\s+/).filter(Boolean);
    const to = [...inputClasses.filter(c => !own.includes(c)), ...own].join(' ');
    if (to !== inputClass.attr.value) {
      setValue(inputClass, to);
      ctx.fix(line, 'input-class', inputClass.attr.value, to);
    }
  } else if (inputClasses.length > 1) {
    add(`input-class="${inputClasses.join(' ')}"`);
  }

  // Row colors.
  const itemClasses = ['dropdown-item'];
  [['background-variant', 'bg'], ['text-variant', 'text']].forEach(([key, utility]) => {
    const a = prop(key);
    if (!a) return;
    if (a.isBind) {
      ctx.review(line, key, `${a.attr.name}="${short(a.attr.value || '')}": gone, use :dropdown-item-class with a function or an expression`);
      return;
    }
    itemClasses.push(`${utility}-${a.attr.value}`);
    remove(a);
    ctx.fix(line, key, `${key}="${a.attr.value}"`, `${utility}-${a.attr.value}`);
    if (utility === 'bg') ctx.review(line, key, 'bg-* outranks .active, so the row picked with the arrow keys won\'t look selected');
  });
  if (itemClasses.length > 1) add(`dropdown-item-class="${itemClasses.join(' ')}"`);

  // Vue 2 defaults.
  if (!prop('max-matches')) add(MAX_ITEMS, 'max rows');
  add(MENU_CLASS, 'menu width');

  // v-model meant the typed text; now it's the picked item.
  const hit = event('hit');
  const input = event('input');
  const value = prop('value');
  if (value) rename(value, `${value.prefix}model-value`);
  if (input) rename(input, `${input.prefix}update:model-value${input.modifiers.map(m => `.${m}`).join('')}`);
  const assign = hit && SIMPLE_ASSIGN.exec(hit.attr.value || '');
  if (model && !serializer) {
    // Strings: allow-new + immediate keeps "the model is whatever is in the input".
    add('allow-new', 'keep v-model text');
    add('immediate', 'keep v-model text');
    if (hit) ctx.review(line, 'hit', 'there is no hit event, and the model now changes on every keystroke too, so a pick looks the same as typing');
  } else if (model) {
    const hint = assign ? `here @hit="${short(hit.attr.value)}" becomes v-model="${assign[1]}"` : 'usually v-model="selected" with :items="query => fetch(...)"';
    ctx.review(line, 'v-model', `now holds the picked item and only changes on a pick, so it can't hold the search text: ${hint}. See ${DOC}`);
  } else if (assign) {
    const to = `v-model="${assign[1]}"`;
    edits.push({ start: hit.attr.start, end: hit.attr.end, text: to, order: 1 });
    ctx.fix(line, 'hit', hit.attr.name, to);
  } else if (hit) {
    ctx.review(line, 'hit', 'there is no hit event: bind v-model to the picked item (without it the input goes blank after a pick) and react with a watcher or @update:model-value');
  }
  if (input || (modelName && isWatched(ctx.source, modelName))) {
    ctx.review(line, 'items array', `results fetched after a keystroke show up one keystroke late, because an array is only read when the text changes: pass a function to :items. See ${DOC}`);
  }

  // input-group add-ons.
  const closeEnd = findCloseEnd(src, tag);
  const inside = closeEnd === null ? [] : tags.filter(t => t.start >= tag.end && t.start < closeEnd);
  const slotAttr = name => {
    for (const t of inside) {
      const a = t.attrs.find(x => (x.name === 'slot' && x.value === name) || x.name === `#${name}` || x.name === `v-slot:${name}`);
      if (a) return a;
    }

    return null;
  };
  ['prepend', 'append'].forEach(side => {
    if (!prop(side) && !slotAttr(side)) return;
    const edge = side === 'prepend' ? 'start' : 'end';
    ctx.review(line, side, `gone: wrap it in <div class="input-group"> with an <span class="input-group-text"> and add dropdown-class="dropdown flex-grow-1" input-class="form-control rounded-${edge}-0"`);
  });

  // Rows.
  if (closeEnd === null) {
    ctx.review(line, 'suggestion slot', 'no closing tag found: its rows render raw HTML, add an escaping #item slot by hand');
  } else {
    const legacy = slotAttr('suggestion');
    if (legacy && legacy.name === 'slot') {
      ctx.review(ctx.lineOf(legacy.start), 'suggestion slot', 'old slot syntax: run migrate-slots.mjs first, then this script');
    } else if (legacy) {
      const slot = inside.find(t => t.attrs.includes(legacy));
      convertSuggestion(src, tags, slot, legacy, ctx, edits);
    } else {
      addEscapedSlot(src, tag, closeEnd, ctx, edits);
    }
  }

  // New attributes go after the last one, in the same layout.
  const last = tag.attrs[tag.attrs.length - 1];
  const previous = tag.attrs[tag.attrs.length - 2];
  const gap = src.slice(previous ? previous.end : tag.start + tag.name.length + 1, last.start);
  const separator = gap.includes('\n') ? gap : ' ';
  edits.push({ start: last.end, end: last.end, text: added.map(a => separator + a).join(''), order: 1 });

  // Enter inside a form.
  const inForm = tags.some(t => {
    if (!FORM_TAGS.has(kebab(t.name)) || t.start >= tag.start) return false;
    const end = findCloseEnd(src, t);

    return end === null || end > tag.start;
  });
  if (inForm) ctx.review(line, 'enter key', 'Enter no longer submits this form: the input cancels it, even with nothing selected');

  const ref = prop('ref');
  if (ref && !ref.isBind && ref.attr.value) ctx.refs.add(ref.attr.value);
}

function templateEdits(src, ctx) {
  const tags = collectTags(src);
  const edits = [];
  tags.filter(tag => ctx.names.has(kebab(tag.name))).forEach(tag => convertTag(src, tags, tag, ctx, edits));

  return edits;
}

// ─── per file ────────────────────────────────────────────────────────────────

/**
 * Migrates one file's source. Returns the new source plus the fix / review items.
 * `names`: kebab-case tag names the component is registered under anywhere in the project.
 */
function migrateSource(source, { filename = 'file.vue', names = [] } = {}) {
  const ext = path.extname(filename).toLowerCase();
  const lineOf = lineIndex(source);
  const fixes = [];
  const reviews = [];
  const ctx = {
    source,
    lineOf,
    names: new Set([kebab(OLD_PACKAGE), ...names, ...detectNames(source)]),
    refs: new Set(),
    fix: (line, rule, from, to) => fixes.push({ line, rule, from: short(from), to: short(to) }),
    review: (line, rule, message) => {
      if (message) reviews.push({ line, rule, message });
    }
  };

  const { templates } = regionsOf(source, ext, (pos, rule, message) => ctx.review(lineOf(pos), rule, message));
  const edits = [];
  templates.forEach(([start, end]) => {
    // Inside a JS template literal the escape itself has to survive the JS string.
    const ampersand = source[start - 1] === '`' ? '\\\\u0026' : '\\u0026';
    const local = Object.assign({}, ctx, { ampersand, lineOf: i => lineOf(start + i) });
    templateEdits(source.slice(start, end), local)
      .forEach(e => edits.push(Object.assign({}, e, { start: e.start + start, end: e.end + start })));
  });
  edits.push(...packageEdits(source, ctx));
  textReviews(source, ctx);

  const output = applyEdits(source, edits, edit => {
    ctx.review(lineOf(edit.start), 'overlap', 'two changes touch the same place: this one was skipped, review it by hand');
  });
  const byLine = (a, b) => a.line - b.line;

  return { output, fixes: fixes.sort(byLine), reviews: reviews.sort(byLine) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function run(argv, log = console.log) {
  const write = argv.includes('--write');
  const inputs = argv.filter(arg => !arg.startsWith('--'));
  if (!inputs.length || argv.includes('--help')) {
    log('Usage: node migrate-typeahead.mjs [--write] <file-or-dir>...');
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

  // A component registered globally in main.js is used by tag name everywhere else.
  const names = [...sources.values()].flatMap(detectNames);

  let fixCount = 0;
  let reviewCount = 0;
  let changedFiles = 0;
  files.forEach(file => {
    const source = sources.get(file);
    const { output, fixes, reviews } = migrateSource(source, { filename: file, names });
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
  if (fixCount || reviewCount) {
    log(`Then swap the package: npm uninstall ${OLD_PACKAGE}, npm install ${NEW_PACKAGE}. Keep vue at 3.5.40 or newer, and check that \`npm ls vue\` shows a single copy.`);
  }

  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}

export { migrateSource, detectNames, run };
