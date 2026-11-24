/** The in-app guide for one workspace menu, shown by the info button in the title bar. */
export interface GuideShot {
  /** File name under public/help/ (a JPEG captured by tests/ui/help-screenshots.spec.mjs). */
  file: string;
  /** What the picture shows, left to right / top to bottom. */
  caption: string;
}

export interface GuideItem {
  title: string;
  text: string;
}

export interface MenuGuide {
  /** One or two sentences: what the menu is for. */
  summary: string;
  /** Longer background: how the menu works and when to use it. */
  overview: string[];
  /** What can be done here, one entry per feature (details of use). */
  features: GuideItem[];
  /** A worked example, step by step. */
  tutorial: GuideItem[];
  /** Advice for getting more out of the menu. */
  tips: string[];
  /** Things that can go wrong or lose work. */
  cautions: string[];
  /** The agents that answer in this menu: the default one and the specialist to @mention (none where the menu has no agent panel). */
  agents?: { default: string; base: string };
  shots: GuideShot[];
}
