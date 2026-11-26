import { Router } from 'express';
import * as historyController from './history.controller';
import * as explorerController from './history.explorer.controller';
import { requireAuth } from '../../middlewares/requireAuth';

const router = Router();

// Protect all history routes
router.use(requireAuth);

router.get('/exams', historyController.getExamHistory);
router.get('/mistakes', historyController.getMistakes);
router.get('/bookmarks', historyController.getBookmarks);

// Faceted Mistakes / Bookmarks explorer. The pool, its facet counts and the
// practice pick all come from the same SQL definition.
router.get('/explorer', explorerController.getExplorer);
router.get('/explorer/facets', explorerController.getExplorerFacets);
router.get('/explorer/count', explorerController.getExplorerCount);
router.post('/explorer/practice', explorerController.startExplorerPractice);

router.get('/mistakes/dismissed', explorerController.getDismissedMistakes);
router.post('/mistakes/restore', explorerController.restoreDismissedMistakes);

router.delete('/mistakes/:id', historyController.deleteMistake);
router.delete('/bookmarks/:id', historyController.deleteBookmark);
router.patch('/bookmarks/:id', explorerController.updateBookmarkNote);
router.post('/bookmarks', explorerController.createBookmark);

export default router;
