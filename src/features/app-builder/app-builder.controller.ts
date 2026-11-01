import { Request, Response, NextFunction } from 'express';
import { AppBuilderService } from './app-builder.service';
import { parseLanguage } from '../../lib/utils/language';
import {
  parseBannerCreate,
  parseBannerId,
  parseBannerUpdate,
  parseConfigValue,
  parseHomeGrid,
  parseHomeGridReorder,
  parseLevels,
  parseRecordId,
  parseXpRules,
} from './app-builder.validation';

export const getAllConfigs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await AppBuilderService.getAllConfigs();
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

// --- Home Grids Controllers ---
export const getHomeGrids = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const activeOnly = req.query.active === 'true';
    const data = await AppBuilderService.getHomeGrids('bn', activeOnly);
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const saveHomeGrid = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await AppBuilderService.saveHomeGrid(parseHomeGrid(req.body));
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const reorderHomeGrids = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const grids = parseHomeGridReorder(req.body);
    const data = await AppBuilderService.reorderHomeGrids(grids);
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const deleteHomeGrid = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await AppBuilderService.deleteHomeGrid(parseRecordId(req.params.id));
    res.status(200).json({ success: true, message: 'Grid deleted successfully' });
  } catch (error) { next(error); }
};

// --- Config Controllers (Theme, Daily Quote, XP Rules) ---
export const getDailyQuote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await AppBuilderService.getPublicConfig('daily_quote');
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const saveDailyQuote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { value } = req.body; // Frontend sends { value: payload }
    const data = await AppBuilderService.saveConfig('daily_quote', parseConfigValue(value, 'daily_quote'));
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const getThemeConfig = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await AppBuilderService.getPublicConfig('theme_config');
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const saveThemeConfig = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { value } = req.body; // Frontend sends { value: config }
    const data = await AppBuilderService.saveConfig('theme_config', parseConfigValue(value, 'theme_config'));
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const getXpRules = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await AppBuilderService.getPublicConfig('xp_rules');
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const saveXpRules = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // XP rules frontend sends the whole object as body without 'value' wrapper
    const data = await AppBuilderService.saveConfig('xp_rules', parseXpRules(req.body));
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

// --- Banners Controllers ---
export const getBanners = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await AppBuilderService.getBanners(parseLanguage(req.query.lang));
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const createBanner = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await AppBuilderService.createBanner(parseBannerCreate(req.body));
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
};

export const updateBanner = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Frontend sends updates object directly as body
    const data = await AppBuilderService.updateBanner(
      parseBannerId(req.params.id),
      parseBannerUpdate(req.body)
    );
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const deleteBanner = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await AppBuilderService.deleteBanner(parseBannerId(req.params.id));
    res.status(200).json({ success: true, message: 'Banner deleted successfully' });
  } catch (error) { next(error); }
};

// --- XP Rules & Levels Controllers ---
export const getLevels = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await AppBuilderService.getLevels();
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const saveLevels = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const levels = parseLevels(req.body);
    const data = await AppBuilderService.updateLevels(levels);
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};
