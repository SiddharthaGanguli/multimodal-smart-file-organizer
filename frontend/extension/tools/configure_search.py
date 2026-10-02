"""Set the maintainer's exact HTTPS search origin and matching extension permissions."""

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def configure(value, root=ROOT):
    url = urlsplit(value)
    if (url.scheme != "https" or not url.hostname or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+", url.hostname)
            or url.username or url.password
            or url.port or url.path not in {"", "/"} or url.query or url.fragment):
        raise ValueError("Use an exact HTTPS origin without a path, port, credentials, query or fragment.")
    origin = f"https://{url.hostname}"
    config = root / "search-config.js"
    previous = json.loads(config.read_text("utf-8").split("export const SEARCH_API_URL = ", 1)[1].strip().removesuffix(";"))
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    hosts = manifest["host_permissions"]
    if previous and previous + "/*" in hosts:
        hosts.remove(previous + "/*")
    if origin + "/*" not in hosts:
        hosts.append(origin + "/*")
    directives = manifest["content_security_policy"]["extension_pages"].split(";")
    for i, directive in enumerate(directives):
        words = directive.split()
        if words and words[0] == "connect-src":
            words = [word for word in words if word != previous and word != origin]
            directives[i] = " " + " ".join([*words, origin])
    manifest["content_security_policy"]["extension_pages"] = ";".join(directives)
    config.write_text("// Maintainer-owned HTTPS service; users opt in before sending text.\n"
                      f"export const SEARCH_API_URL = {json.dumps(origin)};\n", encoding="utf-8", newline="\n")
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                                       encoding="utf-8", newline="\n")
    return origin


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    args = parser.parse_args()
    print(f"Configured search: {configure(args.origin)}")
