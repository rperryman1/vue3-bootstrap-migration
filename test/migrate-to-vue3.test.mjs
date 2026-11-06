import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '@vue/compiler-dom';
import { migrateSource, run } from '../migrate-to-vue3.mjs';


// The migrated template must be valid for the Vue 3 compiler.
const compileErrors = template => {
  const errors = [];
  compile(template, { onError: e => errors.push(e.message), onWarn: () => {} });

  return errors;
};

const migrate = (source, filename = 'x.html', contracts) => migrateSource(source, { filename, contracts });

describe('slot-scope / slot → v-slot', () => {
  test('wraps a slot-scope element in <template v-slot>', () => {
    const { output, fixes } = migrate(`<ValidationProvider rules="required"><div slot-scope="{ errors }"><input v-model="v"><span>{{ errors[0] }}</span></div></ValidationProvider>`);

    assert.strictEqual(output, `<ValidationProvider rules="required"><template v-slot="{ errors }"><div><input v-model="v"><span>{{ errors[0] }}</span></div></template></ValidationProvider>`);
    assert.strictEqual(fixes.length, 1);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('nested slot-scope elements', () => {
    const { output } = migrate(`<Obs>
  <div slot-scope="{ invalid }">
    <Prov><div slot-scope="ctx"><input v-model="v"></div></Prov>
    <p>{{ invalid }}</p>
  </div>
</Obs>`);

    assert.strictEqual(output, `<Obs>
  <template v-slot="{ invalid }"><div>
    <Prov><template v-slot="ctx"><div><input v-model="v"></div></template></Prov>
    <p>{{ invalid }}</p>
  </div></template>
</Obs>`);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('<template slot-scope> keeps its element, named and dynamic slots, single quotes', () => {
    const { output } = migrate(`<Comp>
  <template slot-scope="props">{{ props.a }}</template>
</Comp>
<Comp>
  <template slot="footer" slot-scope='{ ok }'><b @click="ok">ok</b></template>
  <span slot="header">Title</span>
  <i :slot="name">x</i>
</Comp>`);

    assert.strictEqual(output, `<Comp>
  <template v-slot="props">{{ props.a }}</template>
</Comp>
<Comp>
  <template v-slot:footer='{ ok }'><b @click="ok">ok</b></template>
  <template v-slot:header><span>Title</span></template>
  <template v-slot:[name]><i>x</i></template>
</Comp>`);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('`>` inside attribute values and multi-line tags do not break parsing', () => {
    const { output } = migrate(`<Comp>
  <div
    v-if="count > 1"
    slot-scope="{ errors }"
    class="a">{{ errors }}</div>
</Comp>`);

    assert.strictEqual(output, `<Comp>
  <template v-slot="{ errors }"><div
    v-if="count > 1"
    class="a">{{ errors }}</div></template>
</Comp>`);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('elements sharing one slot name are merged, using the migrate-slots engine', () => {
    const { output, reviews } = migrate(`<Comp><p slot="footer">a</p><p slot="footer">b</p></Comp>`);

    assert.strictEqual(output, `<Comp><template v-slot:footer><p>a</p>\n<p>b</p></template></Comp>`);
    assert.deepStrictEqual(reviews, []);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('<th scope> is left alone', () => {
    const source = `<table><tr><th scope="col">A</th></tr></table>`;

    assert.strictEqual(migrate(source).output, source);
  });
});

describe('<b-modal> → <BModal>', () => {
  test('renames props, v-model and slots, reports removed props', () => {
    const { output, fixes, reviews } = migrate(`<b-modal id="m" hide-footer :hide-header-close="locked" titleSrOnly no-enforce-focus auto-focus-button="ok" :visible="open" @change="onChange" static title-html="<b>x</b>">
  <template #modal-title="{ close }">T</template>
  <template v-slot:modal-header-close>x</template>
  <div slot="modal-footer">F</div>
  <p>body</p>
</b-modal>`);

    assert.strictEqual(output, `<b-modal id="m" no-footer :no-header-close="locked" titleVisuallyHidden no-trap focus="ok" :model-value="open" @update:model-value="onChange" static title-html="<b>x</b>">
  <template #title="{ close }">T</template>
  <template v-slot:header-close>x</template>
  <template v-slot:footer><div>F</div></template>
  <p>body</p>
</b-modal>`);
    assert.strictEqual(fixes.length, 10);
    assert.deepStrictEqual(reviews.map(r => r.rule), ['b-modal static', 'b-modal title-html']);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('BModal spelling, .sync and the compiled v-model event name', () => {
    const { output } = migrate(`<BModal :visible.sync="open" hideBackdrop><template #modal-ok>Save</template></BModal>`);

    assert.strictEqual(output, `<BModal v-model="open" noBackdrop><template #ok>Save</template></BModal>`);
    const code = compile(`<BModal :model-value="a" @update:model-value="b" />`).code;
    assert.ok(code.includes('"onUpdate:modelValue"'));
  });

  test('escaped quotes: slots are reported, and text inside values is not mistaken for props', () => {
    const source = 'const a = { template: `<b-modal title=\\"hide-footer now\\" hide-footer><div slot=\\"modal-title\\">T</div></b-modal>` };';
    const { output, reviews } = migrate(source, 'comp.js');

    assert.strictEqual(output, 'const a = { template: `<b-modal title=\\"hide-footer now\\" no-footer><div slot=\\"modal-title\\">T</div></b-modal>` };');
    assert.deepStrictEqual(reviews.map(r => r.rule), ['escaped quotes']);
  });

  test('`modal-*` slots of other components are not renamed', () => {
    const source = `<MyDialog><template #modal-header>x</template></MyDialog>`;

    assert.strictEqual(migrate(source).output, source);
  });

  test('script code: headerclose trigger, event type, $bvModal and $root events', () => {
    const source = `<script>
import { BvModalEvent } from 'bootstrap-vue';
export default {
  methods: {
    onHide (e: BvModalEvent) { if (e.trigger === 'headerclose') e.preventDefault(); },
    open () { this.$bvModal.show('m'); },
    async confirm () { return this.$bvModal.msgBoxConfirm('Sure?'); },
    tell () { this.$root.$emit('bv::hide::modal', 'm'); },
    target (e) { return e.vueTarget; }
  },
  mounted () { this.$root.$on('bv::modal::shown', () => {}); }
};
</script>`;
    const { output, fixes, reviews } = migrate(source, 'Comp.vue');

    assert.ok(output.includes(`import { BvTriggerableEvent } from 'bootstrap-vue';`));
    assert.ok(output.includes(`e.trigger === 'close'`));
    assert.deepStrictEqual(fixes.map(f => [f.line, f.rule]), [[2, 'modal event type'], [5, 'modal trigger'], [5, 'modal event type']]);
    assert.deepStrictEqual(reviews.map(r => r.rule), ['$bvModal.show', '$bvModal.msgBoxConfirm', 'bv::hide::modal', 'vueTarget', 'bv::modal::shown']);
  });
});

describe('vee-validate', () => {
  test('reports Vue.use(VeeValidate) and components on the Vue 2 v-model contract', () => {
    const component = migrate(`<template><input :value="value" @input="$emit('input', $event.target.value)"></template>
<script>
export default { props: ['value'] };
</script>`, 'TextInput.vue');
    assert.deepStrictEqual(component.reviews.map(r => r.rule), ['v-model contract']);

    const contracts = new Map([['text-input', { where: 'src/TextInput.vue:1' }]]);
    const usage = migrate(`<template>
  <TextInput v-model="name" v-validate="'required'" />
  <text-input :value="x" />
</template>
<script>
Vue.use(VeeValidate, { events: 'blur' });
</script>`, 'Form.vue', contracts);
    assert.deepStrictEqual(usage.reviews, [
      { line: 2, rule: 'v-model contract', message: '<TextInput v-model> needs src/TextInput.vue:1 updated to modelValue / update:modelValue' },
      { line: 6, rule: 'Vue.use(VeeValidate)', message: 'Vue 3: createApp(App).use(VeeValidate, options)' }
    ]);
  });

  test('templates inside JS template literals', () => {
    const { output } = migrate("export default { template: `<VP><div slot-scope=\"{ errors }\">{{ errors[0] }}</div></VP>` };", 'comp.js');

    assert.strictEqual(output, "export default { template: `<VP><template v-slot=\"{ errors }\"><div>{{ errors[0] }}</div></template></VP>` };");
  });
});

describe('CLI', () => {
  test('dry run changes nothing, --write applies, second run is a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vee-migrate-'));
    const file = path.join(dir, 'Form.vue');
    const original = `<template>\n  <b-modal hide-footer><div slot="modal-title">T</div></b-modal>\n</template>\n`;
    fs.writeFileSync(file, original);
    const logs = [];
    const log = line => logs.push(line);

    run([dir], log);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
    assert.ok(logs.join('\n').includes('Dry run: 2 fix(es) in 1 file(s)'));

    run(['--write', dir], log);
    const migrated = fs.readFileSync(file, 'utf8');
    assert.strictEqual(migrated, `<template>\n  <b-modal no-footer><template v-slot:title><div>T</div></template></b-modal>\n</template>\n`);

    logs.length = 0;
    run(['--write', dir], log);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), migrated);
    assert.ok(logs.join('\n').includes('Applied 0 fix(es) in 0 file(s)'));

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
