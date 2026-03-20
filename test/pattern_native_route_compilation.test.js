import test from "node:test";
import assert from "node:assert/strict";

import { mapTeamPlanToRouteActions } from "../src/control_plane/execution_coordinator.js";
import { validateTeamStructureV2 } from "../src/shared/team_structure_v2.js";

test("multi-round debate compiles repeated debater actions and adjudicator final synthesis", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        { slot_id: "slot_debater_a", role_id: "researcher", purpose: "Argue side A", parallelizable: false },
        { slot_id: "slot_debater_b", role_id: "researcher", purpose: "Argue side B", parallelizable: false },
        { slot_id: "slot_judge", role_id: "reviewer", purpose: "Judge the debate", parallelizable: false },
      ],
      execution_graph: {
        pattern: "debate",
        order: ["slot_debater_a", "slot_debater_b", "slot_judge"],
        final_participant_id: "slot_judge",
        debate: {
          rounds: 2,
          adjudicator_participant_id: "slot_judge",
          debater_participant_ids: ["slot_debater_a", "slot_debater_b"],
          rebuttal_required: true,
        },
        validation: {
          errors: [],
          warnings: [],
          pattern_ready: true,
          strict_pattern_ready: true,
        },
      },
    },
    runtime_agents: [
      { instance_id: "inst_debater_a", slot_id: "slot_debater_a", role_id: "researcher" },
      { instance_id: "inst_debater_b", slot_id: "slot_debater_b", role_id: "researcher" },
      { instance_id: "inst_judge", slot_id: "slot_judge", role_id: "reviewer" },
    ],
  }, {
    mode: "run",
    goal: "Debate both sides, then judge",
  });

  const debaterRuns = actions.filter((action) => action.type === "agent_run" && action.inputs?.debate_role === "debater");
  assert.equal(debaterRuns.length, 4);
  assert.equal(new Set(debaterRuns.map((action) => action.inputs?.debate_round)).size, 2);
  const finalAction = actions.find((action) => action.type === "synthesize_final");
  assert.ok(finalAction);
  assert.equal(finalAction.agent, "reviewer");
  assert.equal(finalAction.inputs?.debate_role, "adjudicator");
  assert.equal(finalAction.inputs?.debate_rounds, 2);
});

test("committee pattern promotes explicit chair to final synthesis even when role is not synthesizer", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        { slot_id: "slot_member_a", role_id: "researcher", purpose: "Member A", parallelizable: true },
        { slot_id: "slot_member_b", role_id: "researcher", purpose: "Member B", parallelizable: true },
        { slot_id: "slot_chair", role_id: "reviewer", purpose: "Committee chair", parallelizable: false },
      ],
      execution_graph: {
        pattern: "committee",
        order: ["slot_member_a", "slot_member_b", "slot_chair"],
        final_participant_id: "slot_chair",
        committee: {
          mode: "majority",
          quorum: 2,
          chair_participant_id: "slot_chair",
          member_participant_ids: ["slot_member_a", "slot_member_b"],
        },
        edges: [
          { from_slot_id: "slot_member_a", to_slot_id: "slot_chair", relation: "committee_vote" },
          { from_slot_id: "slot_member_b", to_slot_id: "slot_chair", relation: "committee_vote" },
        ],
        validation: {
          errors: [],
          warnings: [],
          pattern_ready: true,
          strict_pattern_ready: true,
        },
      },
    },
    runtime_agents: [
      { instance_id: "inst_member_a", slot_id: "slot_member_a", role_id: "researcher" },
      { instance_id: "inst_member_b", slot_id: "slot_member_b", role_id: "researcher" },
      { instance_id: "inst_chair", slot_id: "slot_chair", role_id: "reviewer" },
    ],
  }, {
    mode: "run",
    goal: "Reach a committee decision",
  });

  const consensusAction = actions.find((action) => action.type === "committee_consensus");
  assert.ok(consensusAction);
  assert.equal(consensusAction.inputs?.consensus_mode, "majority");
  assert.equal(consensusAction.inputs?.committee_quorum, 2);
  assert.deepEqual(consensusAction.inputs?.member_slot_ids, ["slot_member_a", "slot_member_b"]);
  const finalAction = actions.find((action) => action.type === "synthesize_final");
  assert.ok(finalAction);
  assert.equal(finalAction.agent, "reviewer");
  assert.equal(finalAction.inputs?.committee_role, "chair");
  assert.equal(finalAction.inputs?.consensus_mode, "majority");
  assert.deepEqual(finalAction.inputs?.committee_member_slot_ids, ["slot_member_a", "slot_member_b"]);
});

