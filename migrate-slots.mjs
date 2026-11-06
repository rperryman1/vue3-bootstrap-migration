#!/usr/bin/env node
/**
 * migrate-slots: Vue 2 → Vue 3 slot migration, plus the slots BootstrapVueNext renamed.
 * Standalone: copy it into any project. Node 18+, no dependencies.
 *
 *   node migrate-slots.mjs <file-or-dir>...           dry run: prints what would change
 *   node migrate-slots.mjs --write <file-or-dir>...   applies the "fix" items in place
 *
 * Templates (.vue <template>, .html, template strings in .js/.ts):
 *   slot-scope="x" / scope="x"          → <template v-slot="x">
 *   slot="name" (+ slot-scope="x")      → <template v-slot:name="x">
 *   :slot="expr"                        → <template v-slot:[expr]>
 *   slot="default" without a scope      → attribute removed (it already is default content)
 *   several elements with slot="name"   → merged into one <template v-slot:name>, in order
 *   slots BootstrapVueNext renamed      → new name (modal-footer → footer on <b-modal>, ...)
 * Scripts:
 *   $scopedSlots                        → $slots
 *
 * "review" items are only reported. Line numbers refer to the files as they were before the run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = new Set(['.vue', '.html', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.nuxt', '.output', 'coverage']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Plain HTML/SVG elements: a `slot` attribute on their children is not a Vue slot (web components, or a no-op).
const HTML_TAGS = new Set((
  'a abbr address area article aside audio b bdi bdo blockquote body br button canvas caption cite code col colgroup ' +
  'data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 ' +
  'head header hgroup hr html i iframe img input ins kbd label legend li main map mark menu meter nav noscript ' +
  'object ol optgroup option output p picture pre progress q rp rt ruby s samp section select slot small source span ' +
  'strong sub summary sup table tbody td textarea tfoot th thead time tr u ul var video ' +
  'svg g path circle ellipse rect line polyline polygon text tspan defs use symbol clippath mask pattern foreignobject'
).split(' '));

// Slots renamed from BootstrapVue to BootstrapVueNext, from its migration guide.
const COMPONENT_SLOT_RENAMES = {
  'b-alert': { dismiss: 'close' },
  'b-modal': {
    'modal-header-close': 'header-close',
    'modal-header': 'header',
    'modal-title': 'title',
    'modal-footer': 'footer',
    'modal-ok': 'ok',
    'modal-cancel': 'cancel',
    'modal-backdrop': 'backdrop'
  },
  'b-table': { emptyfiltered: 'empty-filtered' },
  'b-toast': { 'toast-title': 'title' }
};

// Slot data that changed in BootstrapVueNext. Which uses need changing is a judgement call, so these are only reported.
const SCOPE_REVIEWS = [
  { components: ['b-collapse'], slot: 'default', variable: 'close', message: '`close` in this slot\'s data is now `hide`' },
  { components: ['b-table', 'b-table-lite'], slot: 'table-colgroup', variable: 'columns', message: '`columns` was removed from this slot\'s data: use `fields`' },
  { components: ['b-form-file'], slot: 'drop-placeholder', variable: 'dropAllowed', message: '`dropAllowed` was removed from this slot\'s data' },
  { components: ['b-form-tags'], slot: 'default', variable: 'inputHandlers', message: '`inputHandlers` no longer line up with other inputs\' events: bind them explicitly' }
];

const CONDITION = /^v-(?:if|else-if|else)$/;
const CONTINUES_CHAIN = /^v-else(?:-if)?$/;

// ─── helpers ─────────────────────────────────────────────────────────────────

const kebab = name => name.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase());
const short = text => {
  const flat = String(text).replace(/\s+/g, ' ').trim();

  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
};
const renamedSlot = (component, name) => {
  const table = COMPONENT_SLOT_RENAMES[kebab(component.name)];

  return table && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : name;
};

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }

  return index => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }

    return lo + 1;
  };
}

const TAG_NAME = /<([A-Za-z][\w.:-]*)/y;
const CLOSE_TAG = /<\/([A-Za-z][\w.:-]*)\s*>/y;
const ESCAPED_QUOTE = /\\+["']/y;

/**
 * Parses an opening tag at `start`, respecting quoted attribute values (so `v-if="a > b"` is fine).
 * Templates inside JS strings can escape their quotes (slot=\"x\"): those values are read whole and marked `escaped`.
 */
