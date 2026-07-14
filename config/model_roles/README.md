# Model-role policies

This directory contains version-controlled model-role policy baselines.

- `default.json` defines the repository-wide role vocabulary and governance defaults without pinning a provider.
- `portfolio_benchmark.json` defines the default cross-vendor policy for the Room portfolio benchmark.

The effective policy is layered rather than copied to an external temporary file:

1. repository policy baseline,
2. Room-package policy,
3. Room profile overrides, merged role by role,
4. explicit environment overrides for a single execution.

A Room may evolve its own `agent_room_profile.model_policy` as repeated use produces evidence. Durable changes should follow `proposal → trial → user/GoC approval`; benchmark policy installation is ephemeral to the benchmark Room.

Provider-only assignments intentionally leave `model` empty so the provider CLI can resolve its configured default model. Experiment artifacts record the requested policy and the actually resolved provider/model/CLI version.
