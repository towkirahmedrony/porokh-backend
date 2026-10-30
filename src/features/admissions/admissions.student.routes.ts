import { Router } from 'express';
import {
  getUnitContent,
  startSubjectPractice,
} from './admissions.student.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

// Admission browsing is authenticated student content. Starting practice reuses
// the server-side attempt lifecycle, so it is limited like any other start.
const practiceLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyPrefix: 'admission-practice',
});

// Unit content is read-only and normally fetched once per navigation. A
// generous per-user ceiling stops catalog scraping without interfering with
// pull-to-refresh, retries or a few open tabs.
const contentLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyPrefix: 'admission-content',
});

router.use(requireAuth);

router.get('/units/:unitId/content', contentLimit, getUnitContent);
router.post('/units/:unitId/practice', practiceLimit, startSubjectPractice);

export const AdmissionStudentRoutes = router;
