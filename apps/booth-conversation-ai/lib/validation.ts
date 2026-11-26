import type { LeadScore, LeadScoreDimensions, Visitor } from "@/app/types";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isText(value: unknown, max = 20000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

export function isDimensions(value: unknown): value is LeadScoreDimensions {
  return isObject(value) && ["interest", "budget", "authority", "timeline"].every(
    key => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 1 && value[key] <= 10,
  );
}

export function isLeadScore(value: unknown): value is LeadScore {
  return isObject(value) && isDimensions(value.scores) &&
    typeof value.overallScore === "number" && Number.isFinite(value.overallScore) &&
    value.overallScore >= 1 && value.overallScore <= 10 &&
    isText(value.recommendation) && isText(value.summary);
}

export function isVisitor(value: unknown): value is Visitor {
  return isObject(value) && ["id", "name", "company", "title", "email", "phone", "createdAt"].every(
    key => isText(value[key], 500),
  ) && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}
