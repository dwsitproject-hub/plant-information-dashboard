import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_STORAGE_SPECS, SPEC_PARAMETERS, evaluateStorage, normaliseRules, valuesFromTests } from './qualityRules.js'

const rules = (commodity) => DEFAULT_STORAGE_SPECS[commodity].map(([parameterCode, bound, limit, severity]) => ({ parameterCode, bound, limit, severity }))

test('no rules, or no result for any ruled parameter, stays spec pending', () => {
  assert.equal(evaluateStorage([], { ffa: 1 }).verdict, 'spec-pending')
  assert.equal(evaluateStorage(undefined, { ffa: 1 }).verdict, 'spec-pending')
  assert.equal(evaluateStorage(rules('rpo'), { anv: 1 }).verdict, 'spec-pending')
})

// Figures from the QC Storage page on 16 Nov 2026.
test('T.03 refined palm oil is out of spec on FFA and colour', () => {
  const judged = evaluateStorage(rules('rpo'), { ffa: 0.19, moisture: 0.038, colorR: 3.8, colorY: 38, pv: 1.45, iv: 52.28, odor: '✓' })
  assert.equal(judged.verdict, 'quarantine')
  assert.deepEqual(judged.breaches.map((b) => b.field).sort(), ['colorR', 'ffa'])
})

test('T.22 refined palm oil passes', () => {
  const judged = evaluateStorage(rules('rpo'), { ffa: 0.055, moisture: 0.038, colorR: 2, pv: 0.57, iv: 52.67, odor: '✓' })
  assert.equal(judged.verdict, 'pass')
  assert.deepEqual(judged.breaches, [])
})

test('T.08 olein: PV only watches, colour rejects', () => {
  const judged = evaluateStorage(rules('olein'), { ffa: 0.07, moisture: 0.04, colorR: 3.6, pv: 10.02, iv: 59.02, cloudPoint: 9, odor: '✓' })
  assert.equal(judged.verdict, 'quarantine')
  const pv = judged.breaches.find((b) => b.field === 'pv')
  assert.equal(pv.severity, 'watch')
  assert.equal(judged.breaches.find((b) => b.field === 'colorR').severity, 'reject')
})

test('a watch breach alone still passes', () => {
  const judged = evaluateStorage(rules('olein'), { ffa: 0.05, moisture: 0.04, colorR: 2.3, pv: 2.5, iv: 56.8, cloudPoint: 9.6 })
  assert.equal(judged.verdict, 'pass')
  assert.equal(judged.breaches.length, 1)
})

test('T.14 CPO bottoms are out of spec; normal CPO passes', () => {
  assert.equal(evaluateStorage(rules('cpo'), { ffa: 24.976, moisture: 5.611, iv: 43.57 }).verdict, 'quarantine')
  assert.equal(evaluateStorage(rules('cpo'), { ffa: 4.218, moisture: 0.379, dobi: 2.92, iv: 51.98, carotene: 585 }).verdict, 'pass')
})

test('PFAD needs a high FFA, and a failed odour puts it out of spec', () => {
  assert.equal(evaluateStorage(rules('pfad'), { ffa: 86.267, odor: '✓' }).verdict, 'pass')
  assert.equal(evaluateStorage(rules('pfad'), { ffa: 65 }).verdict, 'quarantine')
  const t16 = evaluateStorage(rules('pfad'), { ffa: 89.32, odor: '✗' })
  assert.equal(t16.verdict, 'quarantine')
  assert.equal(t16.breaches[0].field, 'odor')
})

test('certificate tests map onto the fields the rules read', () => {
  const values = valuesFromTests([
    { canonical_code: 'lab.ffa', numeric_value: '0.19' },
    { canonical_code: 'lab.cloud_point', numeric_value: 9.4 },
    { canonical_code: 'lab.unknown', numeric_value: 1 },
  ], '✗')
  assert.deepEqual(values, { odor: '✗', ffa: 0.19, cloudPoint: 9.4 })
})

test('the editor input is checked and normalised', () => {
  assert.deepEqual(normaliseRules([{ parameterCode: 'lab.ffa', bound: 'max', limit: '0.1', severity: 'reject' }]).rules,
    [{ parameterCode: 'lab.ffa', bound: 'max', limit: 0.1, severity: 'reject' }])
  assert.deepEqual(normaliseRules([{ parameterCode: 'lab.odor', bound: 'min', limit: 5 }]).rules,
    [{ parameterCode: 'lab.odor', bound: 'max', limit: null, severity: 'reject' }], 'odour has no number or direction')
  assert.equal(normaliseRules('nope').error, 'invalid_rules')
  assert.equal(normaliseRules([{ parameterCode: 'lab.nope', bound: 'max', limit: 1 }]).error, 'unknown_parameter')
  assert.equal(normaliseRules([{ parameterCode: 'lab.ffa', bound: 'max' }]).error, 'limit_required')
  assert.equal(normaliseRules([{ parameterCode: 'lab.ffa', bound: 'up', limit: 1 }]).error, 'invalid_bound')
  assert.equal(normaliseRules([{ parameterCode: 'lab.ffa', bound: 'max', limit: 1, severity: 'loud' }]).error, 'invalid_severity')
  assert.equal(normaliseRules([
    { parameterCode: 'lab.ffa', bound: 'max', limit: 1 },
    { parameterCode: 'lab.ffa', bound: 'max', limit: 2 },
  ]).error, 'duplicate_rule')
  assert.equal(normaliseRules([
    { parameterCode: 'lab.iv', bound: 'min', limit: 60 },
    { parameterCode: 'lab.iv', bound: 'max', limit: 55 },
  ]).error, 'min_above_max')
  assert.deepEqual(normaliseRules([]).rules, [], 'an empty list clears the limits')
})

test('every default rule uses a known parameter', () => {
  const known = new Set(SPEC_PARAMETERS.map((parameter) => parameter.code))
  for (const list of Object.values(DEFAULT_STORAGE_SPECS)) {
    for (const [code] of list) assert.ok(known.has(code), code)
  }
})
