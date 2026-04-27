# Experiment Harness for RGCG and AETG

This directory contains deterministic benchmark scaffolding for the two paper outlines.
It is intentionally small and CI-friendly: it evaluates projection, retraction, and mode-selection behavior without requiring an LLM provider.

## GCP-Bench / RGCG

```bash
node experiments/scripts/run_gcp_bench.js --out experiments/runs/gcp_smoke
node experiments/scripts/export_latex_tables.js \
  --input experiments/runs/gcp_smoke/gcp_summary.jsonl \
  --out experiments/runs/gcp_smoke/table.tex \
  --caption 'GCP smoke benchmark summary.'
```

Datasets live in `experiments/datasets/gcp_bench/` and cover artifact correction recall, retraction suppression, and compaction survival.

## AETG-Bench / AETG

```bash
node experiments/scripts/run_aetg_bench.js --out experiments/runs/aetg_smoke
node experiments/scripts/export_latex_tables.js \
  --input experiments/runs/aetg_smoke/aetg_summary.jsonl \
  --out experiments/runs/aetg_smoke/table.tex \
  --caption 'AETG smoke benchmark summary.'
```

Datasets live in `experiments/datasets/aetg_bench/` and currently evaluate mode-selection policy quality.

## Interpreting the smoke results

The included smoke datasets are not final paper-scale datasets. They are regression fixtures and table-generation scaffolds.
For paper results, expand each suite, add repeated LLM-in-the-loop runs, and report aggregate metrics with confidence intervals.
