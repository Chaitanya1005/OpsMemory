/**
 * Runs once when the server starts. Checks configuration so a missing key fails
 * the deploy with a clear message instead of failing on a visitor's first click.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configProblems } = await import("./lib/config");
  const problems = configProblems();
  if (problems.length === 0) return;
  const message = `OpsMemory configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`;
  // In development, warn and keep serving so the dashboard can show what is missing.
  if (process.env.NODE_ENV === "production") throw new Error(message);
  console.warn(message);
}
