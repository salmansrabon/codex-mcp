import type { CompactResult } from '../schemas/compact-result.js';
import type { Evidence, Limitation } from '../schemas/review-common.js';
import type { QualifyResult } from '../schemas/qualify-result.js';

/**
 * Reduce a finished review to the decisions in it.
 *
 * Runs after every gate, on the object the gates produced, so nothing here can
 * change an outcome — it only chooses what to hand over. That ordering is the
 * safety property: if this function had run first, or had been allowed to drop
 * an entry, it would be a second reviewer with no evidence discipline.
 */

/**
 * Limitation areas that change what the author should do, as opposed to
 * explaining how the review reached its labels.
 *
 * The distinction is not severity. `verification-discipline` records that a
 * CONFIRMED became PROVISIONAL — but the entry already *says* PROVISIONAL, so
 * repeating why is diagnostics. `refutation-discipline` records that the
 * reviewer tried to overturn a finding and was not allowed to, which the author
 * cannot see anywhere else and must know about.
 */
const DECISION_AREAS = new Set([
  'refutation-discipline',
  'unsupported-assertion',
  'source-authority',
  'author-citation',
  'review-scope',
  'blast-radius-coverage',
  'release-blocker-sweep',
  'case-ceiling',
  'review-integrity',
]);

/** Verdicts that leave a submitted finding open rather than settled. */
const OPEN_VERDICTS = new Set(['UNPROVEN', 'CONFLICTING_EVIDENCE', 'INSUFFICIENT_SCOPE']);

function flatten(evidence: readonly Evidence[]): string[] {
  return evidence.map((item) => `${item.source}:${item.location}`);
}

function keepLimitation(limitation: Limitation): boolean {
  return limitation.material || DECISION_AREAS.has(limitation.area);
}

