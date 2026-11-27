# Question Bank Levels (HSC vs Admission) Implementation Plan

> **For agentic workers:** implement task by task. Steps use `- [ ]` checkboxes. Do not apply the migration before the owner has approved the SQL.

**Goal:** Give every question an HSC or admission level derived from its existing preparation tracks, and make the student bank, the backend and the admin panel level-aware without adding a level column.

**Architecture:** `public.question_preparation_tracks` stays the only source of truth. `public.v_question_levels` is the single place the level is defined, and it is built from tags, not from references. Auto tags are derived from institution type: a university reference yields that university's track, everything else yields `hsc`. Two new SECURITY DEFINER RPCs read from one internal row source (`_qb_base`) so the facet counts and the question list can never disagree, and the stage rule is enforced inside that source rather than in the client.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, Node/Express/TypeScript, React 18 + Vite + TanStack Query, Tailwind, Capacitor Android.

**Spec:** this task brief. Full audit findings are in the accompanying report; the numbers below are from the live project `pbswsbfcmztmbcqnuqny`.

## Global Constraints

- Never add a `level` column to `public.questions`.
- Every new function is `SECURITY DEFINER` with `set search_path = ''` and every relation schema-qualified. `public.get_student_weaknesses` is the standing proof of what skipping that costs.
- Never accept a student id as a parameter on a student-facing RPC; derive it from `auth.uid()`.
- `EXECUTE` on student-facing RPCs goes to `authenticated` only; admin read models go to `service_role` only.
- Manual tags win. The sync only inserts and deletes rows whose `source = 'auto'`.
- A student with stage `admission_prep` must never receive HSC rows, even when the client asks for them.
- Stage comes from `get_my_stage()`. Never from a device clock.
- Bangla UI, `localizedDigits`, existing teal/amber tokens, 360px width, 44px tap targets, light and dark, no emoji.
- No new indexes unless an `EXPLAIN` on the real data asks for one.

## Review Focus

- A `studying` student with no goal set opens the ভর্তি tab: the bank must show every admission track, not an empty list.
- A question referenced by both a board and a university: it must not appear at HSC level, because the create-trigger writes `hsc` first and the reference trigger later removes it.
- A question imported with zero references: it must land at HSC level without any admin action.
- A manual `medical` tag added on a question that already has auto `hsc`: the sync must not strip either one.
- The facet sheet after switching tab: counts must belong to the new tab, not the previous one, including the first render before any filter is touched.

---

### Task 1: Database — level view, derivation, trigger, backfill

**Files:**
- Create: `supabase/migrations/20261127120000_question_bank_levels.sql` (already written)
- Create: `supabase/rollbacks/20261127120000_question_bank_levels.down.sql` (already written)

**Interfaces — Produces:**
- `public.v_question_levels(question_id uuid, track_ids text[], has_tracks boolean, is_hsc boolean, is_admission boolean, level text)`
- `public.derive_question_track_ids(p_question_id uuid) returns text[]` — unchanged signature, new body
- `public.trg_questions_sync_auto_tracks()` — new trigger function, `AFTER INSERT ON public.questions`

- [ ] **Step 1: Approve and apply.** Run the migration inside a rolled-back transaction first, then for real. Expected: no error, and the backfill inserts 75 rows.
- [ ] **Step 2: Verify the level totals.** Every active question has `has_tracks`, `is_hsc = 267`, `is_admission = 3467`, `both = 49`, untracked `0`.
- [ ] **Step 3: Verify the orphan report.** `select bucket, count(*) from public.get_question_level_report() group by 1` returns 7 rows in `blank_institution_reference` and 24 in `manual_admission_without_reference`.
- [ ] **Step 4: Verify the trigger.** Insert a throwaway question with no references and no tags, assert `question_preparation_tracks` gets `('hsc','auto')`, then delete it.

### Task 2: Database — level-aware RPCs

**Files:** same migration, sections 5 to 7.

