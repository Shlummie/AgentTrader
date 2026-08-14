const MAX_TEXT = 6_000;

export class ModelOutputError extends Error {
  constructor(message, code = 'INVALID_MODEL_OUTPUT') {
    super(message);
    this.name = 'ModelOutputError';
    this.code = code;
  }
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelOutputError(`${label} must be an object`);
  return value;
}

function boundedString(value, label, { min = 1, max = MAX_TEXT } = {}) {
  if (typeof value !== 'string') throw new ModelOutputError(`${label} must be text`);
  const clean = value.trim();
  if (clean.length < min || clean.length > max) throw new ModelOutputError(`${label} must contain ${min}-${max} characters`);
  return clean;
}

function stringArray(value, label, { min = 0, max = 20 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new ModelOutputError(`${label} must contain ${min}-${max} items`);
  }
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, { max: 2_000 }));
}

export function parseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ModelOutputError('Model returned no final text');
  let candidate = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fence) candidate = fence[1];
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new ModelOutputError(`Model did not return one valid JSON object: ${error.message}`);
  }
}

export function validateDecision(value) {
  const input = plainObject(value, 'decision');
  if (!['BUY', 'SELL'].includes(input.action)) throw new ModelOutputError('action must be BUY or SELL');
  if (!Number.isInteger(input.allocationPct) || input.allocationPct < 1 || input.allocationPct > 100) {
    throw new ModelOutputError('allocationPct must be an integer from 1 through 100');
  }
  if (!Number.isInteger(input.confidencePct) || input.confidencePct < 0 || input.confidencePct > 100) {
    throw new ModelOutputError('confidencePct must be an integer from 0 through 100');
  }
  const evidence = input.evidence;
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 16) {
    throw new ModelOutputError('evidence must contain 1-16 items');
  }
  const normalizedEvidence = evidence.map((item, index) => {
    if (typeof item === 'string') return { claim: boundedString(item, `evidence[${index}]`, { max: 2_000 }), source: null };
    plainObject(item, `evidence[${index}]`);
    return {
      claim: boundedString(item.claim, `evidence[${index}].claim`, { max: 2_000 }),
      source: item.source == null ? null : boundedString(item.source, `evidence[${index}].source`, { max: 2_000 }),
      asOf: item.asOf == null ? null : boundedString(item.asOf, `evidence[${index}].asOf`, { max: 200 })
    };
  });
  if (!['complete', 'limited', 'not_used'].includes(input.researchStatus)) {
    throw new ModelOutputError('researchStatus must be complete, limited, or not_used');
  }
  return {
    action: input.action,
    allocationPct: input.allocationPct,
    confidencePct: input.confidencePct,
    thesis: boundedString(input.thesis, 'thesis'),
    evidence: normalizedEvidence,
    risks: stringArray(input.risks, 'risks', { min: 1, max: 12 }),
    invalidation: boundedString(input.invalidation, 'invalidation'),
    lessonsUsed: stringArray(input.lessonsUsed, 'lessonsUsed', { min: 0, max: 12 }),
    researchStatus: input.researchStatus
  };
}

export function validateReflection(value) {
  const input = plainObject(value, 'reflection');
  if (!['good_decision_good_outcome', 'good_decision_bad_outcome', 'bad_decision_good_outcome', 'bad_decision_bad_outcome', 'mixed'].includes(input.verdict)) {
    throw new ModelOutputError('reflection verdict is invalid');
  }
  const updatedPlaybookMarkdown = boundedString(input.updatedPlaybookMarkdown, 'updatedPlaybookMarkdown', { max: 30_000 });
  if (updatedPlaybookMarkdown.split(/\s+/).filter(Boolean).length > 2_500) throw new ModelOutputError('updatedPlaybookMarkdown must stay below 2,500 words');
  return {
    verdict: input.verdict,
    dailyReflectionMarkdown: boundedString(input.dailyReflectionMarkdown, 'dailyReflectionMarkdown', { max: 40_000 }),
    updatedPlaybookMarkdown,
    lessons: stringArray(input.lessons, 'lessons', { min: 1, max: 12 }),
    sizingAssessment: boundedString(input.sizingAssessment, 'sizingAssessment', { max: 4_000 }),
    confidenceAssessment: boundedString(input.confidenceAssessment, 'confidenceAssessment', { max: 4_000 })
  };
}

export function validateFixtureContract(value) {
  const input = plainObject(value, 'fixture response');
  if (input.contract !== 'agenttrader-v1') throw new ModelOutputError('fixture contract marker is invalid');
  if (input.ok !== true) throw new ModelOutputError('fixture ok must be true');
  return { contract: input.contract, ok: input.ok, decision: validateDecision(input.decision) };
}
