import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const require = createRequire(__filename);

const stub = (request: string, exports: Row) => {
  const resolved = require.resolve(request);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
};

stub('../../config/supabase', { supabase: {} });
stub('../../lib/utils/adminAudit', { recordAdminAudit: async () => undefined });

const { AdmissionAdminService } = require('./admissions.admin.service');
const {
  parseCreateAdmissionUnit,
  parseUpdateAdmissionUnit,
} = require('./admissions.validation');

const UNIVERSITY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_UNIVERSITY_ID = '22222222-2222-4222-8222-222222222222';
const COLLEGE_ID = '44444444-4444-4444-8444-444444444444';
const UNIT_ID = '33333333-3333-4333-8333-333333333333';
const MISSING_ID = '99999999-9999-4999-8999-999999999999';

class FakeQuery {
  private mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private filters: Array<{ kind: 'eq' | 'in'; column: string; value: any }> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private payload: any = null;
  private wantCount = false;
  private singleMode: 'none' | 'single' | 'maybeSingle' = 'none';
  private returning = false;
  private rangeStart: number | null = null;
  private rangeEnd: number | null = null;
  private forcedError: string | null = null;

  constructor(private tables: Tables, private table: string) {
    if (!this.tables[this.table]) this.tables[this.table] = [];
  }

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    if (this.mode === 'select') {
      this.wantCount = options?.count === 'exact';
      return this;
    }
    this.returning = true;
    return this;
  }

  insert(payload: any) {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: any) {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }

  delete() {
    this.mode = 'delete';
    return this;
  }

  eq(column: string, value: any) {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  in(column: string, value: any[]) {
    this.filters.push({ kind: 'in', column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  range(from: number, to: number) {
    this.rangeStart = from;
    this.rangeEnd = to;
    return this;
  }

  failNext(code: string) {
    this.forcedError = code;
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) =>
      filter.kind === 'eq'
        ? row[filter.column] === filter.value
        : (filter.value as any[]).includes(row[filter.column])
    );
  }

  private sort(rows: Row[]): Row[] {
    return [...rows].sort((a, b) => {
      for (const order of this.orders) {
        const left = a[order.column];
        const right = b[order.column];
        if (left === right) continue;
        if (left == null) return -1;
        if (right == null) return 1;
        const comparison = left < right ? -1 : 1;
        return order.ascending ? comparison : -comparison;
      }
      return 0;
    });
  }

  private result(rows: Row[], error: any = null) {
    if (this.wantCount) return { data: null, error, count: rows.length };
    if (this.singleMode === 'single') {
      return { data: rows[0] ? { ...rows[0] } : null, error, count: null };
    }
    if (this.singleMode === 'maybeSingle') {
      return { data: rows[0] ? { ...rows[0] } : null, error, count: null };
    }
    return { data: rows.map((row) => ({ ...row })), error, count: null };
  }

  private execute() {
    const rows = this.tables[this.table];

    if (this.forcedError) {
      return {
        data: null,
        error: { code: this.forcedError, message: 'forced database error' },
        count: null,
      };
    }

    if (this.mode === 'select') {
      const matched = this.sort(rows.filter((row) => this.matches(row)));
      const ranged =
        this.rangeStart === null || this.rangeEnd === null
          ? matched
          : matched.slice(this.rangeStart, this.rangeEnd + 1);
      return this.result(ranged);
    }

    if (this.mode === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];

      for (const item of incoming) {
        const normalized = String(item.code ?? '').trim().toLowerCase();
        const duplicate = rows.some(
          (row) =>
            row.institution_id === item.institution_id &&
            String(row.code ?? '').trim().toLowerCase() === normalized
        );
        if (duplicate) {
          return { data: null, error: { code: '23505', message: 'duplicate key' }, count: null };
        }
      }

      const now = new Date().toISOString();
      const inserted = incoming.map((item) => ({
        id: randomUUID(),
        institution_id: item.institution_id,
        name_bn: item.name_bn,
        name_en: item.name_en ?? null,
        code: item.code,
        description: item.description ?? null,
        is_active: item.is_active ?? true,
        display_order: item.display_order ?? 0,
        created_at: now,
        updated_at: now,
      }));

      rows.push(...inserted);

      return this.returning
        ? this.result(this.singleMode === 'none' ? inserted : [inserted[0]])
        : { data: null, error: null, count: null };
    }

    if (this.mode === 'update') {
      const matched = rows.filter((row) => this.matches(row));
      const now = new Date().toISOString();
      matched.forEach((row) => Object.assign(row, this.payload, { updated_at: now }));
      return this.returning
        ? this.result(this.singleMode === 'none' ? matched : [matched[0]].filter(Boolean))
        : { data: null, error: null, count: null };
    }

    const matched = rows.filter((row) => this.matches(row));
    this.tables[this.table] = rows.filter((row) => !this.matches(row));
    return this.returning
      ? this.result(this.singleMode === 'none' ? matched : [matched[0]].filter(Boolean))
      : { data: null, error: null, count: null };
  }
}