test("cyclic graph validation degrades to compatibility sequential actions instead of spawn_parallel", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        { slot_id: "slot_a", role_id: "researcher", purpose: "Node A", parallelizable: true },
        { slot_id: "slot_b", role_id: "researcher", purpose: "Node B", parallelizable: true },
      ],
      execution_graph: {
        pattern: "graph",
        order: ["slot_a", "slot_b"],
        cyclic_topology: true,
        edges: [
          { from_slot_id: "slot_a", to_slot_id: "slot_b", relation: "precedes" },
          { from_slot_id: "slot_b", to_slot_id: "slot_a", relation: "precedes" },
        ],
        parallel_groups: [
          { parallel_group_id: "parallel_bad", slot_ids: ["slot_a", "slot_b"] },
        ],
        validation: {
          errors: ["graph pattern contains a cycle in executable topology"],
          warnings: [],
          pattern_ready: false,
          strict_pattern_ready: false,
        },
      },
    },
    runtime_agents: [
      { instance_id: "inst_a", slot_id: "slot_a", role_id: "researcher" },
      { instance_id: "inst_b", slot_id: "slot_b", role_id: "researcher" },
    ],
  }, {
    mode: "run",
    goal: "Handle graph carefully",
  });

  assert.equal(actions.some((action) => action.type === "spawn_parallel"), false);
  const firstRunnable = actions.find((action) => action.type === "agent_run" || action.type === "synthesize_final");
  assert.ok(firstRunnable);
  assert.equal(firstRunnable.inputs?.topology_validation_fallback, true);
});

test("workflow-like patterns require executable final participant when explicitly set", () => {
  const validation = validateTeamStructureV2({
    participants: [
      { participant_id: "builder", kind: "agent", role: "builder", name: "Builder" },
      { participant_id: "approval_gate", kind: "gate", role: "approval", name: "Approval Gate" },
    ],
    topology: {
      pattern: "workflow",
      final_participant_id: "approval_gate",
      edges: [
        { from: "builder", to: "approval_gate", kind: "handoff" },
      ],
    },
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.includes("workflow pattern requires the final participant to be executable")));
});


