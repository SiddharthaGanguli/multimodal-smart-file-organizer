"""Release regressions: size enforcement, clean contents and reproducible packaging."""

import io
import zipfile

import pytest

from frontend.extension.tools.package_extension import MAX_BYTES, build_zip, package_files


def test_release_budget_and_runtime_contents():
    files = package_files()
    zipped, report = build_zip(files)
    assert report["unpackedBytes"] <= MAX_BYTES
    assert report["zipBytes"] <= MAX_BYTES
    assert "src/ocr/core-loader.js" in files
    assert "vendor/tesseract-core/tesseract-core-simd-lstm.wasm.gz" in files
    assert not any(name.startswith(("tests/", "tools/", "test-results/", "node_modules/"))
                   for name in files)
    assert not any(name.endswith(".wasm.js") for name in files)
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        assert set(archive.namelist()) == set(files)
        assert archive.read("manifest.json") == files["manifest.json"]


def test_unpacked_limit_cannot_be_hidden_by_zip_compression():
    with pytest.raises(ValueError, match="Unpacked extension"):
        build_zip({"oversized.js": b"a" * (MAX_BYTES + 1)})


def test_zip_overhead_also_counts_toward_limit():
    with pytest.raises(ValueError, match="Extension ZIP"):
        build_zip({"tiny.js": b"a"}, limit=1)


def test_zip_is_reproducible_independent_of_input_order():
    a = build_zip({"a.js": b"a", "b.js": b"b"})
    b = build_zip({"b.js": b"b", "a.js": b"a"})
    assert a == b
