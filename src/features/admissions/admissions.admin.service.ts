import { supabase } from '../../config/supabase';
import { recordAdminAudit } from '../../lib/utils/adminAudit';
import {
  ADMISSION_ERROR_CODES,
  AdmissionError,
} from './admissions.errors';
import {
  CreateAdmissionUnitInput,
  UpdateAdmissionUnitInput,
  normalizeUnitCode,
} from './admissions.validation';

type AnyObject = Record<string, any>;
type AdmissionDb = typeof supabase;

const UNIVERSITY_COLUMNS =
  'id, name_bn, name_en, code, type, is_active, display_order';
const UNIT_COLUMNS =
  'id, institution_id, name_bn, name_en, code, description, is_active, display_order, created_at, updated_at';
const PAGE_SIZE = 1000;

interface DbError {
  code?: string;
  message?: string;
}

const databaseError = (
  error: DbError,
  operation: 'write' | 'delete' = 'write'
): Error => {
  if (error.code === '23505') {
    return new AdmissionError(
      'A unit with this code already exists for this university',
      409,
      ADMISSION_ERROR_CODES.UNIT_CODE_TAKEN
    );
  }

  if (error.code === '23503' && operation === 'delete') {
    return new AdmissionError(
      'This unit is referenced by existing exam papers. Deactivate it instead of deleting.',
      409,
      ADMISSION_ERROR_CODES.UNIT_IN_USE
    );
  }

  return new Error(error.message || 'Admission unit operation failed');
};

/**
 * PostgREST caps unpaginated reads, so aggregate by walking pages instead of
 * assuming a single response contains every row.
 */
