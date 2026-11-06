import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '@vue/compiler-dom';
import { migrateSource, detectNames, run } from '../migrate-typeahead.mjs';


// The migrated template must be valid for the Vue 3 compiler.
const compileErrors = template => {
  const errors = [];
  compile(template, { onError: e => errors.push(e.message), onWarn: () => {} });

  return errors;
};

const migrate = (source, filename = 'x.html', names) => migrateSource(source, { filename, names });
const rules = items => items.map(i => i.rule);
const ROW = `<template #item="{ item, itemProjection, boldMatchText }">
    <span v-html="boldMatchText(itemProjection(item).replace(/</g, '\\u0026lt;').replace(/>/g, '\\u0026gt;'))"></span>
  </template>`;

describe('props', () => {
  test('renames data, serializer, maxMatches and minMatchingChars in every spelling', () => {
    const { output } = migrate(`<vue-bootstrap-typeahead :data="a" :max-matches="3" :min-matching-chars="1" />
<VueBootstrapTypeahead v-bind:data="a" :maxMatches="3" :minMatchingChars="1"></VueBootstrapTypeahead>`);

    assert.match(output, /<vue-bootstrap-typeahead :items="a" :max-items="3" :min-input-length="1"/);
    assert.match(output, /<VueBootstrapTypeahead v-bind:items="a" :maxItems="3" :minInputLength="1"/);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('keeps the Vue 2 limit of 10 rows and the list width, unless a limit is set', () => {
    const none = migrate('<vue-bootstrap-typeahead :data="a" />').output;
    assert.match(none, /:items="a" :max-items="10" dropdown-menu-class="dropdown-menu w-100">/);

    const own = migrate('<vue-bootstrap-typeahead :data="a" :max-matches="3" />').output;
    assert.strictEqual(own.match(/max-items/g).length, 1);
  });

  test('new attributes follow the layout of a multi-line tag', () => {
    const { output } = migrate(`<vue-bootstrap-typeahead
  :data="a"
  placeholder="x"
/>`);

    assert.ok(output.startsWith(`<vue-bootstrap-typeahead
  :items="a"
  placeholder="x"
  :max-items="10"
  dropdown-menu-class="dropdown-menu w-100">`));
  });

  test('input-class keeps form-control, which the new prop would replace', () => {
    assert.match(migrate('<vue-bootstrap-typeahead :data="a" input-class="is-invalid" />').output, /input-class="form-control is-invalid"/);

    const bound = migrate(`<vue-bootstrap-typeahead :data="a" :input-class="bad ? 'is-invalid' : ''" />`).output;
    assert.ok(bound.includes(`:input-class="'form-control ' + (bad ? 'is-invalid' : '')"`));
    assert.deepStrictEqual(compileErrors(bound), []);
  });

  test('size goes into input-class', () => {
    assert.match(migrate('<vue-bootstrap-typeahead :data="a" size="lg" />').output, /:items="a" input-class="form-control form-control-lg"/);
    assert.match(migrate('<vue-bootstrap-typeahead :data="a" size="sm" input-class="x" />').output, /input-class="form-control form-control-sm x"/);

    const bound = migrate('<vue-bootstrap-typeahead :data="a" :size="s" />');
    assert.ok(bound.output.includes(':size="s"'));
    assert.ok(rules(bound.reviews).includes('size'));
  });

  test('variants become dropdown-item-class, bound ones are reported', () => {
    const { output, reviews } = migrate('<vue-bootstrap-typeahead :data="a" background-variant="dark" text-variant="white" />');
    assert.match(output, /dropdown-item-class="dropdown-item bg-dark text-white"/);
    assert.ok(!output.includes('variant'));
    assert.ok(reviews.some(r => r.rule === 'background-variant' && r.message.includes('.active')));

    const bound = migrate('<vue-bootstrap-typeahead :data="a" :text-variant="c" />');
    assert.ok(bound.output.includes(':text-variant="c"'));
    assert.ok(rules(bound.reviews).includes('text-variant'));
  });

  test('prepend and append are reported, as props or slots', () => {
    const props = migrate('<vue-bootstrap-typeahead :data="a" prepend="$" append="USD" />').reviews;
    assert.ok(rules(props).includes('prepend'));
    assert.ok(rules(props).includes('append'));

    const slots = migrate('<vue-bootstrap-typeahead :data="a"><template #prepend><b>$</b></template></vue-bootstrap-typeahead>').reviews;
    assert.ok(rules(slots).includes('prepend'));
  });

  test('v-bind objects are reported', () => {
    assert.ok(rules(migrate('<vue-bootstrap-typeahead v-bind="opts" />').reviews).includes('v-bind object'));
  });
});

describe('serializer', () => {
  test('an inline arrow function becomes null-safe', () => {
    const { output } = migrate('<vue-bootstrap-typeahead :data="a" :serializer="s => s.name" />');

    assert.ok(output.includes(`:item-projection="s => (s == null ? '' : s.name)"`));
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('uses the other quote in a single-quoted attribute', () => {
    const { output } = migrate(`<vue-bootstrap-typeahead :data='a' :serializer='s => s.name' />`);

    assert.ok(output.includes(`:item-projection='s => (s == null ? "" : s.name)'`));
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('a method name is renamed and reported', () => {
    const { output, reviews } = migrate('<vue-bootstrap-typeahead :data="a" :serializer="format" />');

    assert.ok(output.includes(':item-projection="format"'));
    assert.ok(rules(reviews).includes('item-projection'));
  });

  test('optional chaining is already null-safe', () => {
    const { output, reviews } = migrate('<vue-bootstrap-typeahead :data="a" :serializer="s => s?.name" />');

    assert.ok(output.includes(':item-projection="s => s?.name"'));
    assert.ok(!rules(reviews).includes('item-projection'));
  });
});

describe('v-model and hit', () => {
  test('string items keep v-model as the typed text', () => {
    const { output, reviews } = migrate(`<vue-bootstrap-typeahead v-model="q" :data="a" />`);

    assert.match(output, /allow-new immediate>/);
    assert.ok(!rules(reviews).includes('v-model'));
  });

  test('object items are reported, naming the @hit target', () => {
    const { output, reviews } = migrate(`<vue-bootstrap-typeahead v-model="q" :data="a" :serializer="s => s.n" @hit="picked = $event" />`);

    assert.ok(!output.includes('allow-new'));
    const review = reviews.find(r => r.rule === 'v-model');
    assert.ok(review.message.includes('v-model="picked"'));
  });

  test('@hit next to a text v-model is reported', () => {
    assert.ok(rules(migrate(`<vue-bootstrap-typeahead v-model="q" :data="a" @hit="go" />`).reviews).includes('hit'));
  });

  test('@hit="x = $event" alone becomes v-model', () => {
    const { output, reviews } = migrate(`<vue-bootstrap-typeahead :data="a" @hit="form.city = $event" />`);

    assert.ok(output.includes('v-model="form.city"'));
    assert.ok(!output.includes('@hit'));
    assert.ok(!rules(reviews).includes('hit'));
  });

  test('@hit="method" alone is reported', () => {
    const { output, reviews } = migrate(`<vue-bootstrap-typeahead :data="a" @hit="go" />`);

    assert.ok(output.includes('@hit="go"'));
    assert.ok(rules(reviews).includes('hit'));
  });

  test(':value and @input follow the Vue 3 contract', () => {
    const { output } = migrate(`<vue-bootstrap-typeahead :value="q" @input="q = $event" :data="a" />`);

    assert.ok(output.includes(':model-value="q"'));
    assert.ok(output.includes('@update:model-value="q = $event"'));
    assert.match(output, /allow-new immediate>/);
  });

  test('fetching in a watcher is reported, an unrelated watcher is not', () => {
    const tag = `<template><vue-bootstrap-typeahead v-model="q" :data="a" /></template>`;
    const fetched = `${tag}<script>export default { watch: { q: debounce(function (v) { this.load(v) }, 300) } }</script>`;
    const other = `${tag}<script>export default { watch: { page () {} }, data: () => ({ q: '' }) }</script>`;

    assert.ok(rules(migrate(fetched, 'x.vue').reviews).includes('items array'));
    assert.ok(!rules(migrate(other, 'x.vue').reviews).includes('items array'));
  });
});

describe('rows', () => {
  test('a self-closed tag gets the escaping slot and a closing tag', () => {
    const { output, fixes } = migrate('<div>\n  <vue-bootstrap-typeahead :data="a" />\n</div>');

    assert.ok(output.includes(`dropdown-menu-class="dropdown-menu w-100">
    <template #item="{ item, itemProjection, boldMatchText }">
      <span v-html="boldMatchText(itemProjection(item).replace(/</g, '\\u0026lt;').replace(/>/g, '\\u0026gt;'))"></span>
    </template>
  </vue-bootstrap-typeahead>
</div>`));
    assert.ok(rules(fixes).includes('escape suggestions'));
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('an empty element gets the slot too', () => {
    const { output } = migrate('<vue-bootstrap-typeahead :data="a"></vue-bootstrap-typeahead>');

    assert.ok(output.endsWith(`>\n  ${ROW}\n</vue-bootstrap-typeahead>`));
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('the escape survives the compiler decoding attribute entities', () => {
    const { output } = migrate('<vue-bootstrap-typeahead :data="a" />');
    const { code } = compile(output);

    assert.ok(code.includes('\\u0026lt;'));
    assert.ok(!output.includes('&lt;'));
  });

  test('a template in a JS string keeps the escape for the runtime compiler', () => {
    const { output } = migrate('export default { template: `<vue-bootstrap-typeahead :data="a" />` }', 'x.js');

    assert.ok(output.includes("'\\\\u0026lt;'"));
  });

  test('#suggestion with destructuring keeps the body working', () => {
    const { output } = migrate(`<vue-bootstrap-typeahead :data="a">
  <template #suggestion="{ data, htmlText }"><span v-html="htmlText"></span> <small>{{ data.code }}</small></template>
</vue-bootstrap-typeahead>`);

    assert.ok(output.includes(`<template #item="{ item: data, itemProjection, boldMatchText }"><span v-html="boldMatchText(itemProjection(data).replace(/</g, '\\u0026lt;').replace(/>/g, '\\u0026gt;'))"></span> <small>{{ data.code }}</small></template>`));
    assert.strictEqual(output.match(/#item/g).length, 1);
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('v-slot:suggestion, aliases and data alone', () => {
    const alias = migrate(`<vue-bootstrap-typeahead :data="a"><template v-slot:suggestion="{ data: row }">{{ row.x }}</template></vue-bootstrap-typeahead>`).output;
    assert.ok(alias.includes(`<template v-slot:item="{ item: row }">{{ row.x }}</template>`));
    assert.deepStrictEqual(compileErrors(alias), []);
  });

  test('htmlText alone, in a single-quoted attribute', () => {
    const { output } = migrate(`<vue-bootstrap-typeahead :data="a"><template #suggestion="{ htmlText }"><b v-html='htmlText'></b></template></vue-bootstrap-typeahead>`);

    assert.ok(output.includes(`#item="{ item, itemProjection, boldMatchText }"`));
    assert.ok(output.includes(`.replace(/</g, "\\u0026lt;")`));
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('a scope object has its fields rewritten', () => {
    const { output } = migrate(`<vue-bootstrap-typeahead :data="a"><template #suggestion="s"><b v-html="s.htmlText"></b>{{ s.data.code }}</template></vue-bootstrap-typeahead>`);

    assert.ok(output.includes(`#item="s"`));
    assert.ok(output.includes(`s.boldMatchText(s.itemProjection(s.item).replace(`));
    assert.ok(output.includes('{{ s.item.code }}'));
    assert.deepStrictEqual(compileErrors(output), []);
  });

  test('what it cannot rewrite stays and is reported', () => {
    const whole = migrate(`<vue-bootstrap-typeahead :data="a"><template #suggestion="s"><my-row v-bind="s" /></template></vue-bootstrap-typeahead>`);
    assert.ok(whole.output.includes('#suggestion="s"'));
    assert.ok(rules(whole.reviews).includes('suggestion slot'));

    const clash = migrate(`<vue-bootstrap-typeahead :data="a"><template #suggestion="{ htmlText }"><b v-html="htmlText"></b>{{ item }}</template></vue-bootstrap-typeahead>`);
    assert.ok(clash.output.includes('#suggestion="{ htmlText }"'));
    assert.ok(rules(clash.reviews).includes('suggestion slot'));
  });

  test('old slot syntax asks for migrate-slots first and adds no second slot', () => {
    const { output, reviews } = migrate(`<vue-bootstrap-typeahead :data="a"><template slot="suggestion" slot-scope="{ data }">{{ data }}</template></vue-bootstrap-typeahead>`);

    assert.ok(reviews.some(r => r.rule === 'suggestion slot' && r.message.includes('migrate-slots')));
    assert.ok(!output.includes('#item'));
  });
});

describe('package references', () => {
  test('imports and source or dist paths move to the new package', () => {
    const { output } = migrate(`import A from 'vue-bootstrap-typeahead'
import B from "vue-bootstrap-typeahead/src/components/VueBootstrapTypeahead.vue"
const C = require('vue-bootstrap-typeahead/dist/VueBootstrapTypeahead.umd.min.js')
`, 'x.js');

    assert.strictEqual(output, `import A from 'vue3-bootstrap-typeahead'
import B from "vue3-bootstrap-typeahead"
const C = require('vue3-bootstrap-typeahead')
`);
  });

  test('the stylesheet import is removed, other paths are reported', () => {
    const { output, reviews } = migrate(`import 'vue-bootstrap-typeahead/dist/VueBootstrapTypeahead.css'

import L from 'vue-bootstrap-typeahead/src/components/VueBootstrapTypeaheadList.vue'
`, 'x.js');

    assert.ok(output.startsWith("\nimport L from 'vue-bootstrap-typeahead/src/"));
    assert.deepStrictEqual(rules(reviews), ['deep import']);
  });

  test('a stylesheet in a <style> block is reported', () => {
    const { reviews } = migrate(`<style>@import '~vue-bootstrap-typeahead/dist/VueBootstrapTypeahead.css';</style>`, 'x.vue');

    assert.deepStrictEqual(rules(reviews), ['package css']);
  });

  test('old classes, async imports, CDN links and global registration are reported', () => {
    const { reviews } = migrate(`import T from 'vue-bootstrap-typeahead'
Vue.component('typeahead', T)
Vue.component('other-thing', Other)
const lazy = () => import('vue-bootstrap-typeahead')
el.querySelector('.vbst-item')
const cdn = 'https://unpkg.com/vue-bootstrap-typeahead'
`, 'x.js');

    assert.deepStrictEqual(rules(reviews), ['global registration', 'async component', 'old css class', 'cdn']);
  });
});

describe('finding the component', () => {
  test('import names, registered names and async components', () => {
    assert.deepStrictEqual(detectNames(`import Picker from 'vue-bootstrap-typeahead'
export default { components: { CityBox: Picker, 'state-box': Picker } }`).sort(), ['city-box', 'picker', 'state-box']);
    assert.deepStrictEqual(detectNames(`Vue.component('my-box', T); import T from 'vue-bootstrap-typeahead/src/components/VueBootstrapTypeahead'`).sort(), ['my-box', 't']);
    assert.deepStrictEqual(detectNames(`export default { components: { Lazy: () => import('vue-bootstrap-typeahead') } }`), ['lazy']);
    assert.deepStrictEqual(detectNames(`import T from 'other'; h('div', T)`), []);
  });

  test('other components are left alone', () => {
    const source = '<b-form-input :data="a" size="lg" /><my-select :data="b" />';

    assert.strictEqual(migrate(source).output, source);
  });

  test('a registered name from another file counts', () => {
    assert.match(migrate('<city-box :data="a" />', 'x.html', ['city-box']).output, /:items="a"/);
  });

  test('running twice changes nothing more', () => {
    const once = migrate(`<vue-bootstrap-typeahead v-model="q" :data="a" :serializer="s => s.n" size="lg" />`);
    const twice = migrate(once.output);

    assert.strictEqual(twice.output, once.output);
    assert.deepStrictEqual(twice.fixes, []);
  });

  test('a tag already on the new API is skipped', () => {
    const source = '<vue-bootstrap-typeahead v-model="q" :items="a" />';

    assert.strictEqual(migrate(source).output, source);
  });
});

describe('other reviews', () => {
  test('a form around the input is reported', () => {
    const inForm = migrate('<form @submit="go"><vue-bootstrap-typeahead :data="a" /></form>').reviews;
    const after = migrate('<form></form><vue-bootstrap-typeahead :data="a" />').reviews;

    assert.ok(rules(inForm).includes('enter key'));
    assert.ok(!rules(after).includes('enter key'));
  });

  test('uses of its template ref are reported with their line', () => {
    const { reviews } = migrate(`<template><vue-bootstrap-typeahead ref="box" :data="a" /></template>
<script>
export default { methods: { reset () { this.$refs.box.inputValue = '' } } }
</script>`, 'x.vue');

    assert.deepStrictEqual(reviews.filter(r => r.rule === 'template ref').map(r => r.line), [3]);
  });

  test('pug templates are reported', () => {
    const { reviews } = migrate('<template lang="pug">vue-bootstrap-typeahead</template>', 'x.vue');

    assert.ok(rules(reviews).includes('template lang'));
  });
});

describe('CLI', () => {
  const tempProject = files => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-typeahead-'));
    Object.entries(files).forEach(([name, text]) => fs.writeFileSync(path.join(dir, name), text));

    return dir;
  };
  const MAIN = `import T from 'vue-bootstrap-typeahead'\nVue.component('city-box', T)\n`;
  const PAGE = '<template><city-box v-model="q" :data="a" /></template>\n';

  test('a dry run changes nothing and a global name reaches other files', () => {
    const dir = tempProject({ 'main.js': MAIN, 'Page.vue': PAGE });
    const lines = [];

    assert.strictEqual(run([dir], line => lines.push(line)), 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Page.vue'), 'utf8'), PAGE);
    assert.ok(lines.join('\n').includes(':data  →  :items'));
    assert.ok(lines.join('\n').includes('Dry run'));
  });

  test('--write applies the changes and the output compiles', () => {
    const dir = tempProject({ 'main.js': MAIN, 'Page.vue': PAGE });
    const lines = [];

    assert.strictEqual(run(['--write', dir], line => lines.push(line)), 0);
    const page = fs.readFileSync(path.join(dir, 'Page.vue'), 'utf8');
    assert.ok(page.includes(':items="a"'));
    assert.deepStrictEqual(compileErrors(page.slice('<template>'.length, page.lastIndexOf('</template>'))), []);
    assert.ok(fs.readFileSync(path.join(dir, 'main.js'), 'utf8').includes("'vue3-bootstrap-typeahead'"));
    assert.ok(lines.join('\n').includes('npm install vue3-bootstrap-typeahead'));
  });

  test('usage and missing paths', () => {
    const lines = [];

    assert.strictEqual(run([], line => lines.push(line)), 1);
    assert.ok(lines[0].startsWith('Usage'));
    assert.strictEqual(run(['nope-not-here'], () => {}), 1);
  });
});
