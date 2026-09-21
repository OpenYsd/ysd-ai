"""
Reproducible build of the compact F2LLM-v2-80M ONNX artifact used by the RAG embedding provider.

  python scripts/f2llm/build-onnx.py --src <pinned upstream snapshot> --out <artifact dir> [--work <dir>] [--update-manifest]

Recipe (every step is deterministic; the exact recipe is also recorded in manifest.json):
  1. verify every upstream input against the SHA-256 pinned in manifest.json
  2. export the fp32 model with the legacy TorchScript exporter (opset 17, eager attention, dynamic batch/seq)
  3. replace the 151,936 x 320 embedding table by a row-wise symmetric int8 table
       Gather(int8 table) -> Cast(float) -> Mul(Gather(per-row scale))
  4. dynamic uint8 quantization of the transformer MatMuls, EXCLUDING every `down_proj`
       (quantizing them costs ~2.7 cosine points; excluding them keeps the artifact at ~93 MB)
  5. verify against tests/fixtures/f2llm-golden.json (independent PyTorch fp32 vectors)
  6. write model.onnx + tokenizer files + license/notice + artifact.json (with SHA-256 of every file)

Run in the environment pinned by scripts/f2llm/requirements-build.lock.txt.
"""
import argparse, hashlib, json, os, platform, re, shutil, sys
from importlib import metadata

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
MANIFEST_PATH = os.path.join(HERE, "manifest.json")
GOLDEN_PATH = os.path.join(ROOT, "tests", "fixtures", "f2llm-golden.json")
PACKAGES = ["torch", "transformers", "onnx", "onnxruntime", "numpy", "safetensors", "tokenizers", "protobuf", "ml_dtypes", "sympy", "packaging"]

