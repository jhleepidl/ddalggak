import { normalizeExecutionCheckpointList } from "../domain/execution_checkpoint.js";

export function buildExecutionCheckpoints({
  slots = [],
  runtimeAgents = [],
  supervisorRuntime = null,
  collaborationCells = [],
} = {}) {
  const checkpoints = [];
  const reviewerSlots = slots.filter((slot) => slot.role_id === "reviewer");
  const synthesizerSlots = slots.filter((slot) => slot.role_id === "synthesizer");
  const operatorSlots = slots.filter((slot) => slot.role_id === "operator");
  const runtimeAgentsBySlotId = new Map(
    runtimeAgents
      .map((agent) => [String(agent?.slot_id || "").trim(), agent])
      .filter(([slotId]) => slotId)
  );
  const reviewerInstanceIds = reviewerSlots
    .map((slot) => runtimeAgentsBySlotId.get(slot.slot_id)?.instance_id)
    .filter(Boolean);
  const synthesizerInstanceIds = synthesizerSlots
    .map((slot) => runtimeAgentsBySlotId.get(slot.slot_id)?.instance_id)
    .filter(Boolean);
  const reflectionMemberIds = collaborationCells
    .filter((cell) => cell?.pattern === "reflection")
    .flatMap((cell) => Array.isArray(cell?.member_instance_ids) ? cell.member_instance_ids : [])
    .filter(Boolean);

  if (reviewerSlots.length > 0) {
    checkpoints.push({
      checkpoint_id: "checkpoint_review_gate",
      label: "Review Gate",
      kind: "quality_gate",
      target_slot_ids: reviewerSlots.map((slot) => slot.slot_id),
      trigger_after_instances: reviewerInstanceIds,
      supervisor_decision: supervisorRuntime?.enabled === true ? "review_gate" : "continue",
      human_interrupt_allowed: true,
      approval_required: false,
      completion_signal: { when: "review_complete" },
      selection_reason: "reviewer slot present",
    });
  }
  if (reflectionMemberIds.length > 0) {
    checkpoints.push({
      checkpoint_id: "checkpoint_reflection_round",
      label: "Reflection Round",
      kind: "reflection",
      target_slot_ids: slots
        .filter((slot) => {
          const instanceId = runtimeAgentsBySlotId.get(slot.slot_id)?.instance_id;
          return instanceId && reflectionMemberIds.includes(instanceId);
        })
        .map((slot) => slot.slot_id),
      trigger_after_instances: reflectionMemberIds,
      supervisor_decision: supervisorRuntime?.enabled === true ? "decide_reflection_continue" : "bounded_continue",
      human_interrupt_allowed: true,
      approval_required: false,
      completion_signal: { when: "reflection_round_complete" },
      selection_reason: "reflection collaboration present",
    });
  }
  if (synthesizerSlots.length > 0) {
    checkpoints.push({
      checkpoint_id: "checkpoint_output_ready",
      label: "Output Ready",
      kind: "handoff",
      target_slot_ids: synthesizerSlots.map((slot) => slot.slot_id),
      trigger_after_instances: synthesizerInstanceIds,
      supervisor_decision: supervisorRuntime?.enabled === true ? "publish_or_reroute" : "continue",
      human_interrupt_allowed: true,
      approval_required: supervisorRuntime?.interaction_mode === "checkpointed_supervised",
      completion_signal: { when: "summary_ready" },
      selection_reason: "synthesizer slot present",
    });
  }
  if (operatorSlots.length > 0) {
    checkpoints.push({
      checkpoint_id: "checkpoint_operator_guard",
      label: "Operator Guard",
      kind: "approval",
      target_slot_ids: operatorSlots.map((slot) => slot.slot_id),
      trigger_after_instances: operatorSlots
        .map((slot) => runtimeAgentsBySlotId.get(slot.slot_id)?.instance_id)
        .filter(Boolean),
      supervisor_decision: "operator_ack",
      human_interrupt_allowed: true,
      approval_required: true,
      completion_signal: { when: "operator_ack" },
      selection_reason: "operator slot present",
    });
  }
  if (supervisorRuntime?.enabled === true && checkpoints.length === 0) {
    checkpoints.push({
      checkpoint_id: "checkpoint_supervisor_summary",
      label: "Supervisor Summary",
      kind: "supervisor",
      target_slot_ids: slots.map((slot) => slot.slot_id).slice(0, 8),
      trigger_after_instances: runtimeAgents.map((agent) => agent.instance_id).filter(Boolean).slice(0, 8),
      supervisor_decision: "summarize_progress",
      human_interrupt_allowed: true,
      approval_required: supervisorRuntime.interaction_mode === "checkpointed_supervised",
      completion_signal: { when: "intermediate_summary_ready" },
      selection_reason: "supervisor runtime enabled",
    });
  }

  return normalizeExecutionCheckpointList(checkpoints);
}
