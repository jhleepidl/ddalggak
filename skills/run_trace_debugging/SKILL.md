# Run Trace Debugging

## Procedure
1. Identify last non-terminal step in execution graph.
2. Compare queued/running steps against latest route decision.
3. Check for reroute/approval interruptions that supersede queued work.
4. Validate membership target consistency (`requested` vs `ensured` thread).
5. Produce concrete next debug actions.
