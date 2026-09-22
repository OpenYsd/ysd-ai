"""
Generate tests/fixtures/f2llm-golden.json — the behavioural reference for the F2LLM artifact.

The vectors come from the UPSTREAM model in PyTorch fp32 (no ONNX, no quantization), so they are an
independent yardstick: the compact ONNX artifact and the app's runtime provider must both reproduce them.

  python scripts/f2llm/make-golden.py --src <dir holding the pinned upstream snapshot>

Each item stores the exact string given to the tokenizer (`input`), its token ids (EOS appended by the
tokenizer) and the L2-normalised last-token embedding.
"""
import argparse, hashlib, json, os, sys

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
MANIFEST = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf8"))
QP = MANIFEST["model"]["queryPrompt"]
MAXT = MANIFEST["model"]["maxTokens"]

QUERIES = [
    "ما هي فوائد قواعد البيانات؟",
    "What are the benefits of databases?",
    "كيف أنشر التطبيق على Railway وما إعداد PORT؟",
    "How do I add a new AI provider to the system?",
    "ما عتبة الثقة في الاسترجاع وماذا يحدث عند عدم التطابق؟",
    "Which unique constraint prevents duplicate chat requests?",
]
DOCUMENTS = [
    "تخزن قواعد البيانات المعلومات بطريقة منظمة وتتيح الوصول السريع والآمن إليها.",
    "يفضل القط النوم في الأماكن الدافئة خلال فصل الشتاء الطويل.",
    "الحد الأقصى لحجم الملف في الباقة المجانية خمسون ميجابايت.",
    "Databases store information in a structured way enabling fast access.",
    "The cat prefers sleeping in warm places during the long winter.",
    "Quarterly reliability report: indexing latency, restarts and memory headroom.",
    "لا تضف PORT — Railway يحقنه، والتطبيق يقرأ process.env.PORT مع HOSTNAME=0.0.0.0.",
    "استخدم YSD_LOW_MEMORY=1 لتقليل الذاكرة؛ RSS ≈ 1.9GB عند 5 ملفات متزامنة.",
    "chat_request_ids_unique على (user_id, client_request_id) يمنع الازدواج عبر النسخ.",
    "رمز الجلسة صالح 15 دقيقة، ولا يُحفظ في localStorage إلا رمز الصورة المحلية.",
]
# long, real-length chunks from this repository's own documentation (Arabic prose with English terms)
LONG_FILES = [("docs/OPERATIONS.md", 3000), ("docs/DESIGN-v0.9-evidence-mode.md", 5200), ("docs/local-pairing.md", 2500), ("CHANGELOG.md", 4100)]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    a = ap.parse_args()
    for f in MANIFEST["upstreamFiles"]:
        p = os.path.join(a.src, f["path"])
        if sha256(p) != f["sha256"]:
            sys.exit(f"upstream input hash mismatch: {f['path']}")
    tok = AutoTokenizer.from_pretrained(a.src)
    model = AutoModel.from_pretrained(a.src, dtype=torch.float32, attn_implementation="eager").eval()

    items = []

    def add(kind, text):
        inp = (QP + text[:2000]) if kind == "query" else text[:2000]
        enc = tok([inp], return_tensors="pt")
        with torch.no_grad():
            h = model(**enc).last_hidden_state
        v = h[0, enc["attention_mask"].sum(1) - 1][0].float()
        v = (v / v.norm()).numpy()
        ids = enc["input_ids"][0].tolist()
        item = {"kind": kind, "text": text, "input": inp, "ids": ids, "vec": [round(float(x), 7) for x in v]}
        # the runtime truncates to maxTokens keeping the trailing EOS (the pooled token) — pin that behaviour too
        if len(ids) > MAXT:
            ids_t = ids[: MAXT - 1] + [ids[-1]]
            with torch.no_grad():
                ht = model(input_ids=torch.tensor([ids_t]), attention_mask=torch.ones(1, len(ids_t), dtype=torch.long)).last_hidden_state
            vt = ht[0, -1].float()
            vt = (vt / vt.norm()).numpy()
            item["truncated"] = {"ids": ids_t, "vec": [round(float(x), 7) for x in vt]}
        items.append(item)

    for q in QUERIES:
        add("query", q)
    for d in DOCUMENTS:
        add("document", d)
    for rel, off in LONG_FILES:
        txt = open(os.path.join(ROOT, rel), encoding="utf8").read()
        add("document", txt[off : off + 1400])
    out = {
        "model": MANIFEST["model"]["upstream"],
        "revision": MANIFEST["model"]["revision"],
        "generatedBy": "scripts/f2llm/make-golden.py (PyTorch fp32, eager attention)",
        "queryPrompt": QP,
        "items": items,
    }
    dst = os.path.join(ROOT, "tests", "fixtures", "f2llm-golden.json")
    with open(dst, "w", encoding="utf8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("golden items:", len(items), "->", dst, "| max tokens:", max(len(i["ids"]) for i in items))


if __name__ == "__main__":
    main()
