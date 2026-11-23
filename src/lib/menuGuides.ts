/** The in-app guides, one per workspace menu. Shown by the info button in the title bar (see HelpDialog). */
import type { WorkspaceNavId } from '../app/navigation';
import type { MenuGuide } from './menuGuides.types.ts';
import { GIT_GUIDES } from './guides/gitGuides.ts';
import { GITHUB_GUIDES } from './guides/githubGuides.ts';
import { WORKSPACE_GUIDES } from './guides/workspaceGuides.ts';

export type { GuideItem, GuideShot, MenuGuide } from './menuGuides.types.ts';

export const MENU_GUIDES: Record<WorkspaceNavId, MenuGuide> = {
  ...WORKSPACE_GUIDES,
  ...GIT_GUIDES,
  ...GITHUB_GUIDES,
};