const fetchAll = async (
  db: AdmissionDb,
  table: 'admission_units' | 'exam_papers',
  columns: string,
  applyFilters?: (query: any) => any
): Promise<AnyObject[]> => {
  const rows: AnyObject[] = [];
  let offset = 0;

  while (true) {
    let query = (db.from as any)(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (applyFilters) query = applyFilters(query);

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    const page = (data || []) as AnyObject[];
    rows.push(...page);

    if (page.length === 0) break;
    offset += page.length;
  }

  return rows;
};

const assertUniversity = async (
  universityId: string,
  db: AdmissionDb
): Promise<AnyObject> => {
  const { data, error } = await db
    .from('institutions')
    .select(UNIVERSITY_COLUMNS)
    .eq('id', universityId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    throw new AdmissionError(
      'University not found',
      404,
      ADMISSION_ERROR_CODES.UNIVERSITY_NOT_FOUND
    );
  }

  if (data.type !== 'university') {
    throw new AdmissionError(
      'The selected institution is not a university',
      400,
      ADMISSION_ERROR_CODES.UNIVERSITY_INVALID_TYPE
    );
  }

  return data;
};

const getUnit = async (unitId: string, db: AdmissionDb): Promise<AnyObject> => {
  const { data, error } = await db
    .from('admission_units')
    .select(UNIT_COLUMNS)
    .eq('id', unitId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    throw new AdmissionError(
      'Admission unit not found',
      404,
      ADMISSION_ERROR_CODES.UNIT_NOT_FOUND
    );
  }

  return data;
};

const assertCodeAvailable = async (
  universityId: string,
  code: string,
  db: AdmissionDb,
  excludeUnitId?: string
): Promise<void> => {
  const { data, error } = await db
    .from('admission_units')
    .select('id, code')
    .eq('institution_id', universityId);

  if (error) throw new Error(error.message);

  const target = normalizeUnitCode(code);
  const collision = (data || []).find(
    (row: AnyObject) =>
      String(row.id) !== excludeUnitId &&
      normalizeUnitCode(String(row.code ?? '')) === target
  );

  if (collision) {
    throw new AdmissionError(
      'A unit with this code already exists for this university',
      409,
      ADMISSION_ERROR_CODES.UNIT_CODE_TAKEN
    );
  }
};

const paperCounts = async (
  unitIds: string[],
  db: AdmissionDb
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();

  if (unitIds.length === 0) return counts;

  const rows = await fetchAll(
    db,
    'exam_papers',
    'id, admission_unit_id',
    (query) => query.in('admission_unit_id', unitIds)
  );

  rows.forEach((row: AnyObject) => {
    const unitId = String(row.admission_unit_id);
    counts.set(unitId, (counts.get(unitId) ?? 0) + 1);
  });

  return counts;
};

const withPaperCount = (unit: AnyObject, counts: Map<string, number>): AnyObject => ({
  ...unit,
  paper_count: counts.get(String(unit.id)) ?? 0,
});

export class AdmissionAdminService {
  static async listUniversities(db: AdmissionDb = supabase) {
    const { data: universities, error } = await db
      .from('institutions')
      .select(UNIVERSITY_COLUMNS)
      .eq('type', 'university')
      .order('display_order', { ascending: true })
      .order('name_bn', { ascending: true });

    if (error) throw new Error(error.message);

    const rows = (universities || []) as AnyObject[];
    if (rows.length === 0) return [];

    const units = await fetchAll(
      db,
      'admission_units',
      'id, institution_id, is_active'
    );

    const totals = new Map<string, { unit_count: number; active_unit_count: number }>();

    units.forEach((unit: AnyObject) => {
      const institutionId = String(unit.institution_id);
      const current = totals.get(institutionId) ?? {
        unit_count: 0,
        active_unit_count: 0,
      };
      current.unit_count += 1;
      if (unit.is_active === true) current.active_unit_count += 1;
      totals.set(institutionId, current);
    });

    return rows.map((university) => ({
      ...university,
      ...(totals.get(String(university.id)) ?? {
        unit_count: 0,
        active_unit_count: 0,
      }),
    }));
  }

  static async listUnits(universityId: string, db: AdmissionDb = supabase) {
    const university = await assertUniversity(universityId, db);

    const { data: units, error } = await db
      .from('admission_units')
      .select(UNIT_COLUMNS)
      .eq('institution_id', universityId)
      .order('display_order', { ascending: true })
      .order('name_bn', { ascending: true });

    if (error) throw new Error(error.message);

    const rows = (units || []) as AnyObject[];
    const counts = await paperCounts(
      rows.map((row) => String(row.id)),
      db
    );

    return {
      university,
      units: rows.map((unit) => withPaperCount(unit, counts)),
    };
  }

  static async createUnit(
    universityId: string,
    input: CreateAdmissionUnitInput,
    actorId?: string,
    db: AdmissionDb = supabase
  ) {
    await assertUniversity(universityId, db);
    await assertCodeAvailable(universityId, input.code, db);

    const { data, error } = await db
      .from('admission_units')
      .insert({ institution_id: universityId, ...input })
      .select(UNIT_COLUMNS)
      .single();

    if (error) throw databaseError(error);

    await recordAdminAudit(
      actorId,
      'admission_unit.created',
      'admission_units',
      String(data.id)
    );

    return { ...data, paper_count: 0 };
  }

  static async updateUnit(
    unitId: string,
    input: UpdateAdmissionUnitInput,
    actorId?: string,
    db: AdmissionDb = supabase
  ) {
    const unit = await getUnit(unitId, db);
    await assertUniversity(String(unit.institution_id), db);

    if (input.code !== undefined) {
      await assertCodeAvailable(
        String(unit.institution_id),
        input.code,
        db,
        unitId
      );
    }

    const { data, error } = await db
      .from('admission_units')
      .update(input)
      .eq('id', unitId)
      .select(UNIT_COLUMNS)
      .single();

    if (error) throw databaseError(error);

    if (!data) {
      throw new AdmissionError(
        'Admission unit not found',
        404,
        ADMISSION_ERROR_CODES.UNIT_NOT_FOUND
      );
    }

    const counts = await paperCounts([unitId], db);

    await recordAdminAudit(
      actorId,
      'admission_unit.updated',
      'admission_units',
      unitId
    );

    return withPaperCount(data, counts);
  }

  static async setUnitStatus(
    unitId: string,
    isActive: boolean,
    actorId?: string,
    db: AdmissionDb = supabase
  ) {
    const unit = await getUnit(unitId, db);
    await assertUniversity(String(unit.institution_id), db);

    const { data, error } = await db
      .from('admission_units')
      .update({ is_active: isActive })
      .eq('id', unitId)
      .select(UNIT_COLUMNS)
      .single();

    if (error) throw databaseError(error);

    if (!data) {
      throw new AdmissionError(
        'Admission unit not found',
        404,
        ADMISSION_ERROR_CODES.UNIT_NOT_FOUND
      );
    }

    const counts = await paperCounts([unitId], db);

    await recordAdminAudit(
      actorId,
      isActive ? 'admission_unit.activated' : 'admission_unit.deactivated',
      'admission_units',
      unitId
    );

    return withPaperCount(data, counts);
  }

  static async deleteUnit(
    unitId: string,
    actorId?: string,
    db: AdmissionDb = supabase
  ) {
    const unit = await getUnit(unitId, db);
    await assertUniversity(String(unit.institution_id), db);

    const { count, error: countError } = await db
      .from('exam_papers')
      .select('id', { count: 'exact', head: true })
      .eq('admission_unit_id', unitId);

    if (countError) throw new Error(countError.message);

    const paperCount = count ?? 0;

    if (paperCount > 0) {
      throw new AdmissionError(
        `This unit is used by ${paperCount} exam paper${paperCount === 1 ? '' : 's'}. Deactivate it instead of deleting.`,
        409,
        ADMISSION_ERROR_CODES.UNIT_IN_USE,
        { paper_count: paperCount }
      );
    }

    const { data, error } = await db
      .from('admission_units')
      .delete()
      .eq('id', unitId)
      .select(UNIT_COLUMNS)
      .single();

    if (error) throw databaseError(error, 'delete');

    if (!data) {
      throw new AdmissionError(
        'Admission unit not found',
        404,
        ADMISSION_ERROR_CODES.UNIT_NOT_FOUND
      );
    }

    await recordAdminAudit(
      actorId,
      'admission_unit.deleted',
      'admission_units',
      unitId
    );

    return withPaperCount(data, new Map());
  }
}
