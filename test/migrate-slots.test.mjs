import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '@vue/compiler-dom';
import { migrateSlots, run } from '../migrate-slots.mjs';
import { migrateSource } from '../migrate-to-vue3.mjs';


// The migrated template must be valid for the Vue 3 compiler.
const compileErrors = template => {
  const errors = [];
  compile(template, { onError: e => errors.push(e.message), onWarn: () => {} });

  return errors;
};

const migrate = (source, filename = 'x.html') => migrateSlots(source, { filename });

describe('template slot syntax', () => {
  test('slot-scope on an element is wrapped in <template v-slot>', () => {
    const { output, fixes } = migrate(`<ValidationProvider rules="required"><div slot-scope="{ errors }"><input v-model="v">{{ errors[0] }}</div></ValidationProvider>`);

    assert.strictEqual(output, `<ValidationProvider rules="required"><template v-slot="{ errors }"><div><input v-model="v">{{ errors[0] }}</div></template></ValidationProvider>`);
    assert.deepStrictEqual(fixes.map(f => f.rule), ['slot-scope → v-slot']);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('templates, named + scoped, dynamic names, old `scope`, single quotes, nesting', () => {
    const { output } = migrate(`<Obs>
  <div slot-scope="{ invalid }">
    <Prov><template scope="ctx">{{ ctx.errors }}</template></Prov>
    <List>
      <template slot="item" slot-scope='{ item }'>{{ item.name }}</template>
      <i :slot="dynamicName">x</i>
    </List>
  </div>
</Obs>`);

    assert.strictEqual(output, `<Obs>
  <template v-slot="{ invalid }"><div>
    <Prov><template v-slot="ctx">{{ ctx.errors }}</template></Prov>
    <List>
      <template v-slot:item='{ item }'>{{ item.name }}</template>
      <template v-slot:[dynamicName]><i>x</i></template>
    </List>
  </div></template>
</Obs>`);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('`>` inside attribute values and multi-line tags', () => {
    const { output } = migrate(`<Comp>
  <div
    v-if="count > 1"
    slot="header"
    class="a">H</div>
</Comp>`);

    assert.strictEqual(output, `<Comp>
  <template v-slot:header v-if="count > 1"><div
    class="a">H</div></template>
</Comp>`);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('v-for and v-if land where the slot still works', () => {
    // the slot name reads the loop variable, so the loop must surround the slot
    const wrapper = migrate(`<Inner><slot v-for="(_, n) in $slots" :name="n" :slot="n" /></Inner>`);
    assert.strictEqual(wrapper.output, `<Inner><template v-slot:[n] v-for="(_, n) in $slots"><slot :name="n" /></template></Inner>`);
    assert.deepStrictEqual(compileErrors(wrapper.output), []);

    // a static slot with v-for still renders several elements into that one slot
    const list = migrate(`<Comp><li v-for="i in 3" slot="x">{{ i }}</li></Comp>`);
    assert.strictEqual(list.output, `<Comp><template v-slot:x><li v-for="i in 3">{{ i }}</li></template></Comp>`);
    assert.deepStrictEqual(compileErrors(list.output), []);

    // v-if / v-else across slots moves to the templates, Vue 3 rejects it otherwise
    const chain = migrate(`<Comp><div v-if="a" slot="x">1</div><div v-else-if="b" slot="y">2</div><div v-else slot="z">3</div></Comp>`);
    assert.strictEqual(chain.output, `<Comp><template v-slot:x v-if="a"><div>1</div></template><template v-slot:y v-else-if="b"><div>2</div></template><template v-slot:z v-else><div>3</div></template></Comp>`);
    assert.deepStrictEqual(chain.reviews, []);
    assert.deepStrictEqual(compileErrors(chain.output), []);

    // with slot-scope the condition may read the slot data, so it stays inside
    const scoped = migrate(`<Comp><div slot-scope="p" v-if="p.ok">1</div></Comp>`);
    assert.strictEqual(scoped.output, `<Comp><template v-slot="p"><div v-if="p.ok">1</div></template></Comp>`);
    assert.deepStrictEqual(compileErrors(scoped.output), []);
  });

  test('tags with escaped quotes are reported, never rewritten', () => {
    // the source files contain <p slot=\"a\">, a template inside a JS string
    const source = 'const a = { template: `<Comp>' +
      '<p slot=\\"a\\">1</p>' +
      '<div slot-scope=\\"{ errors }\\">{{ errors }}</div>' +
      '<b v-if=\\"x > 1\\" slot=\\"c\\">3</b>' +
      '</Comp>` };';
    const { output, fixes, reviews } = migrate(source, 'comp.js');

    assert.strictEqual(output, source);
    assert.deepStrictEqual(fixes, []);
    assert.deepStrictEqual(reviews.map(r => r.rule), ['escaped quotes', 'escaped quotes', 'escaped quotes']);

    // doubly escaped: a string inside a string
    const nested = 'const a = "const b = `<Comp><p slot=\\\\\\"a\\\\\\">1</p></Comp>`";';
    assert.strictEqual(migrate(nested, 'comp.js').output, nested);
  });

  test('a v-if chain mixing a slot with other content is flagged', () => {
    const { reviews } = migrate(`<Comp><div v-if="a" slot="x">1</div><div v-else>2</div></Comp>`);

    assert.deepStrictEqual(reviews.map(r => r.rule), ['v-if chain']);
  });

  test('slot="default" without a scope just loses the attribute', () => {
    const { output, fixes } = migrate(`<Comp><p slot="default">a</p><p>b</p><template slot="default">c</template></Comp>`);

    assert.strictEqual(output, `<Comp><p>a</p><p>b</p><template>c</template></Comp>`);
    assert.deepStrictEqual(fixes.map(f => f.rule), ['slot="default"', 'slot="default"']);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('several elements for one named slot are merged in order, other content stays put', () => {
    const { output, fixes } = migrate(`<Card>
  <h3 slot="header">Title</h3>
  <p>Body</p>
  <small slot="header">Subtitle</small>
  <b-button slot="footer">OK</b-button>
</Card>`);

    assert.strictEqual(output, `<Card>
  <template v-slot:header><h3>Title</h3>
  <small>Subtitle</small></template>
  <p>Body</p>
  <template v-slot:footer><b-button>OK</b-button></template>
</Card>`);
    assert.deepStrictEqual(fixes.map(f => f.rule), ['merge slot', 'slot → v-slot']);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('merged elements keep the changes made inside them, and a <template> can lead the merge', () => {
    const { output } = migrate(`<Layout>
  <template slot="aside">A</template>
  <section slot="aside">
    <Prov><div slot-scope="{ errors }">{{ errors[0] }}</div></Prov>
  </section>
</Layout>`);

    assert.strictEqual(output, `<Layout>
  <template v-slot:aside>A
  <section>
    <Prov><template v-slot="{ errors }"><div>{{ errors[0] }}</div></template></Prov>
  </section></template>
</Layout>`);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('cases that need a decision are reported and left unchanged', () => {
    const source = `<div>
  <Comp>
    <p slot="x" slot-scope="a">1</p>
    <p slot="x">2</p>
  </Comp>
  <div><span slot="label">native</span></div>
  <Comp><template v-if="show"><b slot="title">t</b></template></Comp>
  <Comp v-slot="outer"><b slot="title">t</b></Comp>
  <Comp><template slot="y" v-slot:y>both</template></Comp>
</div>`;
    const { output, reviews } = migrate(source);

    assert.strictEqual(output, source);
    assert.deepStrictEqual(reviews.map(r => [r.line, r.rule]), [
      [3, 'duplicate slot'],
      [4, 'duplicate slot'],
      [6, 'native parent'],
      [7, 'nested template'],
      [8, 'component v-slot'],
      [9, 'mixed syntax']
    ]);
  });

  test('a scoped default slot next to loose children is converted and flagged', () => {
    const { output, reviews } = migrate(`<Prov><div slot-scope="ctx">x</div><span>loose</span></Prov>`);

    assert.strictEqual(output, `<Prov><template v-slot="ctx"><div>x</div></template><span>loose</span></Prov>`);
    assert.deepStrictEqual(reviews.map(r => r.rule), ['loose children']);
  });

  test('<th scope> and pug templates are left alone', () => {
    const table = `<table><tr><th scope="col">A</th></tr></table>`;
    assert.strictEqual(migrate(table).output, table);

    const pug = `<template lang="pug">\ndiv(slot-scope="x")\n</template>\n`;
    const result = migrate(pug, 'x.vue');
    assert.strictEqual(result.output, pug);
    assert.deepStrictEqual(result.reviews.map(r => r.rule), ['template lang']);
  });
});

describe('BootstrapVue slots', () => {
  test('renamed slots, in every syntax, only on the component that renamed them', () => {
    const { output, fixes } = migrate(`<div>
  <b-modal>
    <div slot="modal-title">T</div>
    <template #modal-footer="{ ok }">F</template>
    <template v-slot:modal-header-close>x</template>
  </b-modal>
  <BAlert><template #dismiss>x</template></BAlert>
  <b-toast><template slot="toast-title" slot-scope="t">{{ t.id }}</template></b-toast>
  <b-table><template v-slot:emptyfiltered>none</template></b-table>
  <MyDialog><template #modal-footer>kept</template></MyDialog>
  <b-card><template #dismiss>kept</template></b-card>
</div>`);

    assert.strictEqual(output, `<div>
  <b-modal>
    <template v-slot:title><div>T</div></template>
    <template #footer="{ ok }">F</template>
    <template v-slot:header-close>x</template>
  </b-modal>
  <BAlert><template #close>x</template></BAlert>
  <b-toast><template v-slot:title="t">{{ t.id }}</template></b-toast>
  <b-table><template v-slot:empty-filtered>none</template></b-table>
  <MyDialog><template #modal-footer>kept</template></MyDialog>
  <b-card><template #dismiss>kept</template></b-card>
</div>`);
    assert.strictEqual(fixes.length, 6);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('changed slot data is reported, with destructuring or a slot variable', () => {
    const { reviews } = migrate(`<div>
  <b-collapse v-slot="{ close, visible }">x</b-collapse>
  <b-collapse><div slot-scope="c">{{ c.close }}</div></b-collapse>
  <b-table><template #table-colgroup="{ columns }">c</template></b-table>
  <b-form-file><template #drop-placeholder="d">{{ d.dropAllowed }}</template></b-form-file>
  <b-form-tags v-slot="{ inputHandlers }">t</b-form-tags>
  <b-collapse v-slot="{ hide, visible }">unchanged</b-collapse>
  <my-thing v-slot="{ close }">other component</my-thing>
</div>`);

    assert.deepStrictEqual(reviews.map(r => [r.line, r.rule]), [[2, 'slot data'], [3, 'slot data'], [4, 'slot data'], [5, 'slot data'], [6, 'slot data']]);
  });
});

describe('script slot APIs', () => {
  test('$slots values in templates are reported, conditions are not', () => {
    const { reviews } = migrate(`<div>
  <p v-if="$slots.a">1</p>
  <p v-if="!$slots.b">2</p>
  <p v-if="x && $slots.c">3</p>
  <p :class="{ on: $slots.d }">4</p>
  <p v-if="$slots.e && $slots.e.length">5</p>
  <p v-for="n in $slots.f">6</p>
  <p>{{ $slots.g[0] }}</p>
  <component :is="() => $slots.h()" />
</div>`);

    assert.deepStrictEqual(reviews.map(r => [r.line, r.rule]), [[6, '$slots value'], [7, '$slots value'], [8, '$slots value']]);
  });

  test('JSX, quoted template strings and array fallbacks are reported', () => {
    const { output, reviews } = migrate(`const a = <Comp scopedSlots={{ default: p => p }}><span slot="x" /></Comp>;
const b = vm.$vnode.data.scopedSlots;
const c = '<C><p slot="y"></p></C>';
const d = this.$slots.default || [];
const e = this.$scopedSlots.item({ a: 1 });`, 'c.jsx');

    assert.ok(output.includes('const e = this.$slots.item({ a: 1 });'));
    assert.deepStrictEqual(reviews.map(r => [r.line, r.rule]), [
      [1, 'render scopedSlots'],
      [1, 'slot in string/JSX'],
      [2, 'render scopedSlots'],
      [3, 'slot in string/JSX'],
      [4, '$slots value']
    ]);
  });

  test('$scopedSlots → $slots, $slots values and render-function slot data are reported', () => {
    const source = `<template><div v-if="$slots.header"><slot name="header" /></div></template>
<script>
export default {
  render (h) {
    const hasFooter = !!this.$slots.footer;
    if (this.$slots.aside) {}
    const items = this.$scopedSlots.item({ a: 1 });
    return h('div', { scopedSlots: { default: p => p } }, [
      this.$slots.default,
      h('span', { slot: 'title' }, 'x'),
      this.$slots['footer']
    ]);
  },
  functional: true
};
const Fn = (h, context) => context.slots().default;
</script>`;
    const { output, fixes, reviews } = migrate(source, 'Comp.vue');

    assert.ok(output.includes('this.$slots.item({ a: 1 })'));
    assert.deepStrictEqual(fixes.map(f => [f.line, f.rule]), [[7, '$scopedSlots → $slots']]);
    assert.deepStrictEqual(reviews.map(r => [r.line, r.rule]), [
      [8, 'render scopedSlots'],
      [9, '$slots value'],
      [10, 'render slot'],
      [11, '$slots value'],
      [16, 'functional slots']
    ]);
  });

  test('templates inside JS strings are converted, their $slots checks are not reported', () => {
    const { output, reviews } = migrate("export default { template: `<Comp v-if=\"$slots.a\"><p slot=\"a\">x</p></Comp>` };", 'comp.js');

    assert.strictEqual(output, "export default { template: `<Comp v-if=\"$slots.a\"><template v-slot:a><p>x</p></template></Comp>` };");
    assert.deepStrictEqual(reviews, []);
  });
});

describe('CLI and interplay with migrate-to-vue3', () => {
  test('dry run, --write, second run is a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vee-slots-'));
    const file = path.join(dir, 'Form.vue');
    const original = `<template>\n  <Card>\n    <h3 slot="header">A</h3>\n    <p slot="header">B</p>\n  </Card>\n</template>\n`;
    fs.writeFileSync(file, original);
    const logs = [];
    const log = line => logs.push(line);

    run([dir], log);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
    assert.ok(logs.join('\n').includes('Dry run: 1 slot fix(es) in 1 file(s)'));

    run(['--write', dir], log);
    const migrated = fs.readFileSync(file, 'utf8');
    assert.strictEqual(migrated, `<template>\n  <Card>\n    <template v-slot:header><h3>A</h3>\n    <p>B</p></template>\n  </Card>\n</template>\n`);

    logs.length = 0;
    run(['--write', dir], log);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), migrated);
    assert.ok(logs.join('\n').includes('Applied 0 slot fix(es) in 0 file(s)'));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('running the slot script first, then migrate-to-vue3, gives the same modal result', () => {
    const source = `<template><b-modal hide-footer><div slot="modal-title">T</div></b-modal></template>`;
    const slotsFirst = migrateSource(migrateSlots(source, { filename: 'M.vue' }).output, { filename: 'M.vue' }).output;
    const migrateOnly = migrateSource(source, { filename: 'M.vue' }).output;

    assert.strictEqual(slotsFirst, `<template><b-modal no-footer><template v-slot:title><div>T</div></template></b-modal></template>`);
    assert.strictEqual(migrateOnly, slotsFirst);
  });
});
