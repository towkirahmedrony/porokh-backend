import { Router } from 'express';
import * as ProfileController from './profile.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

// The stage is read at launch, on resume and after a goal change; the goal is
// written by a single tap on a gate, so it gets the tighter bucket.
const stageReadLimit = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'profile-stage' });
const goalWriteLimit = rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'profile-goal' });

// Private Routes (ইউজার লগইন থাকতে হবে)
router.get('/me', requireAuth, ProfileController.getMyProfile);
router.get('/stage', requireAuth, stageReadLimit, ProfileController.getMyStage);
router.patch('/goal', requireAuth, goalWriteLimit, ProfileController.updateGoal);
router.patch('/update', requireAuth, ProfileController.updateProfile);
router.patch('/theme', requireAuth, ProfileController.updateThemePreference); // নতুন রাউট
router.get('/versus/:opponentId', requireAuth, ProfileController.getVersusStats);

// Public Routes (লগইন ছাড়াও দেখা যাবে)
router.get('/public/:identifier', ProfileController.getPublicProfile);

export default router;
