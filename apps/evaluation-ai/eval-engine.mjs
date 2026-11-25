export const DEFAULT_THRESHOLDS = Object.freeze({ S: 4.5, A: 3.5, B: 2.5, C: 1.5 });

export function gradeFor(score, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(score)) return null;
  const entries = ['S', 'A', 'B', 'C'];
  for (const grade of entries) {
    if (score >= thresholds[grade]) return grade;
  }
  return 'D';
}

export function calculateStaffResult(staff, criteria, evaluations, thresholds = DEFAULT_THRESHOLDS) {
  const weights = new Map(criteria.map((criterion) => [criterion.id, Number(criterion.weight)]));
  let weightedTotal = 0;
  let usedWeight = 0;
  for (const evaluation of evaluations) {
    if (evaluation.staffId !== staff.id) continue;
    const weight = weights.get(evaluation.criterionId);
    if (!(weight > 0) || !Number.isInteger(evaluation.score) || evaluation.score < 1 || evaluation.score > 5) continue;
    weightedTotal += evaluation.score * weight;
    usedWeight += weight;
  }
  const score = usedWeight ? weightedTotal / usedWeight : null;
  return { staffId: staff.id, staffName: staff.name, score, grade: gradeFor(score, thresholds), evaluatedWeight: usedWeight };
}

export function calculateAllResults(staff, criteria, evaluations, thresholds = DEFAULT_THRESHOLDS) {
  return staff.map((person) => calculateStaffResult(person, criteria, evaluations, thresholds));
}

export function calculateStatistics(staff, criteria, evaluations, thresholds = DEFAULT_THRESHOLDS) {
  const criterionStats = criteria.map((criterion) => {
    const scores = evaluations
      .filter((item) => item.criterionId === criterion.id && Number.isInteger(item.score) && item.score >= 1 && item.score <= 5)
      .map((item) => item.score);
    const distribution = Object.fromEntries([1, 2, 3, 4, 5].map((score) => [score, 0]));
    for (const score of scores) distribution[score] += 1;
    return {
      criterionId: criterion.id,
      criterionName: criterion.name,
      average: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      count: scores.length,
      distribution,
    };
  });
  const gradeDistribution = Object.fromEntries(['S', 'A', 'B', 'C', 'D'].map((grade) => [grade, 0]));
  for (const result of calculateAllResults(staff, criteria, evaluations, thresholds)) {
    if (result.grade) gradeDistribution[result.grade] += 1;
  }
  const ranking = [...criterionStats].sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity));
  return { criterionStats, gradeDistribution, ranking };
}
