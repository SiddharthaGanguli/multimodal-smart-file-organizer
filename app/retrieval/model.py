"""Pinned English MiniLM inference; no PyTorch or runtime remote-code loading."""

import argparse
import hashlib
import os
import urllib.request
from pathlib import Path
from threading import Lock

MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
MODEL_KEY = f"{MODEL_ID}@{REVISION}/mean-l2/224-32-v1"
DIMENSIONS = 384
FILES = {
    "onnx/model.onnx": (
        90_405_214, "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452"
    ),
    "tokenizer.json": (
        466_247, "be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037"
    ),
}


def model_directory():
    return Path(os.environ.get("SEARCH_MODEL_DIR", f"storage/models/minilm-{REVISION}"))


def verify(path, size, digest):
    return (path.is_file() and path.stat().st_size == size
            and hashlib.sha256(path.read_bytes()).hexdigest() == digest)


def download_model(directory=None):
    directory = Path(directory or model_directory())
    for name, (size, digest) in FILES.items():
        path = directory / name
        if verify(path, size, digest):
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".download")
        try:
            url = f"https://huggingface.co/{MODEL_ID}/resolve/{REVISION}/{name}"
            with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as out:
                received = 0
                while block := response.read(1024 * 1024):
                    received += len(block)
                    if received > size:
                        raise ValueError("Model download exceeds pinned size")
                    out.write(block)
            if not verify(temporary, size, digest):
                raise ValueError("Model download failed its pinned integrity check")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return directory


class MiniLM:
    key = MODEL_KEY
    dimensions = DIMENSIONS

    def __init__(self, directory=None):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        directory = Path(directory or model_directory())
        for name, (size, digest) in FILES.items():
            if not verify(directory / name, size, digest):
                raise RuntimeError("Search model missing or invalid; run the model download command.")
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(directory / "onnx/model.onnx"), options,
                                           providers=["CPUExecutionProvider"])
        self.lock = Lock()

    def encode(self, texts):
        import numpy as np

        result = []
        with self.lock:
            for start in range(0, len(texts), 4):
                encoded = self.tokenizer.encode_batch(texts[start:start + 4])
                if any(len(item.ids) > 256 for item in encoded):
                    raise ValueError("Text exceeds the embedding model's 256-token limit.")
                width = max(len(item.ids) for item in encoded)
                ids = np.zeros((len(encoded), width), dtype=np.int64)
                mask = np.zeros_like(ids)
                types = np.zeros_like(ids)
                for row, item in enumerate(encoded):
                    ids[row, :len(item.ids)] = item.ids
                    mask[row, :len(item.ids)] = 1
                    types[row, :len(item.ids)] = item.type_ids
                outputs = self.session.run(None, {"input_ids": ids, "attention_mask": mask,
                                                  "token_type_ids": types})[0]
                weights = mask[..., None].astype(np.float32)
                pooled = (outputs * weights).sum(axis=1) / weights.sum(axis=1).clip(min=1)
                pooled /= np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-12)
                if pooled.shape[1] != DIMENSIONS or not np.isfinite(pooled).all():
                    raise ValueError("Embedding model returned invalid vectors.")
                result.extend(pooled.tolist())
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", required=True)
    parser.parse_args()
    print(f"Verified model at {download_model()}")
