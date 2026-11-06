# vue3-bootstrap-migration

Scripts for moving a Vue 2 + BootstrapVue app to Vue 3 + BootstrapVueNext. They need Node 18+ and have no dependencies.

| Script | What it does |
|---|---|
| `bs5-migrate.mjs` | The main codemod: Bootstrap 4 classes, BootstrapVue props, events, components and imports, Sass helpers |
| `migrate-slots.mjs` | Converts Vue 2 slot syntax and the slots BootstrapVueNext renamed |
| `find-slots.mjs` | Read-only list of every slot change needed, as `file:line` |
| `migrate-to-vue3.mjs` | The remaining `<b-modal>` renames, plus a review list (`$bvModal`, old `v-model` components, `Vue.use(VeeValidate)`) |
| `migrate-typeahead.mjs` | Moves `vue-bootstrap-typeahead` usages to `vue3-bootstrap-typeahead`, plus a review list |
| `check-templates.mjs` | Compiles every `.vue` template and lists each error with its file and line |

[docs/typeahead-vue2-vs-vue3.md](docs/typeahead-vue2-vs-vue3.md) compares the two typeahead packages.

## Run order

Run `migrate-slots.mjs` **before** `bs5-migrate.mjs`, and commit between steps. `bs5-migrate.mjs` refuses to run with uncommitted changes.

1. See the slot changes, with your app committed:

   ```bash
   node find-slots.mjs ../my-app/src
   ```

2. Convert the slots, then commit in your app:

   ```bash
   node migrate-slots.mjs --write ../my-app/src
   ```

3. Run the main codemod, then commit in your app:

   ```bash
   node bs5-migrate.mjs ../my-app --write
   ```

4. Apply the remaining `<b-modal>` renames:

   ```bash
   node migrate-to-vue3.mjs --write ../my-app/src
   ```

5. If the app uses `vue-bootstrap-typeahead`, convert it:

   ```bash
   node migrate-typeahead.mjs --write ../my-app/src
   ```

6. List the slot changes left to do by hand:

   ```bash
   node find-slots.mjs --manual ../my-app/src
   ```

7. Check that every template compiles, after running `npm install` in your app:

   ```bash
   node check-templates.mjs ../my-app
   ```

Without `--write`, the `migrate` scripts and `bs5-migrate.mjs` only report what they would change. `find-slots.mjs` never changes files.

### Why slots go first

On the same sample, `bs5-migrate.mjs` on its own currently differs from `migrate-slots.mjs` here:

| Vue 2 | `bs5-migrate.mjs` | `migrate-slots.mjs` |
|---|---|---|
| Two elements with `slot="header"` | Two `<template #header>`, which Vue 3 rejects | Merged into one template |
| `<div slot-scope="x">` with no `slot` attribute | Left unchanged, not reported | Converted |
| `v-for` with `:slot="name"` | Left unchanged, reported | Converted, with the loop moved to the template |
| `modal-backdrop`, `dismiss`, `toast-title`, `emptyfiltered` slots | Left unchanged | Renamed |
| `$scopedSlots` | Reported | Converted |
| `$slots.x.length`, `$slots.x` passed as a value | Not reported | Reported |

## migrate-slots.mjs

Scans `.vue`, `.html`, `.js` and `.ts` files, skipping `node_modules` and `dist`. It works on its own, so you can copy it into any project.

```bash
node migrate-slots.mjs ../my-app/src
```

```bash
node migrate-slots.mjs --write ../my-app/src
```

**Fixed automatically:**

| Vue 2 | Vue 3 |
|---|---|
| `<div slot-scope="x">` | `<template v-slot="x"><div>` |
| `<template slot-scope="x">` / `<template scope="x">` | `<template v-slot="x">` |
| `<span slot="name">` (+ `slot-scope="x"`) | `<template v-slot:name="x"><span>` |
| `<i :slot="expr">` | `<template v-slot:[expr]><i>` |
| `slot="default"` without a scope | Attribute removed (it already is default content) |
| Several elements with `slot="name"` (Vue 2 combined them) | Merged into one `<template v-slot:name>`, in their original order |
| `this.$scopedSlots` | `this.$slots` |
| `<b-modal>` slots | `modal-title` → `title`, `modal-header` → `header`, `modal-header-close` → `header-close`, `modal-footer` → `footer`, `modal-ok` → `ok`, `modal-cancel` → `cancel`, `modal-backdrop` → `backdrop` |
| `<b-alert>` / `<b-toast>` / `<b-table>` slots | `dismiss` → `close`, `toast-title` → `title`, `emptyfiltered` → `empty-filtered` |

