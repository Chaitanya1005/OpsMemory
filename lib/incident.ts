import { z } from "zod";
import type { IncidentInput } from "../data/scenarios";

/** Size limits for incidents typed or pasted by a user. Raw logs go into the Investigator's prompt. */
export const INCIDENT_LIMITS = { title: 160, service: 63, description: 2000, logChars: 50_000, logLines: 1500 } as const;

/** Validates a user-submitted incident. Logs are free-form; lines in the usual "<ISO time> <LEVEL> <component> <message>" shape are also grouped into signatures. */
export const IncidentSubmission = z.object({
  title: z.string().trim().min(3, "Title is required").max(INCIDENT_LIMITS.title),
  service: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]*$/i, "Service: letters, digits, '.', '_' or '-' only").max(INCIDENT_LIMITS.service),
  severity: z.enum(["SEV1", "SEV2", "SEV3"]),
  description: z.string().trim().max(INCIDENT_LIMITS.description).default(""),
  logs: z
    .string()
    .trim()
    .min(1, "Paste at least one log line")
    .max(INCIDENT_LIMITS.logChars, `Logs are limited to ${INCIDENT_LIMITS.logChars.toLocaleString("en-US")} characters`)
    .refine((l) => l.split("\n").length <= INCIDENT_LIMITS.logLines, `Logs are limited to ${INCIDENT_LIMITS.logLines} lines`),
}) satisfies z.ZodType<IncidentInput>;

/** Parses a submission, throwing an error whose message lists every problem (shown to the user as a 400). */
export function parseIncident(input: unknown): IncidentInput {
  const result = IncidentSubmission.safeParse(input);
  if (!result.success) throw new Error(result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}
