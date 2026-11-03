import { supabase } from '../../config/supabase';
import type { AdmissionUnitRecord, InstitutionRecord } from './exam-references.core';
import { applyReferenceChecks, type ReferenceCheck } from './question.refcheck';
import type { ParsedQuestion } from './question.textparse';

/**
 * Loads the institution and admission-unit rows (a few hundred small rows, so
 * no cache is needed and edits show up immediately) and links the parsed
 * references to them. Skipped entirely when no question names an institution.
 */
export const checkParsedReferences = async (
  questions: ParsedQuestion[]
): Promise<ReferenceCheck[]> => {
  const hasInstitution = questions.some((question) =>
    question.exam_references.some((reference) => Boolean(reference.institution_name))
  );
  if (!hasInstitution) return [];

  const [institutionResult, unitResult] = await Promise.all([
    supabase
      .from('institutions')
      .select('id, name_bn, name_en, short_name, type, code, eiin, aliases, is_active')
      .eq('is_active', true)
      .limit(5000),
    supabase
      .from('admission_units')
      .select('id, institution_id, name_bn, name_en, code, is_active')
      .eq('is_active', true)
      .limit(5000),
  ]);

  if (institutionResult.error) throw new Error(institutionResult.error.message);
  if (unitResult.error) throw new Error(unitResult.error.message);

  const unitsByInstitution = new Map<string, AdmissionUnitRecord[]>();
  for (const unit of (unitResult.data ?? []) as AdmissionUnitRecord[]) {
    const list = unitsByInstitution.get(unit.institution_id) ?? [];
    list.push(unit);
    unitsByInstitution.set(unit.institution_id, list);
  }

  return applyReferenceChecks(
    questions,
    (institutionResult.data ?? []) as InstitutionRecord[],
    unitsByInstitution
  );
};