`v-if` / `v-else` on a slot element without a scope moves to the `<template v-slot>`, so the slot doesn't exist when the condition is false. With `slot-scope` it stays on the element, because it may read the slot data. `v-for` moves to the template when the slot name is dynamic, because the name may read the loop variable.

**Reported for review:**

- `$slots.x` used as a VNode array, in scripts or templates (`$slots.x.length`, `$slots.x[0]`, `v-for="n in $slots.x"`, `this.$slots.x || []`): Vue 3 slots are functions, so call `$slots.x?.()`. Calls and conditions like `v-if="$slots.x"` aren't reported.
- Render functions and JSX: `scopedSlots` in `h()` data or JSX, `slot:` in `h()` data, functional components' `context.slots()`, and `slot=` in JSX or quoted template strings.
- Slot data that changed in BootstrapVueNext: `close` → `hide` on `<b-collapse>`, `columns` on `<b-table>`'s `table-colgroup`, `dropAllowed` on `<b-form-file>`'s `drop-placeholder`, and `inputHandlers` on `<b-form-tags>`.
- Template cases that need a decision:
  - a slot inside a plain `<template v-if>`;
  - a slot under a native HTML element (probably a web-component `slot` attribute);
  - a component that already has its own `v-slot`;
  - duplicate scoped or dynamic slots;
  - a scoped default slot next to loose children (Vue 3 rejects that);
  - a `v-if` / `v-else` chain mixing a slot with other content (Vue 3 rejects that);
  - a slot written with escaped quotes (`slot=\"x\"`) in a template string;
  - `<template lang="pug">`.

The BootstrapVue slot lists come from BootstrapVueNext's migration guide, so a change the guide doesn't mention won't be found. Slots on your own components aren't checked for renames. Line numbers refer to the files before the run, and running it twice is safe. It parses tags itself rather than using a full Vue parser, so check the output of unusual templates.

## find-slots.mjs

Only reports: it can't change any files. It uses the same rules as `migrate-slots.mjs`, so keep the two in the same folder. Every row is `file:line`.

```bash
node find-slots.mjs ../my-app/src
```

```bash
node find-slots.mjs --manual ../my-app/src
```

- `auto` rows are what `migrate-slots.mjs --write` would change.
- `manual` rows are changes you make yourself, shown with the source line.
- `--manual` shows only the `manual` rows.

It ends with totals by type. Some `manual` rows can be false alarms, such as slot-like text inside an ordinary string, so check them against the source line.

## migrate-to-vue3.mjs

Needs `migrate-slots.mjs` next to it, because it uses that script's template slot conversion.

```bash
node migrate-to-vue3.mjs ../my-app/src
```

```bash
node migrate-to-vue3.mjs --write ../my-app/src
```

**Fixed automatically** (`fix` lines):

| Change | Example |
|---|---|
| Template slots | The same conversion as `migrate-slots.mjs` |
| `<b-modal>` props | `hide-header-close` → `no-header-close`, `hide-footer` → `no-footer`, `hide-header` → `no-header`, `hide-backdrop` → `no-backdrop`, `no-enforce-focus` → `no-trap`, `title-sr-only` → `title-visually-hidden`, `auto-focus-button` → `focus` |
| `<b-modal>` v-model | `:visible` → `:model-value`, `:visible.sync` → `v-model`, `@change` → `@update:model-value` |
| Modal event code | `'headerclose'` → `'close'`, `BvModalEvent` → `BvTriggerableEvent` |

Prop renames only apply on `<b-modal>` / `<BModal>`.

**Reported for review** (`review` lines, never changed):

- Removed `<b-modal>` props: `static`, `return-focus`, `ignore-enforce-focus-selector`, `header-close-content`, `title-html`, `ok-title-html`, `cancel-title-html`, `header-tag`, `footer-tag`, `aria-label`, `no-stacking`. Each line names the replacement.
- `$bvModal.show/hide/msgBoxOk/msgBoxConfirm`, `$root.$emit('bv::show::modal')` and `$root.$on('bv::modal::...')`, and `.vueTarget`.
- `Vue.use(VeeValidate)`.
- Components still on the Vue 2 `v-model` contract (`value` prop + `$emit('input')`, or a `model` option), plus every place they're used with `v-model`.

