import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dateKey,
  decisionWindowStatus,
  isBeforeOrAtFillDeadline,
  isTradingDate,
  marketHolidays,
  minuteOfDay,
  nextTradingDate,
  zonedDateTimeToUtc
} from '../src/time.mjs';

test('America/New_York conversion handles EST and EDT', () => {
  assert.equal(zonedDateTimeToUtc({ year: 2026, month: 1, day: 15, hour: 12 }).toISOString(), '2026-01-15T17:00:00.000Z');
  assert.equal(zonedDateTimeToUtc({ year: 2026, month: 7, day: 15, hour: 12 }).toISOString(), '2026-07-15T16:00:00.000Z');
  assert.equal(minuteOfDay(new Date('2026-01-15T17:05:00Z')), 725);
  assert.equal(minuteOfDay(new Date('2026-07-15T16:05:00Z')), 725);
});

test('decision and fill windows enforce their exact Eastern boundaries', () => {
  assert.equal(decisionWindowStatus(new Date('2026-08-10T15:59:59Z')), 'before');
  assert.equal(decisionWindowStatus(new Date('2026-08-10T16:00:00Z')), 'eligible');
  assert.equal(decisionWindowStatus(new Date('2026-08-10T16:15:00Z')), 'eligible');
  assert.equal(decisionWindowStatus(new Date('2026-08-10T16:15:01Z')), 'missed');
  assert.equal(isBeforeOrAtFillDeadline(new Date('2026-08-10T16:20:00Z')), true);
  assert.equal(isBeforeOrAtFillDeadline(new Date('2026-08-10T16:20:01Z')), false);
});

test('NYSE calendar skips weekends and recurring full-session holidays', () => {
  const holidays = marketHolidays(2026);
  for (const key of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']) {
    assert.equal(holidays.has(key), true, key);
    assert.equal(isTradingDate(key), false, key);
  }
  assert.equal(isTradingDate('2026-08-08'), false);
  assert.equal(isTradingDate('2026-08-10'), true);
  assert.equal(nextTradingDate('2026-07-02'), '2026-07-06');
});

test('date keys always use New York rather than the PC offset', () => {
  assert.equal(dateKey(new Date('2026-08-11T03:00:00Z')), '2026-08-10');
});
