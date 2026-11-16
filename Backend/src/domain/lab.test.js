import test from 'node:test'
import assert from 'node:assert/strict'
import { labParameters } from './lab.js'

test('a certificate gives colour under the codes the screens look up', () => {
  const rows = labParameters([
    { canonical_code: 'lab.ffa', numeric_value: '0.052' },
    { canonical_code: 'lab.moisture', numeric_value: 0.039 },
    { canonical_code: 'lab.color_r', numeric_value: '2.6' },
    { canonical_code: 'lab.color_y', numeric_value: 26 },
  ])
  assert.deepEqual(rows.map((row) => [row.code, row.value]), [['FFA', 0.052], ['MI', 0.039], ['COLOR_R', 2.6], ['COLOR_Y', 26]])
})

test('tests we do not show, and tests with no number, are left out', () => {
  const rows = labParameters([
    { canonical_code: 'lab.unknown_test', numeric_value: 500 },
    { canonical_code: 'lab.color_r', numeric_value: null },
    { canonical_code: 'lab.ffa', numeric_value: 4.1 },
  ])
  assert.deepEqual(rows.map((row) => row.code), ['FFA'])
  assert.deepEqual(labParameters(undefined), [])
})

test('product-specific tests come through under their short codes', () => {
  const rows = labParameters([
    { canonical_code: 'lab.carotene', numeric_value: 585 },
    { canonical_code: 'lab.cloud_point', numeric_value: '9.4' },
    { canonical_code: 'lab.smp', numeric_value: 36 },
    { canonical_code: 'lab.totox', numeric_value: 7.3 },
  ])
  assert.deepEqual(rows.map((row) => [row.code, row.value]), [['CAROTENE', 585], ['CP', 9.4], ['SMP', 36], ['TOTOX', 7.3]])
})
