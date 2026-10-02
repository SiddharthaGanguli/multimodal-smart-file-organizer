import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1] / "frontend" / "extension"
spec = importlib.util.spec_from_file_location("configure_search", ROOT / "tools/configure_search.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_configured_host_is_exact_and_replaces_only_previous_service(tmp_path):
    original = json.loads((ROOT / "manifest.json").read_text("utf-8"))
    (tmp_path / "manifest.json").write_text(json.dumps(original), "utf-8")
    (tmp_path / "search-config.js").write_text('export const SEARCH_API_URL = "";', "utf-8")
    module.configure("https://search.example.test/", tmp_path)
    module.configure("https://new.example.test", tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    assert manifest["key"] == original["key"]
    assert manifest["oauth2"] == original["oauth2"]
    assert manifest["host_permissions"] == [*original["host_permissions"], "https://new.example.test/*"]
    csp = manifest["content_security_policy"]["extension_pages"]
    assert "https://new.example.test" in csp and "https://search.example.test" not in csp


@pytest.mark.parametrize("url", ["http://search.example.test", "https://*.example.test",
                                "https://user@example.test", "https://example.test/path",
                                "https://example.test:443", "https://example.test?q=x"])
def test_bad_service_origin_cannot_change_permissions(url, tmp_path):
    with pytest.raises(ValueError):
        module.configure(url, tmp_path)
