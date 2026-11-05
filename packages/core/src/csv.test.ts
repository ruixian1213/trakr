import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTaipeiTime, parseTradesCsv } from './csv.ts'

test('times are Taipei local and ROC years are converted', () => {
  assert.equal(parseTaipeiTime('2026-11-03 09:15'), '2026-11-03T01:15:00.000Z')
  assert.equal(parseTaipeiTime('2026/11/03 09:15:30'), '2026-11-03T01:15:30.000Z')
  assert.equal(parseTaipeiTime('115/11/03 09:00'), '2026-11-03T01:00:00.000Z')
  assert.equal(parseTaipeiTime('2026-11-03'), '2026-11-03T05:30:00.000Z') // bare date = the close
  assert.equal(parseTaipeiTime('2026-02-31'), null)
  assert.equal(parseTaipeiTime('yesterday'), null)
})

test('parses English headers', () => {
  const r = parseTradesCsv('time,symbol,side,qty,price,fee\n2026-11-03 09:15,2330,buy,1000,600,855\n2026-11-03 10:00,2330,sell,1000,610,870')
  assert.deepEqual(r.errors, [])
  assert.equal(r.trades.length, 2)
  assert.deepEqual([r.trades[0]!.side, r.trades[0]!.qty, r.trades[0]!.price, r.trades[0]!.fee], ['buy', 1000, 600, 855])
})

test('parses Chinese headers, lots, thousands separators and BOM', () => {
  const csv = '﻿成交日期,股票代號,買賣別,成交張數,成交價\r\n"2026/11/03 09:15","2330","現股買進",2,"1,005.5"\r\n'
  const r = parseTradesCsv(csv)
  assert.deepEqual(r.errors, [])
  assert.equal(r.trades[0]!.qty, 2000)
  assert.equal(r.trades[0]!.price, 1005.5)
  assert.equal(r.trades[0]!.side, 'buy')
})

test('tab separated files work too', () => {
  const r = parseTradesCsv('時間\t代號\t買賣\t股數\t價格\n2026-11-03 09:15\t0050\t賣出\t500\t180')
  assert.deepEqual(r.errors, [])
  assert.equal(r.trades[0]!.side, 'sell')
})

test('bad rows are reported with line numbers and good rows still parse', () => {
  const r = parseTradesCsv('time,symbol,side,qty,price\n2026-11-03 09:15,2330,buy,1000,600\nnope,2330,buy,1000,600\n2026-11-03 09:16,2330,hold,1000,600\n2026-11-03 09:17,2330,buy,0,600')
  assert.equal(r.trades.length, 1)
  assert.deepEqual(r.errors.map((e) => e.line), [3, 4, 5])
})

test('missing required columns are explained', () => {
  const r = parseTradesCsv('foo,bar\n1,2')
  assert.equal(r.trades.length, 0)
  assert.match(r.errors[0]!.message, /找不到欄位/)
  assert.equal(parseTradesCsv('').errors.length, 1)
})

test('ids are stable across imports and distinct for identical fills in one file', () => {
  const csv = 'time,symbol,side,qty,price\n2026-11-03 09:15,2330,buy,1000,600\n2026-11-03 09:15,2330,buy,1000,600'
  const a = parseTradesCsv(csv).trades
  const b = parseTradesCsv(csv).trades
  assert.notEqual(a[0]!.brokerTradeId, a[1]!.brokerTradeId)
  assert.deepEqual(a.map((t) => t.brokerTradeId), b.map((t) => t.brokerTradeId))
  assert.ok(a[0]!.brokerTradeId.startsWith('csv:'))
})
