import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  escapeCsvCell,
  parseDirectoryQuery,
  toCsv,
} from './users.admin.query';
import { evaluateAccountRisk } from './users.risk';

test('directory query defaults are safe and bounded', () => {
  const query = parseDirectoryQuery({});

  assert.equal(query.page, 1);
  assert.equal(query.page_size, DEFAULT_PAGE_SIZE);
  assert.equal(query.status, 'all');
  assert.equal(query.access, 'all');
  assert.equal(query.role, 'all');
  assert.equal(query.sort, 'created_at');
  assert.equal(query.direction, 'desc');
  assert.equal(query.q, '');
});

test('directory query rejects an oversized page instead of silently clamping', () => {
  assert.throws(() => parseDirectoryQuery({ page_size: String(MAX_PAGE_SIZE + 1) }), /page_size/);
  assert.throws(() => parseDirectoryQuery({ page: '0' }), /page/);
});

test('directory query rejects unknown filter values', () => {
  assert.throws(() => parseDirectoryQuery({ status: 'banished' }), /status/);
  assert.throws(() => parseDirectoryQuery({ access: 'vip' }), /access/);
  assert.throws(() => parseDirectoryQuery({ role: 'owner' }), /role/);
  assert.throws(() => parseDirectoryQuery({ sort: 'coin_balance' }), /sort/);
  assert.throws(() => parseDirectoryQuery({ direction: 'sideways' }), /direction/);
});

test('directory search rejects PostgREST filter syntax', () => {
  assert.throws(() => parseDirectoryQuery({ q: 'a,b' }), /unsupported/);
  assert.throws(() => parseDirectoryQuery({ q: 'name)' }), /unsupported/);
});

test('directory search escapes LIKE wildcards', () => {
  // `%` is escaped so a search for "50%" cannot match the whole table.
  assert.equal(parseDirectoryQuery({ q: '50%' }).q, '50\\%');
});

test('directory date range covers the whole end day and rejects inversion', () => {
  const query = parseDirectoryQuery({ created_from: '2026-01-01', created_to: '2026-01-31' });
  assert.equal(query.created_from, '2026-01-01T00:00:00.000Z');
  assert.equal(query.created_to, '2026-01-31T23:59:59.999Z');

  assert.throws(
    () => parseDirectoryQuery({ created_from: '2026-02-01', created_to: '2026-01-01' }),
    /must not be after/
  );
});

test('CSV cells are quoted and neutralise spreadsheet formulas', () => {
  assert.equal(escapeCsvCell('plain'), 'plain');
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(escapeCsvCell('=1+1'), "'=1+1");
  assert.equal(escapeCsvCell('+8801'), "'+8801");
  assert.equal(escapeCsvCell(null), '');
});

test('CSV output has a header row and CRLF separators', () => {
  const csv = toCsv(['id', 'name'], [['1', 'A'], ['2', 'B,C']]);
  assert.equal(csv, 'id,name\r\n1,A\r\n2,"B,C"');
});

test('risk scoring reports nothing for a quiet single-device account', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const risk = evaluateAccountRisk(
    'user-1',
    [
      {
        user_id: 'user-1',
        ip_address: '1.1.1.1',
        last_active_at: '2026-11-06T10:00:00.000Z',
        is_trusted: true,
      },
    ],
    [],
    now
  );

  assert.equal(risk.level, 'none');
  assert.deepEqual(risk.signals, []);
  assert.equal(risk.active_devices_24h, 1);
});

test('risk scoring flags heavy concurrent device use with the evidence counts', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const devices = [1, 2, 3, 4, 5].map((index) => ({
    user_id: 'user-1',
    ip_address: `10.0.0.${index}`,
    last_active_at: '2026-11-06T09:00:00.000Z',
    is_trusted: true,
  }));

  const risk = evaluateAccountRisk('user-1', devices, [], now);

  assert.equal(risk.level, 'high');
  assert.equal(risk.active_devices_24h, 5);
  assert.equal(risk.distinct_ips_24h, 5);
  assert.deepEqual(
    risk.signals.map((signal) => signal.code).sort(),
    ['CONCURRENT_DEVICES', 'DISTINCT_IPS']
  );
});

test('risk scoring ignores other users rows and stale devices', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const devices = [
    { user_id: 'someone-else', ip_address: '9.9.9.9', last_active_at: '2026-11-06T11:00:00.000Z' },
    { user_id: 'user-1', ip_address: '1.1.1.1', last_active_at: '2026-10-01T11:00:00.000Z' },
    { user_id: 'user-1', ip_address: '1.1.1.2', last_active_at: '2026-10-02T11:00:00.000Z' },
  ];

  const risk = evaluateAccountRisk('user-1', devices, [], now);

  assert.equal(risk.level, 'none');
  assert.equal(risk.active_devices_24h, 0);
  assert.equal(risk.active_devices_7d, 0);
});

test('risk scoring treats denied security events as confirmed evidence', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const audits = [1, 2, 3].map((index) => ({
    target_user_id: 'user-1',
    action: 'admin.session.revoked',
    outcome: 'denied',
    created_at: `2026-11-06T0${index}:00:00.000Z`,
  }));

  const risk = evaluateAccountRisk('user-1', [], audits, now);

  assert.equal(risk.level, 'high');
  assert.equal(risk.signals[0].code, 'DENIED_SECURITY_EVENTS');
  assert.match(risk.signals[0].label, /3 denied security events/);
});
