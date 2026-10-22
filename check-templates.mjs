#!/usr/bin/env node
/**
 * check-templates: compiles every .vue template in a Vue 3 project and lists each error with file and
 * line, including the ones Vue's build hides behind "Codegen node is missing for element/if/for node"
 * (it stops at the first broken file and drops the real message).
 *
 *   node check-templates.mjs [project-dir]
 *
 * Uses the project's own Vue 3 compiler, so run npm install first. Node 18+, no dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] ?? '.');
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);

let vueRequire;
try {
  vueRequire = createRequire(createRequire(path.join(root, 'package.json')).resolve('vue/package.json'));
} catch {
  console.error(`No vue package found from ${root}: run npm install there first.`);
  process.exit(1);
}
const { version } = vueRequire('./package.json');
if (!version.startsWith('3.')) {
  console.error(`The installed vue is ${version}: this checks Vue 3 templates.`);
  process.exit(1);
}
const { parse } = vueRequire('@vue/compiler-sfc');
const { compile, parse: parseTemplate } = vueRequire('@vue/compiler-dom');

// <template #name> elements that are not a direct child of a component: what makes Vue's compiler crash.
function misplacedSlots(node, out = []) {
  for (const c of node.children ?? []) {
    const slot = c.type === 1 && c.tag === 'template' && c.props.find(p => p.type === 7 && p.name === 'slot');
    if (slot && !(node.type === 1 && node.tagType === 1)) out.push({ el: c, name: slot.arg?.content ?? 'default' });
    misplacedSlots(c, out);
  }
  return out;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !SKIP.has(e.name)) yield* walk(p);
    } else if (e.name.endsWith('.vue')) {
      yield p;
    }
  }
}

let files = 0;
let broken = 0;
for (const file of walk(root)) {
  files++;
  const rel = path.relative(root, file).split(path.sep).join('/');
  const { descriptor, errors } = parse(fs.readFileSync(file, 'utf8'), { filename: file });
  const tpl = descriptor.template;
  const found = errors.map(e => ({ line: e.loc?.start.line, msg: e.message, src: e.loc?.source }));
  if (tpl && !tpl.lang && !tpl.src) {
    const base = tpl.loc.start.line - 1;
    const collected = [];
    let crash = null;
    try {
      compile(tpl.content, { onError: e => collected.push(e) });
    } catch (e) {
      crash = e;
    }
    for (const e of collected) found.push({ line: e.loc && base + e.loc.start.line, msg: e.message, src: e.loc?.source });
    if (crash && !collected.length) {
      const slots = misplacedSlots(parseTemplate(tpl.content));
      for (const { el, name } of slots) {
        found.push({ line: base + el.loc.start.line, msg: `<template #${name}> is not a direct child of a component (Vue reports this as "${crash.message.split('\n')[0]}").`, src: el.loc.source });
      }
      if (!slots.length) found.push({ line: base + 1, msg: `Vue's compiler crashed: ${crash.message.split('\n')[0]}` });
    }
  }
  if (!found.length) continue;
  broken++;
  console.log(`\n${rel}`);
  for (const f of found) {
    console.log(`  ${f.line ? `${rel}:${f.line}` : rel}  ${f.msg}`);
    if (f.src) console.log(`      ${f.src.split('\n')[0].trim().slice(0, 140)}`);
  }
}
console.log(`\n${files} .vue files checked, ${broken} with template errors.`);
process.exitCode = broken ? 1 : 0;
