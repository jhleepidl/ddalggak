import { normalizeExecutionCheckpointList } from "../domain/execution_checkpoint.js";

export function buildExecutionCheckpoints({
  slots = [],
} = {}) {
  const checkpoints = [];
  const reviewerSlots = slots.filter((slot) => slot.role_id === "reviewer");
  const synthesizerSlots = slots.filter((slot) => slot.role_id === "synthesizer");
  const operatorSlots = slots.filter((slot) => slot.role_id === "operator");

  if (reviewerSlots.length > 0) {
    checkpoints.push({
      checkpoint_id: "checkpoint_review_gate",
      label: "Review Gate",
      kind: "quality_gate",
      target_slot_ids: reviewerSlots.map((slot) => slot.slot_id),
      approval_required: false,
      completion_signal: { when: "review_complete" },
      selection_reason: "reviewer slot present",
    });
  }
  if (synthesizerSlots.length > 0) {
    checkpoints.push({
      checkpoint_id: "checkpoint_output_ready",
      label: "Output Ready",
      kind: "handoff",
      target_slot_ids: synthesizerSlots.map((slot) => slot.slot_id),
      approval_required: false,
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
      approval_required: true,
      completion_signal: { when: "operator_ack" },
      selection_reason: "operator slot present",
    });
  }

  return normalizeExecutionCheckpointList(checkpoints);
}
