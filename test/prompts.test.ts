import { describe, it, expect } from "vitest";
import { diagnoseStuckProcess, incidentReport } from "../src/prompts.js";

describe("diagnoseStuckProcess", () => {
  it("includes the process instance ID in all steps", () => {
    const result = diagnoseStuckProcess("abc-123");
    expect(result).toContain("abc-123");
    // Should appear in each tool call instruction
    const matches = result.match(/abc-123/g);
    expect(matches!.length).toBeGreaterThanOrEqual(5);
  });

  it("includes all 5 investigation steps", () => {
    const result = diagnoseStuckProcess("test-id");
    expect(result).toContain("Get process instance details");
    expect(result).toContain("Trace the execution path");
    expect(result).toContain("Check for incidents");
    expect(result).toContain("Inspect process variables");
    expect(result).toContain("Synthesize findings");
  });

  it("references the correct tool names", () => {
    const result = diagnoseStuckProcess("test-id");
    expect(result).toContain("get_process_instance");
    expect(result).toContain("get_activity_history");
    expect(result).toContain("list_incidents");
    expect(result).toContain("get_process_variables");
  });

  it("does NOT reference get_recent_logs (not available via REST)", () => {
    const result = diagnoseStuckProcess("test-id");
    expect(result).not.toContain("get_recent_logs");
  });
});

describe("incidentReport", () => {
  it("includes all 4 report sections", () => {
    const result = incidentReport();
    expect(result).toContain("List all open incidents");
    expect(result).toContain("For each unique process definition");
    expect(result).toContain("Incident Summary");
    expect(result).toContain("Root Cause Analysis");
    expect(result).toContain("Recommended Actions");
  });

  it("references the correct tool names", () => {
    const result = incidentReport();
    expect(result).toContain("list_incidents");
    expect(result).toContain("get_process_instance");
    expect(result).toContain("get_process_variables");
  });
});
