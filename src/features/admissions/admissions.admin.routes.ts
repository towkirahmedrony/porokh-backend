import { Router } from 'express';
import * as AdmissionAdminController from './admissions.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();

// Admission catalog management belongs to the same admin surface as exam
// authoring. requireAuth -> canonical admin role -> exams.manage permission.
router.use(
  requireAuth,
  rbacGuard(['admin']),
  requirePermission(PERMISSIONS.EXAMS_MANAGE)
);

router.get('/universities', AdmissionAdminController.listUniversities);
router.get('/universities/:universityId/units', AdmissionAdminController.listUnits);
router.post('/universities/:universityId/units', AdmissionAdminController.createUnit);

router.patch('/units/:unitId', AdmissionAdminController.updateUnit);
router.patch('/units/:unitId/status', AdmissionAdminController.setUnitStatus);
router.delete('/units/:unitId', AdmissionAdminController.deleteUnit);

export const AdmissionAdminRoutes = router;
