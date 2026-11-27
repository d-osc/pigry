/** Writes a pull request description (and a better title) from the branch's
 * commits and diff through the agent selected in chat. */
import { chatTarget, completeText } from './aiText';
import { buildPrDescriptionPrompt, parsePrDescriptionReply } from './prDescription';
import { prDraftContext } from './tauriClient';

export const NO_PROVIDER_MESSAGE = 'No AI provider is connected — add one in Settings → AI Provider, then try again.';

export interface PrDescriptionRequest {
  /** Full refs, e.g. refs/remotes/origin/main and refs/heads/feature. */
  baseRef: string;
  compareRef: string;
  /** Branch names as the user sees them. */
  base: string;
  compare: string;
  title: string;
}

export interface GeneratedPrDescription {
  title: string | null;
  body: string;
  /** Provider/model label. */
  used: string;
  /** The template that was filled in, if the repository has one. */
  templatePath: string | null;
}

/** Throws with a message fit to show the user when no provider is connected or the call fails. */
export async function generatePrDescription(request: PrDescriptionRequest): Promise<GeneratedPrDescription> {
  const target = chatTarget('pull-requests');
  if (!target) throw new Error(NO_PROVIDER_MESSAGE);
  const context = await prDraftContext(request.baseRef, request.compareRef);
  const prompt = buildPrDescriptionPrompt({ base: request.base, compare: request.compare, title: request.title, context });
  const reply = parsePrDescriptionReply(await completeText(target, prompt, 2000));
  if (!reply.body) throw new Error(`${target.used} returned an empty description. Try again.`);
  return { ...reply, used: target.used, templatePath: context.template?.path ?? null };
}
