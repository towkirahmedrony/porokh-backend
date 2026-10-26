import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth';
import { rateLimit } from '../../middlewares/rateLimit';
import {
  getBookmarks,
  updateBookmark,
} from './exam.bookmark.controller';

const router = Router();

const bookmarkLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyPrefix: 'exam-bookmark',
});

// Every handler takes the owner from the verified Supabase session. A client
// never supplies user_id.
router.use(requireAuth);

router.get('/', bookmarkLimit, getBookmarks);
router.post('/', bookmarkLimit, updateBookmark);

export default router;
