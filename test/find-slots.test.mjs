import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../find-slots.mjs';
import { migrateSlots } from '../migrate-slots.mjs';


describe('find-slots report', () => {
  let dir;
  let form;
  let list;
  let clean;
  let logs;
  const log = line => logs.push(line);
  const output = () => logs.join('\n');

  const FORM = `<template>
  <div>
    <b-modal>
      <div slot="modal-title">T</div>
    </b-modal>
    <ValidationProvider>
      <div slot-scope="{ errors }">{{ errors[0] }}</div>
    </ValidationProvider>
    <p>{{ $slots.note[0] }}</p>
  </div>
</template>
`;
  const LIST = `<script>
export default {
  render (h) {
    return h('div', this.$scopedSlots.item({ a: 1 }));
  }
};
</script>
`;
  const CLEAN = `<template><Comp v-slot="{ a }">{{ a }}</Comp></template>\n`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vee-find-'));
    form = path.join(dir, 'Form.vue');
    list = path.join(dir, 'List.vue');
    clean = path.join(dir, 'Clean.vue');
    fs.writeFileSync(form, FORM);
    fs.writeFileSync(list, LIST);
    fs.writeFileSync(clean, CLEAN);
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('lists every change as file:line, split into auto and manual, with totals', () => {
    assert.strictEqual(run([dir], log), 0);

    const text = output();
    assert.match(text, /Form\.vue:4\s+auto\s+slot → v-slot\s+<div slot="modal-title">\s+→\s+<template v-slot:title><div>/);
    assert.match(text, /Form\.vue:7\s+auto\s+slot-scope → v-slot/);
    assert.match(text, /Form\.vue:9\s+manual\s+\$slots value/);
    assert.ok(text.includes('> <p>{{ $slots.note[0] }}</p>'));
    assert.match(text, /List\.vue:4\s+auto\s+\$scopedSlots → \$slots/);
    assert.ok(!text.includes('Clean.vue'));
    assert.ok(text.includes('4 slot change(s) in 2 of 3 file(s) scanned. Nothing was changed.'));
    assert.match(text, /auto\s+3 /);
    assert.match(text, /manual\s+1 /);
    assert.ok(text.includes('By type:'));
  });

  test('--manual shows only what has to be done by hand', () => {
    assert.strictEqual(run(['--manual', dir], log), 0);

    const text = output();
    assert.match(text, /Form\.vue:9\s+manual/);
    assert.doesNotMatch(text, /\bauto\b/);
    assert.ok(text.includes('1 slot change(s) in 1 of 3 file(s) scanned.'));
  });

  test('never modifies a file', () => {
    const before = [form, list, clean].map(f => fs.statSync(f).mtimeMs);

    run([dir], log);
    run(['--manual', dir], log);

    assert.strictEqual(fs.readFileSync(form, 'utf8'), FORM);
    assert.strictEqual(fs.readFileSync(list, 'utf8'), LIST);
    assert.strictEqual(fs.readFileSync(clean, 'utf8'), CLEAN);
    assert.deepStrictEqual([form, list, clean].map(f => fs.statSync(f).mtimeMs), before);
    assert.doesNotMatch(fs.readFileSync(new URL('../find-slots.mjs', import.meta.url), 'utf8'), /writeFile|appendFile|unlink|rmSync/);
  });

  test('reports the same changes migrate-slots would make', () => {
    const { fixes } = migrateSlots(FORM, { filename: form });
    run([form], log);

    fixes.forEach(fix => {
      assert.ok(output().includes(`Form.vue:${fix.line}`));
    });
    assert.strictEqual(fixes.length, 2);
  });

  test('clean projects, missing paths and no arguments', () => {
    assert.strictEqual(run([clean], log), 0);
    assert.ok(output().includes('No slot changes found in 1 file(s) scanned.'));

    logs = [];
    assert.strictEqual(run([path.join(dir, 'nope')], log), 1);
    assert.ok(output().includes('Path not found'));

    logs = [];
    assert.strictEqual(run([], log), 1);
    assert.ok(output().includes('Usage:'));
  });
});