RECIPE = {
    "exporter": "torch.onnx.export (legacy TorchScript, dynamo=False)",
    "opset": 17,
    "attention": "eager",
    "exportWrapper": "Wrap(model) with attribute name `m`; forward(input_ids, attention_mask) -> last_hidden_state; use_cache=False",
    "exportExampleInputs": "tokenizer([QUERY_PROMPT + 'ما هي فوائد قواعد البيانات؟', 'تخزن قواعد البيانات المعلومات بطريقة منظمة وتتيح الوصول السريع والآمن إليها.'], padding=True)",
    "embeddingTable": "row-wise symmetric int8, scale = max|row|/127, clip [-127,127]; Gather(int8)->Cast(float)->Mul(Gather(scale))",
    "dynamicQuantization": "onnxruntime.quantization.quantize_dynamic, weight_type=QUInt8, op_types_to_quantize=[MatMul], MatMulConstBOnly=True",
    "excludedFromQuantization": "all MatMul nodes whose name contains `down_proj` (8 nodes)",
    "acceptance": "cosine vs PyTorch fp32 golden vectors: mean >= 0.992 and min >= 0.985; token ids identical",
}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fail(msg):
    print("BUILD FAILED:", msg, file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="directory holding the pinned upstream snapshot")
    ap.add_argument("--out", required=True, help="artifact output directory")
    ap.add_argument("--work", default=None, help="scratch directory for intermediates (default: <out>/../f2llm-work)")
    ap.add_argument("--update-manifest", action="store_true", help="write recipe/build/artifact into manifest.json")
    a = ap.parse_args()

    manifest = json.load(open(MANIFEST_PATH, encoding="utf8"))
    qp = manifest["model"]["queryPrompt"]

    # ---- 1. inputs ----
    for f in manifest["upstreamFiles"]:
        p = os.path.join(a.src, f["path"])
        if not os.path.isfile(p):
            fail("missing upstream input " + f["path"])
        if sha256_file(p) != f["sha256"]:
            fail("upstream input hash mismatch: " + f["path"])
    print("upstream inputs verified:", len(manifest["upstreamFiles"]), "files @", manifest["model"]["revision"][:12])

    import onnx
    import onnxruntime as ort
    import torch
    from onnx import TensorProto, helper, numpy_helper
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from transformers import AutoModel, AutoTokenizer

    torch.manual_seed(0)
    work = a.work or os.path.join(os.path.dirname(os.path.abspath(a.out)), "f2llm-work")
    os.makedirs(work, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)

    tok = AutoTokenizer.from_pretrained(a.src)
    model = AutoModel.from_pretrained(a.src, dtype=torch.float32, attn_implementation="eager")
    model.eval()

    # ---- 2. fp32 export ----
    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids, attention_mask):
            return self.m(input_ids=input_ids, attention_mask=attention_mask, use_cache=False).last_hidden_state

    ex = tok([qp + "ما هي فوائد قواعد البيانات؟", "تخزن قواعد البيانات المعلومات بطريقة منظمة وتتيح الوصول السريع والآمن إليها."], return_tensors="pt", padding=True)
    fp32 = os.path.join(work, "model.fp32.onnx")
    torch.onnx.export(
        Wrap(model), (ex["input_ids"], ex["attention_mask"]), fp32,
        input_names=["input_ids", "attention_mask"], output_names=["last_hidden_state"],
        dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"}, "last_hidden_state": {0: "batch", 1: "seq"}},
        opset_version=17, dynamo=False,
    )
    print("fp32 export:", round(os.path.getsize(fp32) / 1048576, 1), "MB")

    # ---- 3. int8 embedding table ----
    m = onnx.load(fp32)
    init = {i.name: i for i in m.graph.initializer}
    cands = [n for n in m.graph.node if n.op_type == "Gather" and n.input[0] in init and len(init[n.input[0]].dims) == 2 and init[n.input[0]].dims[0] > 100000]
    if len(cands) != 1:
        fail("expected exactly one embedding Gather, found %d" % len(cands))
    g = cands[0]
    wname = g.input[0]
    W = numpy_helper.to_array(init[wname]).astype(np.float32)
    V, D = W.shape
    scale = np.abs(W).max(1) / 127.0
    scale[scale == 0] = 1.0
    q = np.clip(np.round(W / scale[:, None]), -127, 127).astype(np.int8)
    m.graph.initializer.remove(init[wname])
    m.graph.initializer.extend([numpy_helper.from_array(q, "embed_q"), numpy_helper.from_array(scale.reshape(V, 1).astype(np.float32), "embed_scale")])
    ids_name, out_name = g.input[1], g.output[0]
    idx = list(m.graph.node).index(g)
    m.graph.node.remove(g)
    new = [
        helper.make_node("Gather", ["embed_q", ids_name], ["embed_q_rows"], axis=0, name="emb8_gather_q"),
        helper.make_node("Gather", ["embed_scale", ids_name], ["embed_scale_rows"], axis=0, name="emb8_gather_s"),
        helper.make_node("Cast", ["embed_q_rows"], ["embed_f_rows"], to=TensorProto.FLOAT, name="emb8_cast"),
        helper.make_node("Mul", ["embed_f_rows", "embed_scale_rows"], [out_name], name="emb8_mul"),
    ]
    for k, n in enumerate(new):
        m.graph.node.insert(idx + k, n)
    onnx.checker.check_model(m)
    emb8 = os.path.join(work, "model.emb8.onnx")
    onnx.save(m, emb8)

    # ---- 4. dynamic uint8 MatMuls, down_proj excluded ----
    m2 = onnx.load(emb8)
    excluded = [n.name for n in m2.graph.node if n.op_type == "MatMul" and "down_proj" in n.name]
    if len(excluded) != 8:
        fail("expected 8 down_proj MatMuls, found %d" % len(excluded))
    final = os.path.join(a.out, "model.onnx")
    quantize_dynamic(emb8, final, weight_type=QuantType.QUInt8, op_types_to_quantize=["MatMul"], nodes_to_exclude=excluded, extra_options={"MatMulConstBOnly": True})
    print("compact model:", round(os.path.getsize(final) / 1048576, 1), "MB")

    # ---- 5. behaviour check against the independent golden vectors ----
    golden = json.load(open(GOLDEN_PATH, encoding="utf8"))
    sess = ort.InferenceSession(final, providers=["CPUExecutionProvider"])
    coss = []
    for it in golden["items"]:
        ids = tok([it["input"]], return_tensors="pt")["input_ids"][0].tolist()
        if ids != it["ids"]:
            fail("token ids differ from golden for: " + it["text"][:40])
        n = len(ids)
        o = sess.run(None, {"input_ids": np.array([ids], dtype=np.int64), "attention_mask": np.ones((1, n), dtype=np.int64)})[0][0, n - 1]
        o = o / np.linalg.norm(o)
        if o.shape[0] != manifest["model"]["dims"]:
            fail("unexpected dims %d" % o.shape[0])
        coss.append(float(o @ np.array(it["vec"], dtype=np.float64)))
        if "truncated" in it:  # the 512-token truncation the runtime applies (EOS kept)
            tids = it["truncated"]["ids"]
            o = sess.run(None, {"input_ids": np.array([tids], dtype=np.int64), "attention_mask": np.ones((1, len(tids)), dtype=np.int64)})[0][0, len(tids) - 1]
            o = o / np.linalg.norm(o)
            coss.append(float(o @ np.array(it["truncated"]["vec"], dtype=np.float64)))
    mean_c, min_c = float(np.mean(coss)), float(np.min(coss))
    print(f"golden check: n={len(coss)} mean cos {mean_c:.5f} min cos {min_c:.5f}")
    if mean_c < 0.992 or min_c < 0.985:
        fail("compact artifact does not reproduce the golden behaviour")

    # ---- 6. artifact directory ----
    shutil.copyfile(os.path.join(a.src, "tokenizer.json"), os.path.join(a.out, "tokenizer.json"))
    shutil.copyfile(os.path.join(a.src, "tokenizer_config.json"), os.path.join(a.out, "tokenizer_config.json"))
    shutil.copyfile(os.path.join(HERE, "LICENSE-Apache-2.0.txt"), os.path.join(a.out, "LICENSE-Apache-2.0.txt"))
    shutil.copyfile(os.path.join(HERE, "NOTICE-F2LLM.md"), os.path.join(a.out, "NOTICE-F2LLM.md"))

    files = []
    for name in ["model.onnx", "tokenizer.json", "tokenizer_config.json", "LICENSE-Apache-2.0.txt", "NOTICE-F2LLM.md"]:
        p = os.path.join(a.out, name)
        files.append({"path": name, "sha256": sha256_file(p), "bytes": os.path.getsize(p)})
    onnx_sha = files[0]["sha256"]
    packages = {}
    for p in PACKAGES:
        try:
            packages[p] = metadata.version(p)
        except metadata.PackageNotFoundError:
            packages[p] = None
    build = {"python": platform.python_version(), "platform": platform.platform(), "packages": packages, "lockfile": "scripts/f2llm/requirements-build.lock.txt"}
    tag = "f2llm-v2-80m@%s.onnx-%s" % (manifest["model"]["revision"][:8], onnx_sha[:12])
    artifact = {
        "schema": 1,
        "tag": tag,
        "modelId": manifest["model"]["id"],
        "upstream": manifest["model"]["upstream"],
        "revision": manifest["model"]["revision"],
        "dims": manifest["model"]["dims"],
        "maxTokens": manifest["model"]["maxTokens"],
        "queryPrompt": qp,
        "documentPrompt": manifest["model"]["documentPrompt"],
        "files": files,
        "verification": {"goldenItems": len(coss), "goldenMeanCosine": round(mean_c, 6), "goldenMinCosine": round(min_c, 6)},
    }
    with open(os.path.join(a.out, "artifact.json"), "w", encoding="utf8") as f:
        json.dump(artifact, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("ONNX SHA-256:", onnx_sha)
    print("artifact tag:", tag)

    if a.update_manifest:
        manifest["recipe"] = RECIPE
        manifest["build"] = build
        manifest["artifact"] = {"tag": tag, "files": files, "verification": artifact["verification"]}
        with open(MANIFEST_PATH, "w", encoding="utf8") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print("manifest.json updated")


if __name__ == "__main__":
    main()
