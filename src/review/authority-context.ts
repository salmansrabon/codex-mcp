import type { PromptContext } from '../prompts/base-reviewer.js';
import { EMPTY_AUTHORITY_CONTEXT, type AuthorityContext } from './verification-gate.js';

/**
 * The two facts the authority gate needs, read out of the evidence rather than
 * out of the review.
 *
 * Both exist to stop a claim being settled by asserting it. A precedence
 * override may only name a rule that was actually retrieved, and an acceptance
 * criterion may only ground a blocking demand if the author did not mark it as
 * their own inference. Neither is something the reviewer gets to declare.
 */
export function authorityContextFrom(
  context: Pick<PromptContext, 'rules' | 'requirement'>,
): AuthorityContext {
  const retrievedRules = new Set((context.rules?.selected ?? []).map((rule) => rule.path));
  const inferredCriterionIds = new Set(
    (context.requirement?.acceptanceCriteria ?? [])
      .filter((criterion) => criterion.provenance === 'inferred')
      .map((criterion) => criterion.id),
  );

  if (retrievedRules.size === 0 && inferredCriterionIds.size === 0) return EMPTY_AUTHORITY_CONTEXT;
  return { retrievedRules, inferredCriterionIds };
}