**Interfaces — Produces:**
- `public.get_student_question_bank_v3(p_level text, p_track text, p_include_other_admission_tracks boolean, p_subject_id text, p_chapter_id text, p_topic_id text, p_sort text, p_search text, p_bookmarked_only boolean, p_mistakes_only boolean, p_premium_only boolean, p_institution_id uuid, p_admission_unit_id uuid, p_year text, p_limit integer, p_offset integer) returns setof jsonb` — same keys as v2 plus `level`, `levels`, `tracks`, `institution`, `admission_unit`, `exam_year`
- `public.get_question_bank_facets(...) returns table(facet text, id text, parent_id text, label_bn text, label_en text, cnt integer)`
- `public._qb_base(..., p_ignore text)` — internal, `service_role` only

- [ ] **Step 1: Verify HSC isolation.** Call v3 as an `admission_prep` profile with `p_level => 'hsc'`. Expected: 0 rows.
- [ ] **Step 2: Verify both levels for a `studying` profile.** `p_level => 'hsc'` returns 267, `p_level => 'admission'` returns 3467.
- [ ] **Step 3: Verify facets.** With `p_level => 'hsc'`, the `subject` facet returns only subjects holding HSC questions and none of them has `cnt = 0`.
- [ ] **Step 4: Verify the service-only grants.** `select has_function_privilege('authenticated', 'public._qb_base(uuid,text,text,text,boolean,text,text,text,uuid,uuid,text,text,boolean,boolean,boolean,boolean,text)', 'execute')` is false.

### Task 3: Backend — admin track routes and level filters

**Files:**
- Modify: `src/features/content/content.service.ts` — accept `level`, `track`, `untracked`, `conflict` on the question list
- Create: `src/features/content/question.level.service.ts`
- Create: `src/features/content/question.level.controller.ts`
- Modify: `src/features/content/content.routes.ts`
- Modify: `src/features/content/question.import.service.ts` — no change needed if Task 1's trigger lands; assert it in a test instead
- Test: `src/features/content/question.level.spec.ts`

**Interfaces — Produces:**
- `GET /content/questions/level-report` → `{ counts: {hsc, admission, both, untracked}, buckets: Array<{bucket, count}> }`
- `PUT /content/questions/:id/tracks` body `{ tracks: string[], source: 'manual' }`
- `POST /content/questions/tracks/bulk` body `{ questionIds: string[], add: string[], remove: string[] }`
- `setQuestionTracks(questionId, tracks)` and `setQuestionsTracksBulk(ids, add, remove)` in `question.level.service.ts`

- [ ] **Step 1: Write the failing test** for `parseTrackFilter({ level: 'admission', track: 'medical' })` rejecting `track: 'hsc'` and accepting `level: 'HSC'` case-insensitively.
- [ ] **Step 2: Run it, expect failure.**
- [ ] **Step 3: Implement** the parser and the service, reusing `PREPARATION_TRACK_IDS` and the existing rbac guard + audit-log call pattern from `content.routes.ts`.
- [ ] **Step 4: Run the test, expect pass.**
- [ ] **Step 5: Run `npm test` and `npx tsc --noEmit` for the repo.**

### Task 4: Admin panel — level chips, filters, editor, bulk, import, report

**Files:**
- Modify: `src/features/content/api/useQuestionBank.ts` — forward `level`/`track` filters, expose `levelReport`
- Modify: `src/features/content/components/QuestionBank/components/FilterControls.tsx`
- Modify: `src/features/content/components/QuestionBank/components/QuestionTableRow.tsx` — level + track chips
- Modify: `src/features/content/components/QuestionBank/components/EditModalSidebar.tsx` — track editor with source and the auto-rule hint
- Modify: `src/features/content/components/QuestionBank/components/BulkActionBar.tsx`
- Modify: `src/features/content/components/QuestionBank/components/DashboardStats.tsx`
- Modify: `src/features/content/components/BulkQuestionManager/components/PreviewTable.tsx` — show the level the import will assign
- Modify: `src/features/content/lib/preparationCategory.ts` — add `LEVEL_LABELS` and `trackSourceLabel`

