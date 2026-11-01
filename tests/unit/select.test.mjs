import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Load the TSX component without a browser; ignore its CSS side-effect only.
const filename = new URL('../../src/renderer/src/components/Select.tsx', import.meta.url)
const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
})
const require = createRequire(import.meta.url)
const exports = {}
runInThisContext(`(function(require, exports) { ${outputText}\n})`, { filename: filename.pathname })(
  name => name.endsWith('.css') ? undefined : require(name), exports
)
const { Select } = exports
const options = [createElement('option', { key: '', value: '' }, '请选择'), createElement('option', { key: '1', value: '1' }, '选项一')]

test('Select forwards native value, events, attributes, options and ref to the real select', () => {
  const onChange = () => {}
  const ref = createRef()
  const tree = Select.render({ id: 'port', name: 'port', value: '', required: true, disabled: true,
    'aria-label': '串口', 'aria-describedby': 'port-help', className: 'extra', onChange, children: options }, ref)
  const select = tree.props.children[0]
  assert.equal(select.type, 'select')
  for (const [key, value] of Object.entries({ id: 'port', name: 'port', value: '', required: true, disabled: true,
    'aria-label': '串口', 'aria-describedby': 'port-help', onChange, ref, children: options })) assert.equal(select.props[key], value)
  assert.equal(select.props.className, 'app-select__control extra')
  assert.equal(tree.props.className, 'app-select app-select--regular')
  assert.equal(select.props.sizeVariant, undefined)
  assert.equal(select.props.icon, undefined)
})

test('Select renders compact/icon variants with decorative icons and a single native form control', () => {
  const html = renderToStaticMarkup(createElement('label', null, '记录库', createElement(Select, {
    value: '1', sizeVariant: 'compact', required: true, onChange: () => {}, icon: createElement('svg', { 'data-icon': 'database' })
  }, options)))
  assert.match(html, /app-select--compact app-select--icon/)
  assert.match(html, /class="app-select__icon" aria-hidden="true"/)
  assert.match(html, /class="app-select__chevron"[^>]*aria-hidden="true"/)
  assert.match(html, /<option value="1" selected="">选项一<\/option>/)
  assert.equal((html.match(/<select\b/g) || []).length, 1)
  assert.equal((html.match(/<button\b/g) || []).length, 0)
})

test('Select preserves native fieldset, required and option-level disabled markup', () => {
  const html = renderToStaticMarkup(createElement('fieldset', { disabled: true }, createElement(Select, {
    name: 'format', defaultValue: '', required: true, 'aria-label': '格式'
  }, createElement('option', { value: '' }, '请选择'), createElement('option', { value: 'old', disabled: true }, '不可用'))))
  assert.match(html, /<fieldset disabled="">/)
  assert.match(html, /<select[^>]*name="format"[^>]*required=""/)
  assert.match(html, /<option value="old" disabled="">/)
  assert.doesNotMatch(html, /role="(?:listbox|combobox)"/)
})
