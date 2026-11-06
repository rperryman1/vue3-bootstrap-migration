# vue-bootstrap-typeahead vs vue3-bootstrap-typeahead

How `vue3-bootstrap-typeahead` 1.2.2 (Vue 3) differs from `vue-bootstrap-typeahead` 0.2.6 (Vue 2), and what that means when you move an app from one to the other. Checked in November 2026.

**The Vue 3 package is not a port of the Vue 2 one.** They have different authors and share no code: `vue3-bootstrap-typeahead` began as a fork of `vue3-simple-typeahead` and was later rewritten. Almost every prop, event and slot has a new name, and some that kept their name behave differently. Plan for a rewrite of each usage rather than a version bump. [`migrate-typeahead.mjs`](../migrate-typeahead.mjs) does the mechanical part.

If your `package.json` lists `vue-typeahead-bootstrap`, that's a separate Vue 2 fork with extra features, and this comparison doesn't cover them.

Line references point at the published sources. A bare `:127` means `src/TypeAhead.vue` when it describes Vue 3, and `src/components/VueBootstrapTypeahead.vue` when it describes Vue 2. `List.vue` is short for `VueBootstrapTypeaheadList.vue`.

## What will break first

1. **`v-model` means something else.** In Vue 2 it holds the text in the input and changes on every keystroke. In Vue 3 it holds the picked item and changes only on a pick. A watcher that fetches results when the text changes never fires.
2. **Results fetched after a keystroke arrive one keystroke late.** Vue 2 re-reads `data` whenever it changes. Vue 3 reads an `items` array only when the text changes, so new results stay hidden until the next keystroke. Pass a function to `items` instead.
3. **HTML in an item now runs.** Vue 2 escapes `<` and `>`. Vue 3 doesn't, and it renders rows with `v-html`. In Chromium, an item containing `<img src=x onerror=...>` ran its `onerror`. If items can contain text from users, this is an XSS hole.
4. **There is no `hit` event.** Use `v-model`, or `@update:model-value`, which also fires with `null` when the input is cleared.
5. **Typed text is thrown away on blur.** Text that isn't a pick is discarded unless you set `allow-new`. Vue 2 leaves it in the input.
6. **A `serializer` can crash the page.** The renamed `itemProjection` is also called on the `v-model` value, so `s => s.name` throws on render when the model is `null` or `undefined`.
7. **The app needs Vue 3.5.40 or newer.** The package lists `vue` as a dependency, not a peer dependency. With an app pinned to 3.5.13, npm installed a second copy of Vue inside the package, and the component rendered but never showed a list. It gave no error, only a "Missing ref owner context" warning. Check with `npm ls vue`.

## The packages

| | Vue 2 | Vue 3 |
|---|---|---|
| Package | `vue-bootstrap-typeahead` | `vue3-bootstrap-typeahead` |
| Author | Alex Urquhart | Massimo Nadalin |
| License | MIT | Apache-2.0 |
| Latest release | 0.2.6, October 2018 | 1.2.2, August 2026 |
| Repository | Archived, 72 open issues | Active, 0 open issues, 11 stars |
| Vue | `^2.5.17` | `^3.5.40` |
| Bootstrap | 4 | 4.6 to 5.3 according to its README (only 5.3.8 was tried here) |
| Other dependencies | `resize-observer-polyfill` | None |
| Entry point | `main` is the raw `.vue` file, so your build compiles it | `exports` map to a compiled ES module |
| Stylesheet | `dist/VueBootstrapTypeahead.css` for the UMD build | None |
| Size | 27.7 kB minified UMD | 8 kB ES module |
| Source | 3 components, 348 lines | 1 component, 327 lines |
| Tests | 3 Jest spec files | None in the repository |
| TypeScript types | None | None |
| Browser global | `VueBootstrapTypeahead` | `window['Vue3 Bootstrap TypeAhead']` |

## How they're built

