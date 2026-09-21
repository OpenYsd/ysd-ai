# NOTICE — F2LLM-v2-80M derived artifact

This directory and the runtime artifact built from it (`model.onnx`, `tokenizer.json`,
`tokenizer_config.json`) redistribute a **modified** copy of the following work.

| | |
|---|---|
| Work | **F2LLM-v2-80M** — multilingual embedding model |
| Authors | Ziyin Zhang, Zihan Liao, Hang Yu, Peng Di, Rui Wang (CodeFuse) |
| Source | https://huggingface.co/codefuse-ai/F2LLM-v2-80M |
| Revision | `ad88d7a126711f1490cd4bad645dc9d3acc2af6a` (2026-09-03) |
| Paper | *F2LLM-v2: Inclusive, Performant, and Efficient Embeddings for a Multilingual World*, arXiv:2603.19223 |
| License | **Apache License 2.0** — declared in the model card front matter (`license: apache-2.0`). The upstream repository contains no `LICENSE` file, so the canonical text is bundled here as `LICENSE-Apache-2.0.txt`. |
| Lineage | Pruned and trained from the F2LLM-v2-0.6B preview model (Qwen3 architecture), per the upstream model card. |

## Changes made (Apache-2.0 §4(b))

The weights were **not retrained**. The following mechanical modifications were applied by
`scripts/f2llm/build-onnx.py`:

1. Converted from PyTorch `safetensors` to ONNX (opset 17, eager attention).
2. The token-embedding table was replaced by a row-wise symmetric int8 table with per-row float32 scales.
3. The transformer MatMul weights were dynamically quantized to uint8, except every `down_proj`.
4. The tokenizer files (`tokenizer.json`, `tokenizer_config.json`) are copied unchanged.

Because of (2) and (3) the artifact's vectors are close to, but not bit-identical with, the upstream
PyTorch fp32 output (mean cosine ≈ 0.994 on the golden set in `tests/fixtures/f2llm-golden.json`).

The artifact carries the exact upstream revision and the SHA-256 of every file in `artifact.json`.
No trademark or endorsement by the upstream authors is implied.