let tables: Tables;

const university = (overrides: Row = {}): Row => ({
  id: UNIVERSITY_ID,
  name_bn: 'ঢাকা বিশ্ববিদ্যালয়',
  name_en: 'University of Dhaka',
  code: '90000001',
  type: 'university',
  is_active: true,
  display_order: 1,
  ...overrides,
});

const unit = (overrides: Row = {}): Row => ({
  id: UNIT_ID,
  institution_id: UNIVERSITY_ID,
  name_bn: 'ক ইউনিট',
  name_en: 'Unit A',
  code: 'A',
  description: null,
  is_active: true,
  display_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

const db = () => ({ from: (table: string) => new FakeQuery(tables, table) }) as any;

const dbWithAdmissionWriteError = (
  operation: 'insert' | 'delete',
  code: string
) =>
  ({
    from: (table: string) => {
      const query: any = new FakeQuery(tables, table);

      if (table === 'admission_units' && operation === 'insert') {
        query.insert = () => {
          query.failNext(code);
          return query;
        };
      }

      if (table === 'admission_units' && operation === 'delete') {
        query.delete = () => {
          query.failNext(code);
          return query;
        };
      }

      return query;
    },
  }) as any;

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected request to be rejected');
    },
    (error: any) => error
  );

beforeEach(() => {
  tables = {
    institutions: [
      university(),
      university({
        id: OTHER_UNIVERSITY_ID,
        name_bn: 'রাজশাহী বিশ্ববিদ্যালয়',
        name_en: 'University of Rajshahi',
        code: '90000002',
        display_order: 2,
      }),
      university({
        id: COLLEGE_ID,
        name_bn: 'একটি কলেজ',
        name_en: 'A College',
        code: 'COLLEGE',
        type: 'college',
        display_order: 3,
      }),
    ],
    admission_units: [],
    exam_papers: [],
  };
});

test('lists only university institutions with unit totals', async () => {
  tables.admission_units.push(
    unit({ id: randomUUID(), code: 'A', is_active: true }),
    unit({ id: randomUUID(), code: 'B', is_active: false }),
    unit({ id: randomUUID(), institution_id: OTHER_UNIVERSITY_ID, code: 'A', is_active: true })
  );

  const result = await AdmissionAdminService.listUniversities(db());

  assert.equal(result.length, 2);
  assert.equal(result[0].id, UNIVERSITY_ID);
  assert.equal(result[0].unit_count, 2);
  assert.equal(result[0].active_unit_count, 1);
  assert.equal(result[1].unit_count, 1);
  assert.ok(!result.some((row: Row) => row.id === COLLEGE_ID));
});

test('creates a unit under an existing university', async () => {
  const input = parseCreateAdmissionUnit({ name_bn: '  ক ইউনিট  ', code: '  A  ' });

  const created = await AdmissionAdminService.createUnit(UNIVERSITY_ID, input, undefined, db());

  assert.equal(created.institution_id, UNIVERSITY_ID);
  assert.equal(created.name_bn, 'ক ইউনিট');
  assert.equal(created.code, 'A');
  assert.equal(created.is_active, true);
  assert.equal(created.display_order, 0);
  assert.equal(created.paper_count, 0);
  assert.equal(tables.admission_units.length, 1);
});

test('rejects a duplicate code within one university but allows it in another', async () => {
  tables.admission_units.push(unit({ code: 'A' }));

  const duplicate = await rejection(
    AdmissionAdminService.createUnit(
      UNIVERSITY_ID,
      parseCreateAdmissionUnit({ name_bn: 'খ ইউনিট', code: '  a  ' }),
      undefined,
      db()
    )
  );

  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.errorCode, 'ADMISSION_UNIT_CODE_TAKEN');

  const created = await AdmissionAdminService.createUnit(
    OTHER_UNIVERSITY_ID,
    parseCreateAdmissionUnit({ name_bn: 'ক ইউনিট', code: 'a' }),
    undefined,
    db()
  );

  assert.equal(created.institution_id, OTHER_UNIVERSITY_ID);
  assert.equal(tables.admission_units.length, 2);
});

test('updates a unit and ignores its own code during duplicate checks', async () => {
  tables.admission_units.push(unit({ code: 'A' }));

  const updated = await AdmissionAdminService.updateUnit(
    UNIT_ID,
    parseUpdateAdmissionUnit({ name_bn: 'নতুন নাম', code: ' a ' }),
    undefined,
    db()
  );

  assert.equal(updated.name_bn, 'নতুন নাম');
  assert.equal(updated.code, 'a');

  tables.admission_units.push(unit({ id: randomUUID(), code: 'C' }));
  const collision = await rejection(
    AdmissionAdminService.updateUnit(
      UNIT_ID,
      parseUpdateAdmissionUnit({ code: ' c ' }),
      undefined,
      db()
    )
  );

  assert.equal(collision.status, 409);
  assert.equal(collision.errorCode, 'ADMISSION_UNIT_CODE_TAKEN');
});