| | Vue 2 | Vue 3 |
|---|---|---|
| Structure | `VueBootstrapTypeahead` → `List` → `ListItem`, talking through props and events | One component |
| API style | Options API | `<script setup>`, with no `defineExpose`, so a parent's template ref reaches nothing inside |
| Input text | `inputValue`, a lasting string set only by typing and picks (`:15`, `:140`, `:155`). The `value` prop is never read back into it | `buffer`, which exists only while focused. Otherwise the input shows `itemProjection(modelValue)` (`:95`) |
| Filtering | Computed `matchedItems`, so it reacts to both the data and the text (`List.vue:79`) | `filterItems()`, called only by a watcher on `buffer`, plus on focus when `minInputLength` is 0 (`:100`, `:118`, `:210`) |
| Matching | Case-insensitive regex, sorted by match position, then cut to the limit (`List.vue:87`) | Case-insensitive regex in source order, then cut to the limit. Function results aren't filtered at all (`:216-236`) |
| Highlighting | Escapes `<` and `>`, wraps matches in `<strong>`, passes the string down as `htmlText` (`List.vue:63`) | `boldMatchText()` wraps matches with no escaping, then `v-html` (`:203`, `:318`) |
| Clicking a row | `handleBlur` keeps the list open when focus moves to a `.vbst-item` (`:146`) | `@mousedown.prevent` keeps focus on the input (`:300`) |
| List position | A `ResizeObserver` sets the width and left margin of an absolutely positioned list (`:120`, `:172`) | Whatever Bootstrap's `.dropdown-menu` gives it. Nothing is measured |
| Remote data | Not its job: the parent fetches and passes an array | Built in: `items` can be a function, with a delay and five `request:*` events |
| Cleanup | Disconnects the observer in `beforeDestroy` (`:179`) | No unmount hook, so a pending request timer still fires |

## API mapping

### Props