It doesn't update modal defaults set outside a `<b-modal>` tag: `Vue.use(BootstrapVue, { BModal: {...} })`, objects passed with `v-bind`, or `msgBox` options.

## migrate-typeahead.mjs

Needs `migrate-slots.mjs` and `migrate-to-vue3.mjs` next to it, because it uses their helpers. Run it after `migrate-slots.mjs`, which converts the old `slot="suggestion"` syntax it expects.

```bash
node migrate-typeahead.mjs ../my-app/src
```

```bash
node migrate-typeahead.mjs --write ../my-app/src
```

The two packages share no code, so where it can, it keeps the Vue 2 behavior rather than just renaming things. [docs/typeahead-vue2-vs-vue3.md](docs/typeahead-vue2-vs-vue3.md) explains each difference. It finds the component by its import name and the names it's registered under, including global registration in another file, and leaves the tag name as it is.

**Fixed automatically** (`fix` lines):

| Vue 2 | Vue 3 |
|---|---|
| `from 'vue-bootstrap-typeahead'`, plus its `src/` and `dist/*.js` paths | `from 'vue3-bootstrap-typeahead'` |
| `import '.../VueBootstrapTypeahead.css'` | Removed: the new package has no stylesheet |
| `data`, `maxMatches`, `minMatchingChars`, `serializer` | `items`, `maxItems`, `minInputLength`, `itemProjection` |
| `:serializer="s => s.name"` | `:item-projection="s => (s == null ? '' : s.name)"`, because it's also called on an empty model |
| `input-class="x"` | `input-class="form-control x"`, because the new prop replaces `form-control` |
| `size="lg"` | `form-control-lg` in `input-class` |
| `background-variant="dark" text-variant="white"` | `dropdown-item-class="dropdown-item bg-dark text-white"` |
| No `max-matches` | `:max-items="10"`, the old default |
| A list as wide as the input | `dropdown-menu-class="dropdown-menu w-100"` |
| `v-model` with string items | Adds `allow-new immediate`, so the model is still the typed text |
| `:value`, `@input` | `:model-value`, `@update:model-value` |
| `@hit="x = $event"` with no `v-model` | `v-model="x"` |
| `#suggestion="{ data, htmlText }"` | `#item="{ item: data, itemProjection, boldMatchText }"`, with `htmlText` replaced by an escaped expression |
| No suggestion slot | Adds an `#item` slot that escapes the row like Vue 2 did: the new component's own rows are unescaped HTML |

If you trust your items, you can delete the added `#item` slots.

**Reported for review** (`review` lines, never changed):

- `v-model` with object items: it now holds the picked item, so it can't also hold the search text. The line names the `@hit` target to use, when there is one.
- `@hit` that isn't a plain assignment, or that sits next to a text `v-model`.
- Data fetched from a watcher on the `v-model` value, or in `@input`: pass a function to `items`.
- A `serializer` that isn't a one-line arrow function: it must return `''` for `null`.
- `prepend` and `append`, as props or slots. The line gives the classes to use.
- A bound `size`, `background-variant` or `text-variant`, and `bg-*` hiding the keyboard selection.
- A typeahead inside a `<form>`: Enter no longer submits it.
- `$refs.x` on the component: `inputValue` and `$refs.input` are gone.
- `.vbst-item` and `.vbt-autcomplete-list` in `.vue` and script files, stylesheet imports in a `<style>` block, other deep imports, `Vue.component(...)`, `() => import(...)`, unpkg links, `v-bind="object"`, and `<template lang="pug">`.
- A `#suggestion` slot it can't rewrite, such as one passing its whole scope on with `v-bind`.

It doesn't change `package.json`, so swap the package yourself. Keep `vue` at 3.5.40 or newer and check that `npm ls vue` shows one copy: with a second copy the component shows no list and reports no error.

```bash
npm uninstall vue-bootstrap-typeahead
```

```bash
npm install vue3-bootstrap-typeahead
```

It doesn't read `.css` or `.scss` files, so search those for the old class names. Line numbers refer to the files before the run, and running it twice is safe.

## Tests

The scripts have no dependencies. The tests use Vue's template compiler to check that converted templates are valid.

```bash
npm install
```

```bash
npm test
```
