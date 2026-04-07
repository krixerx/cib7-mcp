const REDACTED = "[REDACTED]";
const CANARY_TIMEOUT_MS = 100;
const CANARY_STRING = "a".repeat(50) + "b";

export function createRedactor(
  patternsEnv: string | undefined
): (obj: Record<string, unknown>) => Record<string, unknown> {
  if (!patternsEnv || patternsEnv.trim() === "") {
    return (obj) => obj;
  }

  const patternStrings = patternsEnv.split(",").map((p) => p.trim()).filter(Boolean);
  const regexes = patternStrings.map((p) => {
    let regex: RegExp;
    try {
      regex = new RegExp(p, "i");
    } catch {
      throw new Error(`Invalid redaction pattern: "${p}"`);
    }

    // ReDoS guard: test against canary string
    const start = performance.now();
    regex.test(CANARY_STRING);
    const elapsed = performance.now() - start;
    if (elapsed > CANARY_TIMEOUT_MS) {
      throw new Error(
        `Redaction pattern "${p}" is too slow (${elapsed.toFixed(0)}ms on canary). Possible ReDoS.`
      );
    }

    return regex;
  });

  function shouldRedact(key: string): boolean {
    return regexes.some((r) => r.test(key));
  }

  function redactValue(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (shouldRedact(key)) {
        result[key] = REDACTED;
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        result[key] = redactValue(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          item !== null && typeof item === "object" && !Array.isArray(item)
            ? redactValue(item as Record<string, unknown>)
            : item
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return redactValue;
}