| Vue 2 | Vue 3 | What changes |
|---|---|---|
| `v-model` / `value` (String) | `v-model` / `modelValue` (String, Object) | Holds the picked item instead of the typed text |
| `data` (Array, required) | `items` (Array or function) | A function takes the query and returns a promise. Arrays are read only when the text changes |
| `serializer` | `itemProjection` | Also called on the model value, so it must handle `null` |
| `maxMatches` (default 10) | `maxItems` (default -1, meaning all) | No limit by default |
| `minMatchingChars` (default 2) | `minInputLength` (default 2) | 0 now opens the list on focus |
| `placeholder` | `placeholder` | No longer copied to `aria-label` |
| `inputClass` (String, default `''`) | `inputClass` (String, Object, default `form-control`) | Replaces `form-control` instead of adding to it |
| `size` | None | `input-class="form-control form-control-lg"` |
| `backgroundVariant`, `textVariant` | None | `dropdown-item-class="dropdown-item bg-dark text-white"` |
| `prepend`, `append` | None | Wrap it in an `input-group` ([recipe](#add-ons-next-to-the-input)) |
| None | `allowNew`, `immediate` | Keep text that isn't a pick. With both, the model follows each keystroke |
| None | `clearable`, `disabled`, `readonly` | New |
| None | `requestDelay` (default 250) | Debounce for a function in `items` |
| None | `dropdownClass`, `dropdownMenuClass`, `dropdownItemClass`, `dropdownItemStyle`, `currentSelectionClass` | Classes and styles for each part |

### Events

| Vue 2 | Vue 3 | What changes |
|---|---|---|
| `input` | `update:model-value` | Vue 2 sends the text on every keystroke and pick, and only when `value` is bound. Vue 3 sends the item on a pick, and `null` when the input is cleared and loses focus. With `allow-new immediate`, it also sends the text on every keystroke |
| `hit` | None | Sent the picked item. Use `v-model` |
| None | `on-focus`, `on-blur` | Payload is `{ value, items }`. Its README lists them as `onFocus` / `onBlur` with `{ input, items }` |
| None | `request:queued`, `request:fired`, `request:completed`, `request:canceled`, `request:failed` | For a function in `items` |

### Slots

| Vue 2 | Vue 3 | What changes |
|---|---|---|
| `suggestion` (`data`, `htmlText`) | `item` (`item`, `index`, `itemProjection`, `boldMatchText`) | `htmlText` was an escaped string. `boldMatchText` is a function that doesn't escape |
| `prepend`, `append` | None | |

## Behavior side by side

Each row comes from running both components (see [How this was checked](#how-this-was-checked)).

| Situation | Vue 2 | Vue 3 |
|---|---|---|
| Typing with `v-model` | Model follows each keystroke | Model doesn't change |
| Picking a row, object items | Model gets the row's text, `hit` gets the object | Model gets the object |
| Parent sets the model | Input ignores it, on load and later | Input shows it |
| Text not in the list, then blur | Stays in the input and the model | Input goes back to the model, text is lost. With `allow-new`, it's kept and the model gets it on blur |
| Clearing the input, then blur | Model is `''` | Model is `null` |
| Picking a row with no `v-model` | Input keeps the text | Input goes blank |
| Array changes while the list is open | List updates | Nothing until the next keystroke |
| A server result that doesn't contain the text | Filtered out | Shown |
| Result order | Earliest match first | Source order |
| Rows shown with 50 matches, by default | 10 | 50 |
| Minimum length of 0, on focus | Nothing | All items |
| Item contains `<img onerror=...>` | Shown as text | Runs |
| Arrow keys | Nothing | Move the selection. Enter or Tab picks it |
| Esc | List stays open | Closes the list and leaves the input |
| Enter inside a `<form>` | Not cancelled, so the form submits | Always cancelled, even with nothing selected |
| `disabled` | No effect on the input | Disables it |
| `id`, `name`, `aria-label` and other attributes | Land on the outer `div` | Land on the outer `div` too |
| Input element | `type="search"`, `aria-label` from the placeholder | `type="text"`, no `aria-label` |
| `$refs.x.inputValue`, `$refs.x.$refs.input` | Work | Don't exist. `$refs.x.$el` still works |

Neither component sets `role="combobox"` or the related ARIA attributes. Since attributes can't reach the Vue 3 input, the way to name it is a `<label>` wrapped around the component.

## Markup and styling

Vue 2 uses an `input-group` and a `list-group` of links:

```html
<div>
  <div class="input-group">
    <input type="search" class="form-control" aria-label="...">
  </div>
  <div class="list-group shadow vbt-autcomplete-list" style="width: ...">
    <a tabindex="0" href="#" class="vbst-item list-group-item list-group-item-action">...</a>
  </div>
</div>
```

Vue 3 uses a `dropdown` with buttons:

```html
<div class="dropdown">
  <input type="text" class="form-control">
  <ul class="dropdown-menu" style="display: block">
    <li><button type="button" class="dropdown-item">...</button></li>
  </ul>
</div>
```

What that does in practice, measured in Chromium with Bootstrap 5.3.8 and a 447px input:

| Vue 3 setup | Result | Fix |
|---|---|---|
| Default menu | 160px wide, because Bootstrap's minimum width applies | `dropdown-menu-class="dropdown-menu w-100"` |
| 200 matches, default | A 6417px tall menu with no scrolling, where Vue 2 stops at 350px and scrolls | `:max-items="10"`, which gives 337px with nothing to scroll |
| Inside `.input-group`, no changes | Input shrinks to 207px of 447px and keeps its rounded corners | `dropdown-class="dropdown flex-grow-1"` and `input-class="form-control rounded-start-0"`, which give 414px and a square left edge |
| `bg-dark` as an item class | The selected row looks like every other row, because `bg-*` is `!important` | No prop fixes this. Avoid `bg-*` if people use the keyboard |

CSS aimed at `.vbst-item` or `.vbt-autcomplete-list` no longer matches anything. The rows are `.dropdown-item` and the list is `.dropdown-menu`. Vue 3 needs Bootstrap's CSS but not its JavaScript.

## Bugs in vue3-bootstrap-typeahead 1.2.2

All of these were reproduced.

| Problem | Where | Effect | What to do |
|---|---|---|---|
| Rows aren't escaped | `:203`, `:318` | Item text runs as HTML | Use an escaping `#item` slot ([recipe](#custom-rows)) |
| Arrow keys don't scroll | `:173` passes a function as `scrollTo`'s position | In a 160px capped menu the selected row was hidden from the 5th press on, and `scrollTop` stayed at 0 | Keep lists short enough not to scroll, with `max-items` |
| Arrow keys throw an error | `:169` looks for `.active` by name | A custom `currentSelectionClass` or an object `dropdownItemClass` gives an uncaught `TypeError` on each press | Keep `active`, and use a string for `dropdownItemClass` |
| Object `dropdownItemClass` | `:256` reads `props.currentSelection` | The selected row gets the class `undefined` and no highlight | Use a string, or a function returning an array |
| Late responses win | `:234` has no staleness check | With two requests out, the older answer replaced the newer list | Abort the previous request ([recipe](#results-from-an-api)) |
| `allowNew` never matches an item | `:127` empties the list before `:130` searches it | Typing `canada` and leaving gives the string `canada`, not the `Canada` item | Treat the model as possibly a string |
| `on-blur` payload | `:127` runs before `:146` | `items` is always empty | Don't rely on it |
| `request:queued` timeout ID | `:242` reads `props.requestTimeout` | Second argument is always `undefined` | Don't rely on it |
| Timer survives unmount | `:229`, no unmount hook | A pending request still fired after the component was gone | Harmless unless your function has side effects |
| `require()` fails | `exports` names `.umd.js`, the file is `.umd.cjs` | `MODULE_NOT_FOUND` from CommonJS, which probably includes Jest's default mode | Use `import`. Map the module in Jest if it fails there |

## Recipes

Each "after" below keeps the Vue 2 tag name, which works because the package's default export can be registered under any name. `migrate-typeahead.mjs` leaves the name alone for the same reason.

### Plain list of strings

```vue
<!-- Vue 2 -->
<vue-bootstrap-typeahead v-model="country" :data="countries" />

<!-- Vue 3: the model is still whatever is in the input -->
<vue-bootstrap-typeahead
  v-model="country"
  :items="countries"
  :max-items="10"
  dropdown-menu-class="dropdown-menu w-100"
  allow-new
  immediate
>
  <template #item="{ item, itemProjection, boldMatchText }">
    <span v-html="boldMatchText(itemProjection(item).replace(/</g, '&lt;').replace(/>/g, '&gt;'))"></span>
  </template>
</vue-bootstrap-typeahead>
```

Drop `allow-new immediate` if only items from the list should count.

### Results from an API

The model now holds the pick, and the component does the debouncing, so the query variable and the watcher both go away.

```vue
<!-- Vue 2 -->
<vue-bootstrap-typeahead
  v-model="query"
  :data="results"
  :serializer="a => a.text"
  @hit="selected = $event"
/>
<script>
export default {
  watch: { query: debounce(function (q) { this.load(q) }, 300) },
  methods: {
    async load(q) { this.results = await fetch(`/api?q=${q}`).then(r => r.json()) }
  }
}
</script>

<!-- Vue 3 -->
<vue-bootstrap-typeahead
  v-model="selected"
  :items="search"
  :item-projection="a => (a == null ? '' : a.text)"
  :request-delay="300"
  :max-items="10"
  dropdown-menu-class="dropdown-menu w-100"
/>
<script>
export default {
  methods: {
    search(q) {
      if (!q) return
      // An aborted request only fires request:failed, so a late answer can't replace a newer list.
      this.controller?.abort()
      this.controller = new AbortController()
      return fetch(`/api?q=${encodeURIComponent(q)}`, { signal: this.controller.signal }).then(r => r.json())
    }
  }
}
</script>
```

The server's results are shown as they come, so it has to do the filtering. This example also still needs the escaping slot from the first recipe.

### Add-ons next to the input

```vue
<!-- Vue 2 -->
<vue-bootstrap-typeahead :data="prices" prepend="$" />

<!-- Vue 3 -->
<div class="input-group">
  <span class="input-group-text">$</span>
  <vue-bootstrap-typeahead
    :items="prices"
    dropdown-class="dropdown flex-grow-1"
    input-class="form-control rounded-start-0"
    dropdown-menu-class="dropdown-menu w-100"
  />
</div>
```

For an add-on after the input, use `rounded-end-0`. That variant wasn't measured, but the class exists in Bootstrap 5.3.8.

### Custom rows

```vue
<!-- Vue 2 -->
<template #suggestion="{ data, htmlText }">
  <span v-html="htmlText"></span> <small>{{ data.code }}</small>
</template>

<!-- Vue 3 -->
<template #item="{ item: data, itemProjection, boldMatchText }">
  <span v-html="boldMatchText(itemProjection(data).replace(/</g, '&lt;').replace(/>/g, '&gt;'))"></span> <small>{{ data.code }}</small>
</template>
```

The `&` is deliberate. Vue decodes `&lt;` inside an attribute before the expression runs, which would turn the escape into a replacement of `<` with `<`. If your rows can't contain HTML from anyone but you, `v-html="boldMatchText(itemProjection(data))"` is enough.

## How this was checked

- Both packages were downloaded from npm at the versions above, and the sources were read in full.
- The behavior tables come from mounting the published builds with real Vue (2.7.16 and 3.5.45) in jsdom and dispatching DOM input, focus and keyboard events.
- Sizing, scrolling and running HTML in rows were measured in Chromium with Bootstrap 5.3.8.
- The output of `migrate-typeahead.mjs` was mounted the same way against the real Vue 3 package, including with hostile item text. Its rows matched Vue 2's HTML exactly.

Not checked:

- The Vue 2 component in a real browser (jsdom only), and either one in Firefox or Safari.
- Vue 3 with Bootstrap 4.
- A Vite or webpack build. The two-copies-of-Vue failure was seen in Node with jsdom. Bundlers should resolve the nested copy the same way, but settings such as Vite's `resolve.dedupe` would avoid it.
- `@vue/compat`, the compatibility build many Vue 2 migrations pass through.
- Server-side rendering.