function parseOpenTag(src, start) {
  TAG_NAME.lastIndex = start;
  const head = TAG_NAME.exec(src);
  if (!head) return null;

  const attrs = [];
  let i = start + head[0].length;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === '>') return { name: head[1], attrs, start, end: i + 1, selfClosing: false };
    if (src[i] === '/' && src[i + 1] === '>') return { name: head[1], attrs, start, end: i + 2, selfClosing: true };
    if (i >= src.length) return null;

    const nameStart = i;
    while (i < src.length && !/[\s=>]/.test(src[i]) && !(src[i] === '/' && src[i + 1] === '>')) i++;
    if (i === nameStart) {
      i++;
      continue;
    }

    const attr = { name: src.slice(nameStart, i), value: null, quote: null, start: nameStart, end: i };
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '=') {
      j++;
      while (j < src.length && /\s/.test(src[j])) j++;
      const quote = src[j];
      ESCAPED_QUOTE.lastIndex = j;
      const escaped = ESCAPED_QUOTE.exec(src);
      if (escaped) {
        const close = src.indexOf(escaped[0], j + escaped[0].length);
        if (close === -1) return null;
        attr.quote = escaped[0];
        attr.escaped = true;
        attr.value = src.slice(j + escaped[0].length, close);
        i = close + escaped[0].length;
      } else if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, j + 1);
        if (close === -1) return null;
        attr.quote = quote;
        attr.value = src.slice(j + 1, close);
        i = close + 1;
      } else {
        const valueStart = j;
        while (j < src.length && !/[\s>]/.test(src[j])) j++;
        attr.value = src.slice(valueStart, j);
        i = j;
      }
      attr.end = i;
    }
    attrs.push(attr);
  }

  return null;
}

function collectTags(src) {
  const tags = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (/[A-Za-z]/.test(src[lt + 1] || '')) {
      const tag = parseOpenTag(src, lt);
      if (tag) {
        tags.push(tag);
        i = tag.end;
        continue;
      }
    }
    i = lt + 1;
  }

  return tags;
}

/**
 * Index just after the matching closing tag (same name, counting nesting), or null.
 */
function findCloseEnd(src, tag) {
  if (tag.selfClosing || VOID_TAGS.has(tag.name.toLowerCase())) return tag.end;

  const target = kebab(tag.name);
  let depth = 1;
  let i = tag.end;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) return null;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) return null;
      i = end + 3;
      continue;
    }
    if (src[lt + 1] === '/') {
      CLOSE_TAG.lastIndex = lt;
      const m = CLOSE_TAG.exec(src);
      if (m) {
        if (kebab(m[1]) === target && --depth === 0) return lt + m[0].length;
        i = lt + m[0].length;
        continue;
      }
    } else if (/[A-Za-z]/.test(src[lt + 1] || '')) {
      const inner = parseOpenTag(src, lt);
      if (inner) {
        if (kebab(inner.name) === target && !inner.selfClosing) depth++;
        i = inner.end;
        continue;
      }
    }
    i = lt + 1;
  }

  return null;
}

/**
 * The opening tag text with the given attributes (and the whitespace before them) removed.
 */
function removeAttrs(src, tag, attrs) {
  let text = src.slice(tag.start, tag.end);
  attrs.slice().sort((a, b) => b.start - a.start).forEach(attr => {
    let s = attr.start - tag.start;
    const e = attr.end - tag.start;
    while (s > 0 && /\s/.test(text[s - 1])) s--;
    text = text.slice(0, s) + text.slice(e);
  });

  return text;
}

/**
 * Applies non-overlapping edits. At the same position a higher `order` ends up later in the text.
 */
