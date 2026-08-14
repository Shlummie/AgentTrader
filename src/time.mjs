import {
  DECISION_END_MINUTE_ET,
  DECISION_START_MINUTE_ET,
  FILL_DEADLINE_MINUTE_ET
} from './constants.mjs';

const TZ = 'America/New_York';
const formatterCache = new Map();

function formatter(timeZone = TZ) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short'
    }));
  }
  return formatterCache.get(timeZone);
}

export function zonedParts(input = new Date(), timeZone = TZ) {
  const date = input instanceof Date ? input : new Date(input);
  const values = Object.fromEntries(
    formatter(timeZone).formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: values.weekday
  };
}

export function dateKey(input = new Date(), timeZone = TZ) {
  const p = zonedParts(input, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function minuteOfDay(input = new Date(), timeZone = TZ) {
  const p = zonedParts(input, timeZone);
  return p.hour * 60 + p.minute + p.second / 60;
}

export function isDecisionWindow(input = new Date()) {
  const minute = minuteOfDay(input);
  return minute >= DECISION_START_MINUTE_ET && minute <= DECISION_END_MINUTE_ET;
}

export function isBeforeOrAtFillDeadline(input = new Date()) {
  return minuteOfDay(input) <= FILL_DEADLINE_MINUTE_ET;
}

export function decisionWindowStatus(input = new Date()) {
  const minute = minuteOfDay(input);
  if (minute < DECISION_START_MINUTE_ET) return 'before';
  if (minute <= DECISION_END_MINUTE_ET) return 'eligible';
  return 'missed';
}

export function timeZoneOffsetMs(input, timeZone = TZ) {
  const date = input instanceof Date ? input : new Date(input);
  const p = zonedParts(date, timeZone);
  const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return represented - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedDateTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = TZ) {
  const nominal = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = nominal;
  for (let i = 0; i < 4; i += 1) {
    candidate = nominal - timeZoneOffsetMs(new Date(candidate), timeZone);
  }
  return new Date(candidate);
}

function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid date key: ${key}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function keyFromUtcCalendar(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addCalendarDays(key, days) {
  const { year, month, day } = parseDateKey(key);
  return keyFromUtcCalendar(new Date(Date.UTC(year, month - 1, day + days)));
}

function weekdayForKey(key) {
  const { year, month, day } = parseDateKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nthWeekday(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((weekday - first.getUTCDay() + 7) % 7) + 7 * (nth - 1);
  return keyFromUtcCalendar(new Date(Date.UTC(year, month - 1, day)));
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return keyFromUtcCalendar(new Date(Date.UTC(year, month - 1, day)));
}

function observedFixedHoliday(year, month, day) {
  const raw = keyFromUtcCalendar(new Date(Date.UTC(year, month - 1, day)));
  const weekday = weekdayForKey(raw);
  if (weekday === 6) return addCalendarDays(raw, -1);
  if (weekday === 0) return addCalendarDays(raw, 1);
  return raw;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return keyFromUtcCalendar(new Date(Date.UTC(year, month - 1, day)));
}

export function marketHolidays(year) {
  const holidays = new Set();
  holidays.add(observedFixedHoliday(year, 1, 1));
  // A prior year's New Year's Day can be observed on Dec 31 of this year.
  holidays.add(observedFixedHoliday(year + 1, 1, 1));
  holidays.add(nthWeekday(year, 1, 1, 3)); // Martin Luther King Jr. Day
  holidays.add(nthWeekday(year, 2, 1, 3)); // Washington's Birthday
  holidays.add(addCalendarDays(easterSunday(year), -2)); // Good Friday
  holidays.add(lastWeekday(year, 5, 1)); // Memorial Day
  if (year >= 2022) holidays.add(observedFixedHoliday(year, 6, 19));
  holidays.add(observedFixedHoliday(year, 7, 4));
  holidays.add(nthWeekday(year, 9, 1, 1)); // Labor Day
  holidays.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  holidays.add(observedFixedHoliday(year, 12, 25));
  return holidays;
}

export function isTradingDate(key) {
  const { year } = parseDateKey(key);
  const weekday = weekdayForKey(key);
  return weekday >= 1 && weekday <= 5 && !marketHolidays(year).has(key);
}

export function nextTradingDate(key) {
  let cursor = key;
  for (let i = 0; i < 14; i += 1) {
    cursor = addCalendarDays(cursor, 1);
    if (isTradingDate(cursor)) return cursor;
  }
  throw new Error(`Unable to find next trading date after ${key}`);
}

export function isoFromEpochSeconds(value) {
  return new Date(value * 1000).toISOString();
}

export const NEW_YORK_TIME_ZONE = TZ;
