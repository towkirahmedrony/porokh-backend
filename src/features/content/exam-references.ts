import { supabase } from '../../config/supabase';
import {
  asRecord,
  normalizeExamReference,
  normalizeReferenceSourceKind,
  parseReferenceList,
  readId,
  referenceKindMatchesInstitutionType,
  referenceNameVariants,
  type AdmissionUnitRecord,
  type InstitutionRecord,
  type ReferenceLookups,
} from './exam-references.core';

export * from './exam-references.core';

const readIds = (
  lists: Array<unknown[] | null | undefined>
): { institutionIds: string[]; unitIds: string[] } => {
  const institutionIds = new Set<string>();
  const unitIds = new Set<string>();

  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      const record = asRecord(item);
      if (!record) continue;

      const institutionId = readId(record.institution_id, 'institution_id');
      if (institutionId) institutionIds.add(institutionId);

      const unitId = readId(record.unit_id, 'unit_id');
      if (unitId) unitIds.add(unitId);
    }
  }

  return {
    institutionIds: Array.from(institutionIds),
    unitIds: Array.from(unitIds),
  };
};

const addInstitutions = (
  lookups: ReferenceLookups,
  rows: InstitutionRecord[] | null | undefined
): void => {
  for (const row of rows ?? []) {
    lookups.institutions.set(String(row.id), row);
  }
};

/**
 * Best-effort link for legacy name-only references. A name or code is only
 * linked when exactly one institution matches and the declared source kind is
 * compatible; otherwise the reference stays name-only instead of failing an
 * older import.
 */
const augmentWithLegacyMatches = async (
  lists: Array<unknown[] | null | undefined>,
  lookups: ReferenceLookups
): Promise<void> => {
  const codes = new Set<string>();
  const names = new Set<string>();
  const references: Record<string, unknown>[] = [];

  for (const list of lists) {
    for (const item of list ?? []) {
      const record = asRecord(item);
      if (!record || record.institution_id) continue;
      references.push(record);

      const code = typeof record.code === 'string' ? record.code.trim() : '';
      const eiin = typeof record.eiin === 'string' ? record.eiin.trim() : '';
      if (code) codes.add(code);
      if (eiin) codes.add(eiin);

      const name = [record.institution_name, record.board, record.name]
        .find((value): value is string => typeof value === 'string' && value.trim() !== '');
      if (name) names.add(name.trim());
    }
  }

  if (references.length === 0) return;

  if (codes.size > 0) {
    const codeList = Array.from(codes);
    const [byCode, byEiin] = await Promise.all([
      supabase
        .from('institutions')
        .select('id, name_bn, name_en, short_name, type, code, eiin, is_active')
        .in('code', codeList),
      supabase
        .from('institutions')
        .select('id, name_bn, name_en, short_name, type, code, eiin, is_active')
        .in('eiin', codeList),
    ]);

    if (byCode.error) throw new Error(byCode.error.message);
    if (byEiin.error) throw new Error(byEiin.error.message);
    addInstitutions(lookups, byCode.data as InstitutionRecord[] | null);
    addInstitutions(lookups, byEiin.data as InstitutionRecord[] | null);
  }

  if (names.size > 0) {
    const nameList = Array.from(names);
    const [byBn, byEn] = await Promise.all([
      supabase
        .from('institutions')
        .select('id, name_bn, name_en, short_name, type, code, eiin, is_active')
        .in('name_bn', nameList),
      supabase
        .from('institutions')
        .select('id, name_bn, name_en, short_name, type, code, eiin, is_active')
        .in('name_en', nameList),
    ]);

    if (byBn.error) throw new Error(byBn.error.message);
    if (byEn.error) throw new Error(byEn.error.message);
    addInstitutions(lookups, byBn.data as InstitutionRecord[] | null);
    addInstitutions(lookups, byEn.data as InstitutionRecord[] | null);
  }

  const allInstitutions = Array.from(lookups.institutions.values());

  for (const reference of references) {
    const kind = normalizeReferenceSourceKind(reference.source_kind);
    const code = [reference.code, reference.eiin]
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      ?.trim()
      .toLowerCase();
    const name = [reference.institution_name, reference.board, reference.name]
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      ?.trim()
      .toLowerCase();

    const referenceVariants = name ? new Set(referenceNameVariants(name, kind)) : null;

    const candidates = allInstitutions.filter((institution) => {
      if (!referenceKindMatchesInstitutionType(kind, institution.type)) return false;

      const institutionCode = (institution.code ?? '').toLowerCase();
      const institutionEiin = (institution.eiin ?? '').toLowerCase();
      if (code && (institutionCode === code || institutionEiin === code)) return true;

      if (!referenceVariants) return false;
      return [institution.name_bn, institution.name_en, institution.short_name]
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        .some((value) =>
          referenceNameVariants(value, kind).some((variant) => referenceVariants.has(variant))
        );
    });

    if (candidates.length === 1) {
      reference.institution_id = candidates[0].id;
    }
  }
};