function applyEdits(src, edits, onSkip = () => {}) {
  const sorted = edits.slice().sort((a, b) => (b.start - a.start) || (b.order - a.order));
  let out = src;
  let boundary = Infinity;
  sorted.forEach(edit => {
    if (edit.end > boundary) {
      onSkip(edit);
      return;
    }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    boundary = edit.start;
  });

  return out;
}

/**
 * Removes and returns the edits lying strictly inside [start, end) (zero-width edits on the edges belong outside).
 */
function takeEdits(edits, start, end) {
  const taken = [];
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    const zeroWidthEdge = e.start === e.end && (e.start === start || e.start === end);
    if (e.start >= start && e.end <= end && !zeroWidthEdge) {
      taken.unshift(e);
      edits.splice(i, 1);
    }
  }

  return taken;
}

const indentOf = (src, pos) => {
  let s = pos;
  while (s > 0 && src[s - 1] !== '\n') s--;

  return /^[ \t]*/.exec(src.slice(s, pos))[0];
};

/**
 * Grows [start, end) to whole lines when the element is alone on its line(s).
 */
function expandToLines(src, start, end) {
  let s = start;
  while (s > 0 && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
  if (s > 0 && src[s - 1] !== '\n') return [start, end];

  let e = end;
  while (e < src.length && (src[e] === ' ' || src[e] === '\t')) e++;
  if (src[e] === '\r') e++;
  if (e < src.length && src[e] !== '\n') return [start, end];

  return [s, Math.min(e + 1, src.length)];
}

// ─── template transform ──────────────────────────────────────────────────────

function templateEdits(src, ctx) {
  const tags = collectTags(src);
  const edits = [];
  const closeEnds = new Map();
  const closeEndOf = tag => {
    if (!closeEnds.has(tag)) closeEnds.set(tag, findCloseEnd(src, tag));
    return closeEnds.get(tag);
  };
  const parentOf = tag => {
    let parent = null;
    for (const t of tags) {
      if (t.start >= tag.start) break;
      const end = closeEndOf(t);
      if (end !== null && end > tag.start) parent = t;
    }
    return parent;
  };
  const childrenOf = parent => {
    const end = closeEndOf(parent);

    return tags.filter(t => t.start > parent.start && t.start < end && parentOf(t) === parent);
  };
  const hasVSlot = tag => tag.attrs.some(a => a.name === 'v-slot' || a.name.startsWith('v-slot:') || a.name.startsWith('#'));
  const hasAttr = (tag, pattern) => tag.attrs.some(a => pattern.test(a.name));
  const directiveFor = (c, name) => {
    let directive = 'v-slot';
    if (c.dynamic) directive += `:[${c.slotName}]`;
    else if (name !== 'default') directive += `:${name}`;
    if (c.scopeAttr && c.scopeAttr.value !== null) {
      const q = c.scopeAttr.quote || '"';
      directive += `=${q}${c.scopeAttr.value}${q}`;
    }
    return directive;
  };
  // Directives that must sit on the <template v-slot> wrapper rather than the wrapped element.
  const hoistedAttrs = c => {
    const vFor = c.tag.attrs.find(a => a.name === 'v-for');
    // the slot name may read the loop variable, so the loop has to surround the slot
    if (c.dynamic && vFor) return [vFor];
    // a slot behind v-if must not exist at all when the condition is false.
    // With slot-scope the condition may read the slot data, so there it stays inside.
    return c.scopeAttr ? [] : c.tag.attrs.filter(a => CONDITION.test(a.name));
  };

  // collect the Vue 2 slot usages
  const candidates = [];
  tags.forEach(tag => {
    const isTemplate = tag.name.toLowerCase() === 'template';
    const scopeAttr = tag.attrs.find(a => a.name === 'slot-scope' || (isTemplate && a.name === 'scope'));
    const slotAttr = tag.attrs.find(a => a.name === 'slot' || a.name === ':slot' || a.name === 'v-bind:slot');
    if (!scopeAttr && !slotAttr) return;

    const line = ctx.lineOf(tag.start);
    const label = `<${tag.name}>`;
    if ((scopeAttr && scopeAttr.escaped) || (slotAttr && slotAttr.escaped)) {
      ctx.review(line, 'escaped quotes', `${label} is in a template string with escaped quotes (\\"): convert it by hand`);
      return;
    }
    if (hasVSlot(tag)) {
      ctx.review(line, 'mixed syntax', `${label} has both v-slot and slot/slot-scope: keep one`);
      return;
    }

    const parent = parentOf(tag);
    if (!parent) {
      ctx.review(line, 'no component', `${label} has a slot attribute but no parent component`);
      return;
    }
    const parentName = parent.name.toLowerCase();
    if (parentName === 'template') {
      ctx.review(line, 'nested template', `${label} sits inside a plain <template> (v-if / v-for?): Vue 3 needs <template v-slot> directly under the component, e.g. <template v-slot:name v-if="...">`);
      return;
    }
    if (HTML_TAGS.has(parentName)) {
      ctx.review(line, 'native parent', `${label} is inside <${parent.name}>, a plain HTML element: left as a normal attribute (web component slot?)`);
      return;
    }

    const dynamic = !!slotAttr && slotAttr.name !== 'slot';
    const slotName = slotAttr && slotAttr.value ? slotAttr.value : 'default';
    if (hasVSlot(parent)) {
      ctx.review(line, 'component v-slot', `<${parent.name}> already has v-slot on itself: move it to a <template v-slot> before adding the "${slotName}" slot`);
      return;
    }

    candidates.push({
      tag, isTemplate, scopeAttr, slotAttr, dynamic, slotName, parent, line,
      key: `${parent.start}:${dynamic ? `[${slotName}]` : slotName}`
    });
  });

  const isCandidate = tag => candidates.some(o => o.tag === tag);

  // a v-if / v-else chain only survives if every branch ends up as a slot template
  const checkChain = (c, conditionMoved) => {
    const siblings = childrenOf(c.parent);
    const i = siblings.indexOf(c.tag);
    const prev = siblings[i - 1];
    const next = siblings[i + 1];
    const brokenBefore = hasAttr(c.tag, CONTINUES_CHAIN) && (!conditionMoved || !prev || !isCandidate(prev));
    const brokenAfter = !!next && hasAttr(next, CONTINUES_CHAIN) && (!conditionMoved || !isCandidate(next));
    if (brokenBefore || brokenAfter) {
      ctx.review(c.line, 'v-if chain', 'this v-if / v-else chain mixes slots with other content: Vue 3 needs every branch to be a <template v-slot>, restructure it by hand');
    }
  };

  const convert = c => {
    const before = src.slice(c.tag.start, c.tag.end);
    const directive = directiveFor(c, c.dynamic ? c.slotName : renamedSlot(c.parent, c.slotName));
    const rule = c.scopeAttr ? 'slot-scope → v-slot' : 'slot → v-slot';

    if (c.isTemplate) {
      const openText = removeAttrs(src, c.tag, [c.scopeAttr, c.slotAttr].filter(Boolean));
      const at = 1 + c.tag.name.length;
      const replacement = `${openText.slice(0, at)} ${directive}${openText.slice(at)}`;
      edits.push({ start: c.tag.start, end: c.tag.end, text: replacement, order: 1 });
      ctx.fix(c.line, rule, before, replacement);
      checkChain(c, true);
      return;
    }

    const closeEnd = closeEndOf(c.tag);
    if (closeEnd === null) {
      ctx.review(c.line, 'unclosed', `no closing </${c.tag.name}> found: convert it by hand`);
      return;
    }
    const hoisted = hoistedAttrs(c);
    const openText = removeAttrs(src, c.tag, [c.scopeAttr, c.slotAttr, ...hoisted].filter(Boolean));
    const wrapper = [directive, ...hoisted.map(a => src.slice(a.start, a.end))].join(' ');
    const replacement = `<template ${wrapper}>${openText}`;
    edits.push({ start: c.tag.start, end: c.tag.end, text: replacement, order: 1 });
    edits.push({ start: closeEnd, end: closeEnd, text: '</template>', order: 0 });
    ctx.fix(c.line, rule, before, `${replacement}...</template>`);
    checkChain(c, hoisted.some(a => CONDITION.test(a.name)));

    // Vue 3 rejects an explicit default slot next to loose children (Vue 2 ignored those children).
    if (c.slotName === 'default' && !c.dynamic) {
      const others = childrenOf(c.parent).filter(t => t !== c.tag && !isCandidate(t) && !hasVSlot(t));
      if (others.length) {
        ctx.review(c.line, 'loose children', `<${c.parent.name}> has other children next to this default slot (Vue 2 ignored them): Vue 3 rejects that, move or delete them`);
      }
    }
  };

  const groups = new Map();
  candidates.forEach(c => {
    if (!groups.has(c.key)) groups.set(c.key, []);
    groups.get(c.key).push(c);
  });

  const merges = [];
  groups.forEach(group => {
    const first = group[0];

    // unscoped default content: the attribute is redundant
    if (!first.dynamic && first.slotName === 'default' && group.every(c => !c.scopeAttr)) {
      group.forEach(c => {
        const text = removeAttrs(src, c.tag, [c.slotAttr]);
        edits.push({ start: c.tag.start, end: c.tag.end, text, order: 1 });
        ctx.fix(c.line, 'slot="default"', src.slice(c.tag.start, c.tag.end), text);
      });
      return;
    }

    if (group.length === 1) {
      convert(first);
      return;
    }

    if (first.dynamic || group.some(c => c.scopeAttr)) {
      group.forEach(c => ctx.review(c.line, 'duplicate slot', `${group.length} elements target slot "${c.slotName}" and at least one is scoped or dynamic: combine them into one <template v-slot> by hand`));
      return;
    }

    merges.push(group);
  });

  // merge elements sharing a named slot, innermost components first so nested changes travel with them
  merges.sort((a, b) => b[0].parent.start - a[0].parent.start).forEach(group => {
    const [first, ...others] = group;
    const ends = group.map(c => closeEndOf(c.tag));
    if (ends.some(end => end === null)) {
      group.forEach(c => ctx.review(c.line, 'unclosed', 'could not find the closing tag: merge this slot by hand'));
      return;
    }

    const directive = `v-slot:${renamedSlot(first.parent, first.slotName)}`;
    const openText = removeAttrs(src, first.tag, [first.slotAttr]);
    let insertAt;
    if (first.isTemplate) {
      const at = 1 + first.tag.name.length;
      edits.push({ start: first.tag.start, end: first.tag.end, text: `${openText.slice(0, at)} ${directive}${openText.slice(at)}`, order: 1 });
      insertAt = src.lastIndexOf('</', ends[0] - 1);
    } else {
      edits.push({ start: first.tag.start, end: first.tag.end, text: `<template ${directive}>${openText}`, order: 1 });
      edits.push({ start: ends[0], end: ends[0], text: '</template>', order: 0 });
      insertAt = ends[0];
    }

    const indent = indentOf(src, first.tag.start);
    let moved = '';
    others.forEach((o, n) => {
      const end = ends[n + 1];
      // the moved element keeps its own changes and loses its slot attribute
      edits.push({ start: o.tag.start, end: o.tag.end, text: removeAttrs(src, o.tag, [o.slotAttr]), order: 1 });
      const inner = takeEdits(edits, o.tag.start, end).map(e => Object.assign({}, e, { start: e.start - o.tag.start, end: e.end - o.tag.start }));
      moved += `\n${indent}${applyEdits(src.slice(o.tag.start, end), inner)}`;
      const [removeStart, removeEnd] = expandToLines(src, o.tag.start, end);
      edits.push({ start: removeStart, end: removeEnd, text: '', order: 1 });
    });
    edits.push({ start: insertAt, end: insertAt, text: moved, order: -1 });

    ctx.fix(first.line, 'merge slot', `${group.length} × slot="${first.slotName}" (lines ${group.map(c => c.line).join(', ')})`, `one <template ${directive}>`);
  });

  // slot names BootstrapVueNext renamed, on templates already using v-slot / #
  tags.forEach(tag => {
    if (tag.name.toLowerCase() !== 'template') return;
    const parent = parentOf(tag);
    if (!parent) return;
    tag.attrs.forEach(attr => {
      const m = /^(#|v-slot:)([\w-]+)$/.exec(attr.name);
      if (!m) return;
      const renamed = renamedSlot(parent, m[2]);
      if (renamed === m[2]) return;
      const to = m[1] + renamed;
      edits.push({ start: attr.start, end: attr.start + attr.name.length, text: to, order: 1 });
      ctx.fix(ctx.lineOf(attr.start), 'slot name', `${attr.name} on <${parent.name}>`, to);
    });
  });

  // slot data that changed in BootstrapVueNext
  const usages = candidates.filter(c => c.scopeAttr && !c.dynamic).map(c => ({ component: c.parent, tag: c.tag, slot: c.slotName, scope: c.scopeAttr.value }));
  tags.forEach(tag => {
    tag.attrs.forEach(attr => {
      const m = /^(?:#|v-slot:?)([\w-]*)$/.exec(attr.name);
      if (!m || attr.value === null) return;
      const component = tag.name.toLowerCase() === 'template' ? parentOf(tag) : tag;
      if (component) usages.push({ component, tag, slot: m[1] || 'default', scope: attr.value });
    });
  });
  usages.forEach(({ component, tag, slot, scope }) => {
    SCOPE_REVIEWS.filter(r => r.slot === slot && r.components.includes(kebab(component.name))).forEach(rule => {
      const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(scope);
      const used = id
        ? src.slice(tag.end, closeEndOf(tag) || tag.end).includes(`${id[1]}.${rule.variable}`)
        : new RegExp(`(^|[^\\w$])${rule.variable}($|[^\\w$])`).test(scope);
      if (used) ctx.review(ctx.lineOf(tag.start), 'slot data', `<${component.name}>: ${rule.message}`);
    });
  });

  return edits;
}

// ─── regions ─────────────────────────────────────────────────────────────────

function backtickRegions(source, from, to) {
  const regions = [];
  const literal = /`(?:\\[\s\S]|\$\{(?:[^{}]|\{[^{}]*\})*\}|[^`\\$]|\$(?!\{))*`/g;
  for (const m of source.slice(from, to).matchAll(literal)) {
    if (/<[A-Za-z]/.test(m[0])) regions.push([from + m.index + 1, from + m.index + m[0].length - 1]);
  }

  return regions;
}

/**
 * Template markup ranges and script ranges of a file.
 */
function regionsOf(source, ext, review) {
  if (ext === '.html') return { templates: [[0, source.length]], scripts: [] };
  if (ext !== '.vue') return { templates: backtickRegions(source, 0, source.length), scripts: [[0, source.length]] };

  const templates = [];
  const scripts = [];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    const tag = /[A-Za-z]/.test(source[lt + 1] || '') ? parseOpenTag(source, lt) : null;
    if (!tag) {
      i = lt + 1;
      continue;
    }

    const name = tag.name.toLowerCase();
    if (name === 'template') {
      const end = findCloseEnd(source, tag);
      if (end === null) break;
      const lang = tag.attrs.find(a => a.name === 'lang');
      if (!lang || lang.value === 'html') templates.push([tag.end, source.lastIndexOf('</', end)]);
      else review(tag.start, 'template lang', `<template lang="${lang.value}"> skipped: only HTML templates are converted`);
      i = end;
    } else if (name === 'script' || name === 'style') {
      const close = source.indexOf(`</${name}`, tag.end);
      const end = close === -1 ? source.length : close;
      if (name === 'script') {
        scripts.push([tag.end, end]);
        templates.push(...backtickRegions(source, tag.end, end));
      }
      i = end + name.length + 3;
    } else {
      i = tag.end;
    }
  }

  return { templates, scripts };
}

// ─── script rules ────────────────────────────────────────────────────────────

const SCRIPT_FIXES = [
  { pattern: /\$scopedSlots\b/g, replace: '$slots', rule: '$scopedSlots → $slots' }
];

const SCRIPT_REVIEWS = [
  {
    pattern: /(?<![\w$])scopedSlots\s*[:=]/g,
    rule: 'render scopedSlots',
    message: 'Vue 3 h(): pass slots as the third argument, e.g. h(Comp, props, { default: p => ... })'
  },
  {
    pattern: /\.scopedSlots\b/g,
    rule: 'render scopedSlots',
    message: 'there is no `scopedSlots` here in Vue 3: slots live in `slots` / `$slots`'
  },
  {
    pattern: /\bslot\s*:\s*['"`]/g,
    rule: 'render slot',
    message: 'Vue 3 h(): the slot name is a key of the parent\'s slots object, not `slot:` in the child\'s data'
  },
  {
    pattern: /\bcontext\.slots\s*\(/g,
    rule: 'functional slots',
    message: 'Vue 3 functional components get slots in the second argument: (props, { slots })'
  },
  {
    pattern: /(?<![\w-])slot(?:-scope)?=(?=["'{\\])/g,
    rule: 'slot in string/JSX',
    message: 'slot attribute in JSX or a quoted template string, which this script does not parse: convert it by hand'
  }
];

// `$slots.x` used where Vue 2 had a VNode array; Vue 3 slots are functions.
const SLOT_ACCESS = /\$slots(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"]+)\2\s*\])/g;

function isSlotCallOrCheck(text, index, length) {
  const after = text.slice(index + length, index + length + 40);
  const before = text.slice(Math.max(0, index - 120), index).replace(/(this|vm|ctx|_ctx|self)\.$/, '');
  if (/^\s*(\(|\?\.\()/.test(after)) return true; // called
  if (/(!|typeof\s)\s*$/.test(before)) return true; // !this.$slots.x / typeof
  if (/^\s*(&&|\|\|(?!\s*\[)|\?(?!\.)|===?|!==?)/.test(after)) return true; // condition (`|| []` is a value fallback)
  if (/(if|while)\s*\(\s*$/.test(before) && /^\s*\)/.test(after)) return true; // if (this.$slots.x)
  if (/(v-if|v-else-if|v-show)\s*=\s*["']\s*$/.test(before) && /^\s*["']/.test(after)) return true; // v-if="$slots.x"
  if (/(&&|\|\|)\s*$/.test(before) && /^\s*["']/.test(after)) return true; // v-if="a && $slots.x"
  if (/:class\s*=\s*["'][^"']*$/.test(before)) return true; // :class="{ on: $slots.x }"

  return false;
}

// ─── per file ────────────────────────────────────────────────────────────────

/**
 * Migrates one file's source. Returns the new source plus the fix / review items.
 */
function migrateSlots(source, { filename = 'file.vue' } = {}) {
  const ext = path.extname(filename).toLowerCase();
  const lineOf = lineIndex(source);
  const fixes = [];
  const reviews = [];
  const ctx = {
    fix: (line, rule, from, to) => fixes.push({ line, rule, from: short(from), to: short(to) }),
    review: (line, rule, message) => reviews.push({ line, rule, message })
  };

  const { templates, scripts } = regionsOf(source, ext, (pos, rule, message) => ctx.review(lineOf(pos), rule, message));
  const inTemplate = pos => templates.some(([s, e]) => pos >= s && pos < e);

  const edits = [];
  templates.forEach(([start, end]) => {
    templateEdits(source.slice(start, end), Object.assign({}, ctx, { lineOf: i => lineOf(start + i) }))
      .forEach(e => edits.push(Object.assign({}, e, { start: e.start + start, end: e.end + start })));
  });

  let output = applyEdits(source, edits, edit => {
    ctx.review(lineOf(edit.start), 'overlap', 'two changes touch the same tag: this one was skipped, review it by hand');
  });

  SCRIPT_FIXES.forEach(({ pattern, replace, rule }) => {
    for (const m of source.matchAll(pattern)) ctx.fix(lineOf(m.index), rule, m[0], replace);
    output = output.replace(pattern, replace);
  });

  scripts.forEach(([start, end]) => {
    const text = source.slice(start, end);
    SCRIPT_REVIEWS.forEach(({ pattern, rule, message }) => {
      for (const m of text.matchAll(pattern)) {
        if (!inTemplate(start + m.index)) ctx.review(lineOf(start + m.index), rule, message);
      }
    });
    for (const m of text.matchAll(SLOT_ACCESS)) {
      if (inTemplate(start + m.index) || isSlotCallOrCheck(text, m.index, m[0].length)) continue;
      ctx.review(lineOf(start + m.index), '$slots value', `Vue 3 slots are functions: where VNodes are expected use this.$slots.${m[1] || m[3]}?.()`);
    }
  });

  // templates use $slots too: `$slots.x.length`, `$slots.x[0]`, `v-for="n in $slots.x"`
  templates.forEach(([start, end]) => {
    const text = source.slice(start, end);
    for (const m of text.matchAll(SLOT_ACCESS)) {
      if (isSlotCallOrCheck(text, m.index, m[0].length)) continue;
      ctx.review(lineOf(start + m.index), '$slots value', `Vue 3 slots are functions: where VNodes are expected use $slots.${m[1] || m[3]}?.()`);
    }
  });

  const byLine = (a, b) => a.line - b.line;

  return { output, fixes: fixes.sort(byLine), reviews: reviews.sort(byLine) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function collectFiles(inputs) {
  const files = [];
  const walk = target => {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      fs.readdirSync(target).forEach(entry => {
        if (!SKIP_DIRS.has(entry)) walk(path.join(target, entry));
      });
    } else if (EXTENSIONS.has(path.extname(target).toLowerCase())) {
      files.push(target);
    }
  };
  inputs.forEach(input => walk(path.resolve(input)));

  return files;
}

/**
 * Formats paths relative to the current folder, or to the scanned folder when it lives elsewhere.
 */
function pathReporter(inputs) {
  const roots = inputs.map(input => path.resolve(input)).filter(input => fs.statSync(input).isDirectory());

  return file => {
    const fromCwd = path.relative(process.cwd(), file);
    if (fromCwd && !fromCwd.startsWith('..') && !path.isAbsolute(fromCwd)) return fromCwd;
    const root = roots.find(r => !path.relative(r, file).startsWith('..'));

    return root ? path.relative(root, file) : file;
  };
}

function run(argv, log = console.log) {
  const write = argv.includes('--write');
  const inputs = argv.filter(arg => !arg.startsWith('--'));
  if (!inputs.length || argv.includes('--help')) {
    log('Usage: node migrate-slots.mjs [--write] <file-or-dir>...');
    log('  Without --write nothing is changed: the planned fixes and the review items are printed.');
    return inputs.length ? 0 : 1;
  }

  const missing = inputs.filter(input => !fs.existsSync(input));
  if (missing.length) {
    log(`Path not found: ${missing.join(', ')}`);
    return 1;
  }

  const files = collectFiles(inputs);
  const rel = pathReporter(inputs);

  let fixCount = 0;
  let reviewCount = 0;
  let changedFiles = 0;
  files.forEach(file => {
    const source = fs.readFileSync(file, 'utf8');
    const { output, fixes, reviews } = migrateSlots(source, { filename: file });
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
    ? `Applied ${fixCount} slot fix(es) in ${changedFiles} file(s). ${reviewCount} item(s) need a manual review.`
    : `Dry run: ${fixCount} slot fix(es) in ${changedFiles} file(s) would be applied (rerun with --write). ${reviewCount} item(s) need a manual review.`);

  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}

export {
  migrateSlots,
  run,
  templateEdits as slotTemplateEdits,
  regionsOf,
  collectTags,
  findCloseEnd,
  applyEdits,
  kebab,
  short,
  lineIndex,
  collectFiles,
  pathReporter
};
