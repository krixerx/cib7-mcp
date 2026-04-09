export function diagnoseStuckProcess(processInstanceId: string): string {
  return `Diagnose the stuck/stalled process instance: ${processInstanceId}

Follow these steps in order, calling each tool and analyzing the results before proceeding:

1. **Get process instance details**
   Call \`get_process_instance\` with processInstanceId="${processInstanceId}"
   - If the response says "not found", the instance has already completed or been deleted from the runtime.
     Call \`list_process_instances\` with processInstanceId="${processInstanceId}" to check the history API instead.
     If the history shows state COMPLETED or EXTERNALLY_TERMINATED, report that the process is not stuck — it already finished.
   - If found: check the \`ended\` flag (true = completed/cancelled) and \`suspended\` flag (true = manually paused by an operator)
   - Note the \`definitionId\` for later use with \`get_process_definition_xml\`
   - Note the \`businessKey\` for context

2. **Trace the execution path**
   Call \`get_activity_history\` with processInstanceId="${processInstanceId}"
   - Identify the last completed activity and its timestamp
   - Look for activities that started but never ended (these are where the process is waiting)
   - Check for unusually long durations between activities

3. **Check for incidents**
   Call \`list_incidents\` with processInstanceId="${processInstanceId}"
   - Look for failedJob or failedExternalTask incidents
   - Note any error messages that explain why the process is stuck

4. **Inspect process variables**
   Call \`get_process_variables\` with processInstanceId="${processInstanceId}"
   - Look for variables that might indicate why the process is waiting
   - Check for error flags, retry counters, or status fields
   - Note: variable values may be redacted for security

5. **Synthesize findings**
   Based on all gathered information, provide:
   - A clear diagnosis of why the process is stuck
   - The specific activity or step where it is blocked
   - The root cause (failed job, waiting for external input, missing data, etc.)
   - Recommended actions to resolve the issue`;
}

export function incidentReport(): string {
  return `Generate a comprehensive incident report for all open incidents in the process engine.

Follow these steps:

1. **List all open incidents**
   Call \`list_incidents\` with no filters to get all open incidents.
   - Group incidents by type (failedJob, failedExternalTask, etc.)
   - Group incidents by process definition key
   - Note the total count and when the oldest incident was created

2. **For each unique process definition affected:**
   Call \`get_process_instance\` for a representative process instance ID from the incidents.
   - Determine the process definition name and version
   - Check if the process is actively used or a legacy definition

3. **For each incident (or a representative sample if there are many):**
   Call \`get_process_variables\` for the affected process instance.
   - Look for variables that explain the failure context
   - Identify common patterns across incidents (same error, same variable values)

4. **Compile the report with these sections:**

   ## Incident Summary
   - Total open incidents
   - Breakdown by type and process definition
   - Time range (oldest to newest incident)

   ## Affected Processes
   For each process definition:
   - Number of affected instances
   - Common error messages
   - Typical failure point (activity ID/name)

   ## Root Cause Analysis
   - Group incidents by likely root cause
   - Identify systemic issues vs. one-off failures

   ## Recommended Actions
   For each group of incidents:
   - Specific remediation steps
   - Whether a job retry would help
   - Whether code/configuration changes are needed
   - Priority (Critical / High / Medium / Low)`;
}
