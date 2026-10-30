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

router.use(requireAuth);

router.get('/units/:unitId/content', getUnitContent);
router.post('/units/:unitId/practice', practiceLimit, startSubjectPractice);

export const AdmissionStudentRoutes = router;
