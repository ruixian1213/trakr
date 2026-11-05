import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HANDLE_MESSAGES, RESERVED_HANDLES, handleKey, handleProblem } from './handle.ts'

test('well-formed IDs are accepted, whatever the capitalisation', () => {
  for (const ok of ['alice', 'Alice', 'ALICE', 'a_b', 'abc', 'user123', '123', 'A1_b2_C3', 'x'.repeat(20)]) {
    assert.equal(handleProblem(ok), null, ok)
  }
})

test('length, characters and type are enforced', () => {
  for (const bad of ['', 'ab', 'x'.repeat(21), 'has space', 'dot.ted', 'dash-ed', 'at@sign', '中文名字', 'émile', '<script>', 'a/b', '../x', ' alice', 'alice ', 'ali\nce']) {
    assert.equal(handleProblem(bad), 'format', JSON.stringify(bad))
  }
  for (const notString of [undefined, null, 42, {}, [], true]) assert.equal(handleProblem(notString), 'format')
})

test('look-alike letters from other alphabets cannot be used to imitate an ID', () => {
  assert.equal(handleProblem('аlice'), 'format', 'Cyrillic a')
  assert.equal(handleProblem('alıce'), 'format', 'dotless i')
  assert.equal(handleProblem('ａlice'), 'format', 'full-width a')
})

test('reserved words are blocked in any case, including common impersonation spellings', () => {
  for (const r of ['admin', 'Admin', 'ADMIN', 'root', 'support', 'official', 'tot', 'trakr', 'TRAKR', 'twse', 'fubon', 'shioaji', 'null', 'settings']) {
    assert.equal(handleProblem(r), 'reserved', r)
  }
  for (const r of ['admin2', 'administrator', 'Admin_helper', 'trakr_official', 'trakr123', 'TRAKR_support']) {
    assert.equal(handleProblem(r), 'reserved', r)
  }
})

test('ordinary names that merely contain a reserved word are fine', () => {
  for (const ok of ['alice_admin', 'my_support_team', 'officialtrader', 'twse_fan', 'fubon_fan', 'badmin', 'mod_squad_x']) {
    assert.equal(handleProblem(ok), null, ok)
  }
})

test('identity is the lower-cased key', () => {
  assert.equal(handleKey('Alice'), 'alice')
  assert.equal(handleKey('ALICE'), handleKey('alice'))
  assert.equal(handleKey('A_1'), 'a_1')
})

test('every reserved word is itself a valid-looking ID, so the list is actually exercised', () => {
  for (const r of RESERVED_HANDLES) assert.equal(handleProblem(r), r.length >= 3 && r.length <= 20 ? 'reserved' : 'format', r)
})

test('messages exist for every outcome', () => {
  assert.ok(HANDLE_MESSAGES.format && HANDLE_MESSAGES.reserved && HANDLE_MESSAGES.taken)
})