export function toCompactResult(result: QualifyResult): CompactResult {
  const mustChange: CompactResult['mustChange'] = [];
  const missing: CompactResult['missing'] = [];
  const investigate: CompactResult['investigate'] = [];
  const optional: CompactResult['optional'] = [];

  const testDesign = result.testDesign;
  if (testDesign) {
    for (const entry of testDesign.modify) {
      const target = entry.objectionPriority === 'OPTIONAL' ? optional : mustChange;
      if (target === optional) {
        optional.push({ subject: entry.candidateId, reason: entry.reason });
      } else {
        mustChange.push({
          id: entry.candidateId,
          subject: entry.candidateId,
          problem: entry.reason,
          evidence: flatten(entry.evidence),
          action: entry.recommendation,
        });
      }
    }

    for (const entry of testDesign.remove) {
      const record = {
        id: entry.candidateId,
        subject: entry.candidateId,
        problem: entry.reason,
        evidence: flatten(entry.evidence),
        action: entry.supersededBy ? `Remove; ${entry.supersededBy} already covers it.` : 'Remove this case.',
      };
      if (entry.objectionPriority === 'OPTIONAL') optional.push({ subject: entry.candidateId, reason: entry.reason });
      else mustChange.push(record);
    }

    for (const entry of testDesign.missing) {
      if (entry.objectionPriority === 'OPTIONAL') {
        // An ungrounded assertion lands here, and it belongs under
        // "investigate" rather than "optional": the reviewer is not proposing a
        // weaker test, it is reporting that nothing establishes the behavior.
        const bucket = entry.verificationStatus === 'HYPOTHESIS' ? investigate : optional;
        bucket.push({ subject: entry.title, reason: entry.reason });
        continue;
      }
      missing.push({
        risk: `${entry.title} — ${entry.reason}`,
        priority: entry.priority,
        evidence: flatten(entry.evidence),
        ...(entry.displaces[0]?.mergeInto ? { mergeInto: entry.displaces[0].mergeInto } : {}),
      });
    }

    for (const disagreement of testDesign.disagreements) {
      const record = { subject: disagreement.topic, reason: disagreement.reviewerPosition };
      if (disagreement.material) {
        mustChange.push({
          ...(disagreement.candidateId ? { id: disagreement.candidateId } : {}),
          subject: disagreement.topic,
          problem: `${disagreement.candidatePosition} vs ${disagreement.reviewerPosition}`,
          evidence: flatten(disagreement.evidence),
          action: disagreement.resolutionHint ?? 'Adjudicate this disagreement before publishing.',
        });
      } else {
        investigate.push(record);
      }
    }
  }

  let verdicts: CompactResult['verdicts'];
  const bugs = result.bugs;
  if (bugs) {
    verdicts = bugs.findings.map((finding) => ({
      id: finding.candidateId,
      verdict: finding.verdict,
      confidence: finding.confidence,
      action: finding.recommendation,
    }));

    for (const finding of bugs.findings) {
      if (OPEN_VERDICTS.has(finding.verdict)) {
        investigate.push({ subject: finding.candidateId, reason: finding.reason });
      }
    }

    for (const finding of bugs.additionalFindings) {
      const bucket = finding.objectionPriority === 'OPTIONAL' ? optional : undefined;
      if (bucket) {
        bucket.push({ subject: finding.title, reason: finding.reason });
        continue;
      }
      mustChange.push({
        subject: finding.title,
        problem: finding.reason,
        evidence: flatten(finding.evidence),
        action: 'Triage this defect; no submitted candidate covers it.',
      });
    }

    for (const disagreement of bugs.disagreements) {
      if (disagreement.material) {
        mustChange.push({
          ...(disagreement.candidateId ? { id: disagreement.candidateId } : {}),
          subject: disagreement.topic,
          problem: `${disagreement.candidatePosition} vs ${disagreement.reviewerPosition}`,
          evidence: flatten(disagreement.evidence),
          action: disagreement.resolutionHint ?? 'Adjudicate this disagreement before publishing.',
        });
      } else {
        investigate.push({ subject: disagreement.topic, reason: disagreement.reviewerPosition });
      }
    }
  }

  const discovery = result.riskDiscovery;
  if (discovery) {
    for (const finding of discovery.findings) {
      if (finding.objectionPriority === 'OPTIONAL') {
        const bucket = finding.verificationStatus === 'HYPOTHESIS' ? investigate : optional;
        bucket.push({ subject: finding.title, reason: finding.reason });
        continue;
      }
      mustChange.push({
        subject: finding.releaseBlocking ? `RELEASE BLOCKER — ${finding.title}` : finding.title,
        problem: finding.reason,
        evidence: flatten(finding.evidence),
        action: finding.recommendation,
      });
    }
  }

  const limitations = [
    ...(testDesign?.limitations ?? []),
    ...(bugs?.limitations ?? []),
    ...(discovery?.limitations ?? []),
  ]
    .filter(keepLimitation)
    .map((limitation) => ({ area: limitation.area, detail: limitation.detail, material: limitation.material }));

  const pathsRun: string[] = [];
  if (testDesign) pathsRun.push('test-design-audit');
  if (bugs) pathsRun.push('bug-audit');
  if (discovery) pathsRun.push('independent-discovery');

  // Measured rather than estimated, because the whole point of this view is a
  // size claim and an unmeasured one is marketing.
  const fullResultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');

  return {
    reviewId: result.reviewId,
    reviewType: result.reviewType,
    status: result.status,
    mustChange,
    missing,
    ...(verdicts ? { verdicts } : {}),
    investigate,
    optional,
    limitations,
    ...(testDesign?.portfolio ? { portfolio: testDesign.portfolio } : {}),
    meta: {
      depth: result.meta.depth,
      reasoningEffort: result.meta.reasoningEffort,
      durationMs: result.meta.durationMs,
      pathsRun,
      scopeComplete: result.meta.evidence.scope?.complete ?? true,
      ...(result.meta.model ? { model: result.meta.model } : {}),
      fullResultBytes,
    },
    reconciliation: {
      instruction: result.reconciliation.instruction,
      codexIsNotAuthoritative: true,
      fullResult:
        'Every traced path, contradiction search, confidence dimension, citation check, and blocker-sweep entry ' +
        'was computed and applied before this view was produced. Call codex_qualify again with `options.view: "full"` ' +
        'to receive them verbatim.',
    },
  };
}
