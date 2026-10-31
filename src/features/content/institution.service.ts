import { supabase } from '../../config/supabase';
import { COMMON_BOARD_NAMES, COMMON_COLLEGE_NAMES, COMMON_COLLEGE_CODES } from './institution.constants';

// Added local type definition
export interface InstitutionPayload {
  [key: string]: any;
}

// 🚀 Deterministic Code Generator for unknown institutions
const generateDeterministicCode = (name: string, kind: string) => {
  const cleanString = name.toLowerCase().replace(/[\.\,\-\(\)\&\s]/g, '');
  return `${kind.toUpperCase()}_${cleanString.substring(0, 15)}`;
};

export const getInstitutions = async () => {
  const { data, error } = await supabase
    .from('institutions')
    .select('*')
    .order('name_bn', { ascending: true });

  if (error) throw new Error(error.message);
  return data;
};

export const createInstitution = async (payload: Partial<InstitutionPayload>) => {
  const { data, error } = await supabase
    .from('institutions')
    .insert(payload)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
};

export const updateInstitution = async (id: string, payload: Partial<InstitutionPayload>) => {
  const { data, error } = await supabase
    .from('institutions')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
};

export const deleteInstitution = async (id: string) => {
  const { error } = await supabase
    .from('institutions')
    .delete()
    .eq('id', id);

  if (error) throw new Error(error.message);
  return true;
};

export const autoCreateMissingInstitutions = async (questionsData: Record<string, unknown>[]) => {
  const newInstitutionsMap = new Map<string, any>();

  const extractRefs = (dataList: any[]) => {
    for (const item of dataList) {
      if (item.type === 'Comprehension' && Array.isArray(item.questions)) {
        extractRefs(item.questions);
      } else if (Array.isArray(item.exam_references)) {
        for (const ref of item.exam_references) {
          const kind = ref.source_kind;
          const rawName = ref.institution_name || ref.board || ref.name;

          if (kind && rawName && typeof rawName === 'string' && ['board', 'college', 'admission', 'school', 'university'].includes(kind)) {
            const nameStr = rawName.trim();
            const isBengali = /[\u0980-\u09FF]/.test(nameStr);
            let resolvedBnName = isBengali ? nameStr : (ref.name_bn || ref.institution_name_bn || ref.board_bn);
            
            if (!resolvedBnName && !isBengali) {
              if (kind === 'board') {
                resolvedBnName = COMMON_BOARD_NAMES[nameStr.toLowerCase()];
              } else if (kind === 'college') {
                resolvedBnName = COMMON_COLLEGE_NAMES[nameStr.toLowerCase()];
              }
            }
            
            if (!resolvedBnName) resolvedBnName = nameStr; 

            let resolvedEnName = !isBengali ? nameStr : (ref.name_en || ref.institution_name_en || ref.board_en || null);
            
            // 🚀 ইউজার প্রোভাইডেড EIIN রিসিভ করা (ফ্রন্টএন্ড থেকে পাঠানো)
            const userProvidedEiin = ref.eiin as string | null;

            // 🚀 কোড সিলেকশন লজিক: ১. ইউজার দিলে সেটি, ২. কনস্ট্যান্ট ম্যাপ থেকে, ৩. না থাকলে জেনারেটেড কোড
            let finalCode = userProvidedEiin || COMMON_COLLEGE_CODES[resolvedBnName];
            const eiinValue = userProvidedEiin || COMMON_COLLEGE_CODES[resolvedBnName] || null;

            if (!finalCode) {
              finalCode = generateDeterministicCode(resolvedBnName, kind);
            }

            // Map-এ ইনসার্ট করার সময় কোড-কে Key হিসেবে ব্যবহার
            if (!newInstitutionsMap.has(finalCode)) {
              newInstitutionsMap.set(finalCode, {
                name_bn: resolvedBnName,
                name_en: resolvedEnName,
                code: finalCode, // ইউনিক আইডেন্টিফায়ার
                eiin: eiinValue,
                aliases: [nameStr],
                type: kind,
                is_verified: !!eiinValue // EIIN থাকলে সরাসরি ভেরিফাইড
              });
            }
          }
        }
      }
    }
  };

  extractRefs(questionsData);

  if (newInstitutionsMap.size === 0) return;

  // 🚀 ডাটাবেইজ থেকে বিদ্যমান কোডগুলো চেক করা
  const { data: existing } = await supabase.from('institutions').select('code');
  const existingCodes = new Set(existing?.map((item: any) => item.code) || []);

  // শুধুমাত্র সেই ইনস্টিটিউশনগুলো ফিল্টার করা যাদের কোড ডাটাবেইজে নেই
  const toInsert = Array.from(newInstitutionsMap.values()).filter(
    (inst) => !existingCodes.has(inst.code)
  );

  if (toInsert.length > 0) {
    await supabase.from('institutions').insert(toInsert);
  }
};

/**
 * Read-only admission units for the content editors. The write surface stays
 * on the admissions admin routes; content authors only need the labels to
 * attach an optional unit to an exam reference.
 */
export const getInstitutionAdmissionUnits = async (institutionId: string) => {
  const { data, error } = await supabase
    .from('admission_units')
    .select('id, institution_id, name_bn, name_en, code, is_active, display_order')
    .eq('institution_id', institutionId)
    .order('display_order', { ascending: true })
    .order('name_bn', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
};