const fetchLookups = async (institutionIds: string[], unitIds: string[]): Promise<ReferenceLookups> => {
  const institutions = new Map<string, InstitutionRecord>();
  const units = new Map<string, AdmissionUnitRecord>();

  const [institutionResult, unitResult] = await Promise.all([
    institutionIds.length
      ? supabase
          .from('institutions')
          .select('id, name_bn, name_en, short_name, type, code, eiin, is_active')
          .in('id', institutionIds)
      : Promise.resolve({ data: [], error: null }),
    unitIds.length
      ? supabase
          .from('admission_units')
          .select('id, institution_id, name_bn, name_en, code, is_active')
          .in('id', unitIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (institutionResult.error) throw new Error(institutionResult.error.message);
  if (unitResult.error) throw new Error(unitResult.error.message);

  for (const row of institutionResult.data ?? []) {
    institutions.set(String((row as InstitutionRecord).id), row as InstitutionRecord);
  }

  for (const row of unitResult.data ?? []) {
    units.set(String((row as AdmissionUnitRecord).id), row as AdmissionUnitRecord);
  }

  const missingInstitutionIds = Array.from(
    new Set(
      Array.from(units.values())
        .map((unit) => unit.institution_id)
        .filter((id) => id && !institutions.has(id))
    )
  );

  if (missingInstitutionIds.length) {
    const { data, error } = await supabase
      .from('institutions')
      .select('id, name_bn, name_en, short_name, type, code, eiin, is_active')
      .in('id', missingInstitutionIds);

    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      institutions.set(String((row as InstitutionRecord).id), row as InstitutionRecord);
    }
  }

  return { institutions, units };
};

/** Resolves a batch of reference lists with one lookup round-trip per table. */
export const resolveExamReferenceLists = async (
  inputs: unknown[]
): Promise<Array<unknown[] | null | undefined>> => {
  const parsed = inputs.map(parseReferenceList);
  const { institutionIds, unitIds } = readIds(parsed);
  const lookups = await fetchLookups(institutionIds, unitIds);
  await augmentWithLegacyMatches(parsed, lookups);

  return parsed.map((list) => {
    if (list === null || list === undefined) return list;

    return list.map((item) => {
      const record = asRecord(item);
      return record ? normalizeExamReference(record, lookups) : item;
    });
  });
};

export const resolveExamReferences = async (input: unknown): Promise<unknown[] | null | undefined> => {
  const [resolved] = await resolveExamReferenceLists([input]);
  return resolved;
};

/** Copies a question body with its references resolved, when the field is present. */
export const withResolvedExamReferences = async <T extends Record<string, unknown>>(
  question: T
): Promise<T> => {
  if (!Object.prototype.hasOwnProperty.call(question, 'exam_references')) return question;

  return {
    ...question,
    exam_references: await resolveExamReferences(question.exam_references),
  };
};