test('activates and deactivates a unit', async () => {
  tables.admission_units.push(unit());

  const deactivated = await AdmissionAdminService.setUnitStatus(UNIT_ID, false, undefined, db());
  assert.equal(deactivated.is_active, false);

  const activated = await AdmissionAdminService.setUnitStatus(UNIT_ID, true, undefined, db());
  assert.equal(activated.is_active, true);
});

test('deletes an unreferenced unit', async () => {
  tables.admission_units.push(unit());

  const deleted = await AdmissionAdminService.deleteUnit(UNIT_ID, undefined, db());

  assert.equal(deleted.id, UNIT_ID);
  assert.equal(tables.admission_units.length, 0);
});

test('refuses to delete a unit referenced by exam papers', async () => {
  tables.admission_units.push(unit());
  tables.exam_papers.push({ id: 'paper-1', admission_unit_id: UNIT_ID });

  const error = await rejection(
    AdmissionAdminService.deleteUnit(UNIT_ID, undefined, db())
  );

  assert.equal(error.status, 409);
  assert.equal(error.errorCode, 'ADMISSION_UNIT_IN_USE');
  assert.equal(error.details.paper_count, 1);
  assert.equal(tables.admission_units.length, 1);
});

test('verifies the parent exists and is a university', async () => {
  const missing = await rejection(AdmissionAdminService.listUnits(MISSING_ID, db()));
  assert.equal(missing.status, 404);
  assert.equal(missing.errorCode, 'UNIVERSITY_NOT_FOUND');

  const wrongType = await rejection(AdmissionAdminService.listUnits(COLLEGE_ID, db()));
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.errorCode, 'UNIVERSITY_INVALID_TYPE');

  const createWrongType = await rejection(
    AdmissionAdminService.createUnit(
      COLLEGE_ID,
      parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A' }),
      undefined,
      db()
    )
  );
  assert.equal(createWrongType.errorCode, 'UNIVERSITY_INVALID_TYPE');
});

test('returns 404 for missing units on update, status and delete', async () => {
  for (const operation of [
    AdmissionAdminService.updateUnit(
      MISSING_ID,
      parseUpdateAdmissionUnit({ name_bn: 'নাম' }),
      undefined,
      db()
    ),
    AdmissionAdminService.setUnitStatus(MISSING_ID, false, undefined, db()),
    AdmissionAdminService.deleteUnit(MISSING_ID, undefined, db()),
  ]) {
    const error = await rejection(operation);
    assert.equal(error.status, 404);
    assert.equal(error.errorCode, 'ADMISSION_UNIT_NOT_FOUND');
  }
});

test('aggregates unit totals across PostgREST pages', async () => {
  for (let index = 0; index < 1005; index += 1) {
    tables.admission_units.push(
      unit({
        id: randomUUID(),
        code: `U${index}`,
        is_active: index % 2 === 0,
      })
    );
  }

  const result = await AdmissionAdminService.listUniversities(db());

  assert.equal(result[0].unit_count, 1005);
  assert.equal(result[0].active_unit_count, 503);
});

test('counts paper references across PostgREST pages before blocking delete', async () => {
  tables.admission_units.push(unit());

  for (let index = 0; index < 1005; index += 1) {
    tables.exam_papers.push({
      id: `paper-${index}`,
      admission_unit_id: UNIT_ID,
    });
  }

  const error = await rejection(
    AdmissionAdminService.deleteUnit(UNIT_ID, undefined, db())
  );

  assert.equal(error.status, 409);
  assert.equal(error.errorCode, 'ADMISSION_UNIT_IN_USE');
  assert.equal(error.details.paper_count, 1005);
});

test('maps a database unique violation to the duplicate-code contract', async () => {
  const error = await rejection(
    AdmissionAdminService.createUnit(
      UNIVERSITY_ID,
      parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A' }),
      undefined,
      dbWithAdmissionWriteError('insert', '23505')
    )
  );

  assert.equal(error.status, 409);
  assert.equal(error.errorCode, 'ADMISSION_UNIT_CODE_TAKEN');
});

test('maps a database foreign-key violation on delete to the in-use contract', async () => {
  tables.admission_units.push(unit());

  const error = await rejection(
    AdmissionAdminService.deleteUnit(
      UNIT_ID,
      undefined,
      dbWithAdmissionWriteError('delete', '23503')
    )
  );

  assert.equal(error.status, 409);
  assert.equal(error.errorCode, 'ADMISSION_UNIT_IN_USE');
});