test("graph pattern emits structural node actions and carries edge conditions into downstream agent prompts", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        { slot_id: "builder", role_id: "builder", purpose: "Prepare implementation" },
        { slot_id: "judge", role_id: "reviewer", purpose: "Decide final answer" },
      ],
      execution_graph: {
        pattern: "graph",
        nodes: [
          { node_id: "builder_node", participant_id: "builder", kind: "task" },
          { node_id: "approval_gate_node", participant_id: "approval_gate", kind: "gate", label: "Approval Gate" },
          { node_id: "human_node", participant_id: "human_review", kind: "human", label: "Human Review" },
          { node_id: "judge_node", participant_id: "judge", kind: "task" },
        ],
        edges: [
          { from_slot_id: "builder", to_slot_id: "approval_gate", relation: "handoff", condition: "implementation_ready" },
          { from_slot_id: "approval_gate", to_slot_id: "human_review", relation: "approval_release" },
          { from_slot_id: "human_review", to_slot_id: "judge", relation: "handoff", condition: "approved_by_human" },
        ],
        final_participant_id: "judge",
        validation: {
          errors: [],
          warnings: [],
          pattern_ready: true,
          strict_pattern_ready: true,
        },
      },
    },
    runtime_agents: [
      { instance_id: "inst_builder", slot_id: "builder", role_id: "builder" },
      { instance_id: "inst_judge", slot_id: "judge", role_id: "reviewer" },
    ],
    runtime_participants: [
      { participant_id: "builder", kind: "agent", role: "builder", name: "Builder" },
      { participant_id: "approval_gate", kind: "gate", role: "approval", name: "Approval Gate" },
      { participant_id: "human_review", kind: "human", role: "reviewer", name: "Human Review" },
      { participant_id: "judge", kind: "judge", role: "synthesizer", name: "Judge" },
    ],
  }, {
    mode: "run",
    goal: "구조적 승인을 거쳐 최종 결론 생성",
    seedInstruction: "Prepare implementation and wait for release",
  });

  const gateAction = actions.find((action) => action.type === "gate_wait");
  const humanAction = actions.find((action) => action.type === "human_checkpoint");
  const judgeAction = actions.find((action) => action.type === "synthesize_final");
  assert.ok(gateAction);
  assert.ok(humanAction);
  assert.ok(judgeAction);
  assert.equal(gateAction.inputs?.approval_required, true);
  assert.equal(judgeAction.inputs?.incoming_conditions?.[0]?.condition, "approved_by_human");
  assert.match(judgeAction.prompt, /approved_by_human/);
});


test("tool_proxy structural nodes infer repair and verifier targets from neighboring agent slots", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        { slot_id: "slot_builder", role_id: "builder", purpose: "Implement changes" },
        { slot_id: "slot_reviewer", role_id: "reviewer", purpose: "Review verification result" },
      ],
      execution_graph: {
        pattern: "graph",
        nodes: [
          { node_id: "builder_node", participant_id: "slot_builder", kind: "task" },
          { node_id: "verify_node", participant_id: "verify_proxy", kind: "tool_proxy", label: "Run tests" },
          { node_id: "reviewer_node", participant_id: "slot_reviewer", kind: "task" },
        ],
        edges: [
          { from_slot_id: "slot_builder", to_slot_id: "verify_proxy", relation: "handoff", condition: "implementation_ready" },
          { from_slot_id: "verify_proxy", to_slot_id: "slot_reviewer", relation: "handoff", condition: "tests_verified" },
        ],
        final_participant_id: "slot_reviewer",
        validation: {
          errors: [],
          warnings: [],
          pattern_ready: true,
          strict_pattern_ready: true,
        },
      },
    },
    runtime_agents: [
      { instance_id: "inst_builder", slot_id: "slot_builder", role_id: "builder" },
      { instance_id: "inst_reviewer", slot_id: "slot_reviewer", role_id: "reviewer" },
    ],
    runtime_participants: [
      { participant_id: "slot_builder", kind: "agent", role: "builder", name: "Builder" },
      { participant_id: "verify_proxy", kind: "tool_proxy", role: "verification", name: "Run tests" },
      { participant_id: "slot_reviewer", kind: "agent", role: "reviewer", name: "Reviewer" },
    ],
  }, {
    mode: "run",
    goal: "Implement, verify, and review",
  });

  const toolProxyAction = actions.find((action) => action.type === "tool_proxy_call");
  assert.ok(toolProxyAction);
  assert.equal(toolProxyAction.inputs?.repair_target_agent_id, "builder");
  assert.equal(toolProxyAction.inputs?.repair_target_slot_id, "slot_builder");
  assert.equal(toolProxyAction.inputs?.verifier_agent_id, "reviewer");
  assert.equal(toolProxyAction.inputs?.verifier_slot_id, "slot_reviewer");
  assert.equal(toolProxyAction.inputs?.repair_attempt_limit, 1);
});