- [ ] **Step 1: Add the chips** to `QuestionTableRow`, driven by a `levels` and `tracks` field on the row.
- [ ] **Step 2: Add the filters** and confirm the list request carries them.
- [ ] **Step 3: Add the editor section** showing each track with `auto`/`manual`, plus the warning row when a manual admission tag exists on a question with no university reference.
- [ ] **Step 4: Add the bulk action** writing through `POST /content/questions/tracks/bulk`.
- [ ] **Step 5: Add the needs-attention card** reading `/content/questions/level-report`.
- [ ] **Step 6: Check at 360px**, light and dark, then `npx tsc --noEmit` and `npm run build`.

### Task 5: Student app — bank modes

**Files:**
- Create: `src/features/question-bank/utils/bankMode.ts` + `bankMode.test.ts`
- Create: `src/features/question-bank/services/questionBankLevelService.ts`
- Modify: `src/features/question-bank/types/questionBank.ts`
- Modify: `src/features/question-bank/services/questionBankService.ts` — v3 with v2 fallback via `isMissingRpcError`
- Modify: `src/features/question-bank/hooks/useQuestionBank.ts`
- Create: `src/features/question-bank/components/LevelSegmentedControl.tsx`
- Create: `src/features/question-bank/components/BankFilterSheet.tsx`
- Create: `src/features/question-bank/components/BankGoalEmptyState.tsx`
- Modify: `src/features/question-bank/pages/QuestionBank.tsx`
- Modify: `src/features/question-bank/utils/questionBankUrlState.ts` — carry `level`, `track`, `allTracks`
- Modify: `src/shared/i18n/messages.ts` — the new Bangla strings

**Interfaces — Produces:**
- `resolveBankMode(state: {stage: StudyStage | null, goal: StudyGoal | null, status: StageStatus}): {mode: 'hsc' | 'admission' | 'neutral', segmented: boolean, defaultTrack: string | null}`
- `fetchQuestionBankFacets(filters): Promise<QuestionBankFacets>`
- `QuestionBankFilterState` gains `level: 'hsc' | 'admission'`, `track: '' | 'varsity' | 'medical' | 'engineering'`, `allTracks: boolean`, `institutionId: string`, `admissionUnitId: string`

- [ ] **Step 1: Write the failing test** in `bankMode.test.ts`: `studying` with no goal returns `{mode: 'hsc', segmented: true, defaultTrack: null}`; `admission_prep` with goal `medical` returns `{mode: 'admission', segmented: false, defaultTrack: 'medical'}`; `post_hsc` returns `mode: 'neutral'`; `status: 'loading'` returns `mode: 'neutral'`.
- [ ] **Step 2: Run it, expect failure.**
- [ ] **Step 3: Implement `resolveBankMode`** as a pure function with no date logic.
- [ ] **Step 4: Run it, expect pass.**
- [ ] **Step 5: Switch the service to v3** with the v2 fallback, keeping `fetchQuestionPage`'s return contract.
- [ ] **Step 6: Add the segmented control** for `studying` only, and the `সব ভর্তি প্রশ্ন` chip for admission mode only.
- [ ] **Step 7: Add the filter sheet** behind one icon with an active-count badge, fed by the facet RPC; hide options with `cnt = 0`.
- [ ] **Step 8: Add the goal empty state** with a button that clears `track` and sets `allTracks`.
- [ ] **Step 9: Persist tab and filters per session** through the existing `questionBankSession` helper, keeping scroll restore.
- [ ] **Step 10: Run `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run lint`.**

### Task 6: End-to-end verification

- [ ] Create two throwaway profiles (one `studying`, one `admission_prep` with goal `varsity`), verify every server rule, then delete them and their rows. Never touch the owner's profile or `hsc_batches`.
- [ ] Call v3 as `admission_prep` with `p_level => 'hsc'` and grep the payload for known HSC-only ids. Expected: nothing.
- [ ] Call v3 passing another profile's id where an id is accepted. Expected: `forbidden`.
- [ ] Confirm bookmarks, mistakes, practice, search, premium and pagination still work from the bank screen.
- [ ] Record the results in the final report, per check.
