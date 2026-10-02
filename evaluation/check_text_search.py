"""Reproducible real-model retrieval evaluation over explicitly synthetic examples."""

import json
import time
from pathlib import Path

from app.retrieval.chunks import chunks
from app.retrieval.model import MiniLM
from app.retrieval.models import Part


def evaluate(model=None):
    model = model or MiniLM()
    fixture = json.loads(Path(__file__).with_name("text_search.json").read_text("utf-8"))
    corpus = []
    for document in fixture["documents"]:
        for chunk in chunks([Part(text=document["text"], location="page 1", page_number=1,
                                 method="extraction")], model.tokenizer):
            corpus.append({**chunk, "id": document["id"]})
    vectors = model.encode([p["text"] for p in corpus])
    details = []
    total_time = 0
    for case in fixture["queries"]:
        started = time.perf_counter()
        vector = model.encode([case["query"]])[0]
        scores = {}
        for passage, embedded in zip(corpus, vectors, strict=True):
            score = sum(a * b for a, b in zip(vector, embedded, strict=True))
            scores[passage["id"]] = max(score, scores.get(passage["id"], -1))
        ranked = [key for key in sorted(scores, key=lambda key: -scores[key]) if scores[key] >= 0.35][:5]
        total_time += time.perf_counter() - started
        relevant = set(case["relevant"])
        reciprocal = next((1 / (i + 1) for i, key in enumerate(ranked) if key in relevant), 0)
        filename = [doc["id"] for doc in fixture["documents"]
                    if all(word in doc["name"].lower() for word in case["query"].lower().split())][:5]
        details.append({"query": case["query"], "top5": ranked,
                        "recall5": len(relevant & set(ranked)) / len(relevant), "rr5": reciprocal,
                        "filename_recall5": len(relevant & set(filename)) / len(relevant)})
    negatives = []
    for query in fixture["negative_queries"]:
        vector = model.encode([query])[0]
        highest = max(sum(a * b for a, b in zip(vector, v, strict=True)) for v in vectors)
        negatives.append({"query": query, "highest_score": highest, "no_match": highest < 0.35})
    return {"model_key": model.key, "documents": len(fixture["documents"]), "queries": len(details),
            "recall5": sum(x["recall5"] for x in details) / len(details),
            "mrr5": sum(x["rr5"] for x in details) / len(details),
            "filename_recall5": sum(x["filename_recall5"] for x in details) / len(details),
            "mean_query_ms": total_time / len(details) * 1000,
            "details": details, "negative_queries": negatives,
            "limitation": "Small authored regression set; not a general retrieval accuracy estimate."}


if __name__ == "__main__":
    report = evaluate()
    output = Path("tmp/semantic-evaluation/report.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in {"details", "negative_queries"}}, indent=2))
    if report["recall5"] < 0.9 or report["mrr5"] < 0.75 or not all(x["no_match"] for x in report["negative_queries"]):
        raise SystemExit("Retrieval regression threshold failed; inspect the report.")
