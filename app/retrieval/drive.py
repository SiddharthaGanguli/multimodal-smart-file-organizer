"""Verify Google identity and current file access; never persist bearer tokens."""

from urllib.parse import quote

import httpx

from app.retrieval.models import Source


class SearchError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class DriveSession:
    def __init__(self, token, client=None):
        self.token = token
        self.client = client or httpx.Client(timeout=15, follow_redirects=False)
        self.owns_client = client is None
        self.owner = None

    def close(self):
        self.token = None
        if self.owns_client:
            self.client.close()

    def get(self, path, fields):
        try:
            response = self.client.get(f"https://www.googleapis.com/drive/v3/{path}",
                                       params={"fields": fields},
                                       headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError:
            raise SearchError(503, "Google Drive is unavailable. Try again shortly.") from None
        if response.status_code == 401:
            raise SearchError(401, "Reconnect Google Drive to use search.")
        if response.status_code == 404:
            raise SearchError(404, "This file is no longer available in Google Drive.")
        if response.status_code == 403:
            try:
                reasons = {x.get("reason") for x in response.json()["error"].get("errors", [])}
            except (ValueError, KeyError, TypeError, AttributeError):
                reasons = set()
            if reasons & {"rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"}:
                raise SearchError(503, "Google Drive request limit reached. Try again later.")
            raise SearchError(403, "Google Drive no longer permits access to this file.")
        if response.status_code != 200:
            raise SearchError(503, "Google Drive could not verify access. Try again shortly.")
        try:
            result = response.json()
            if not isinstance(result, dict):
                raise TypeError("Expected an object")
            return result
        except (ValueError, TypeError):
            raise SearchError(503, "Google Drive returned an invalid response.") from None

    def authenticate(self):
        user = self.get("about", "user(permissionId)").get("user")
        self.owner = user.get("permissionId") if isinstance(user, dict) else None
        if not isinstance(self.owner, str) or not self.owner or len(self.owner) > 200:
            raise SearchError(401, "Google could not verify your account.")
        return self.owner

    def source(self, file_id):
        file = self.get(f"files/{quote(file_id, safe='')}",
                        "id,name,mimeType,size,modifiedTime,sha256Checksum,trashed,"
                        "capabilities(canDownload)")
        if file.get("id") != file_id or file.get("trashed"):
            raise SearchError(404, "This file is no longer available in Google Drive.")
        if not file.get("capabilities", {}).get("canDownload"):
            raise SearchError(403, "Google Drive does not permit reading this file's text.")
        try:
            return Source(name=file["name"], mime_type=file["mimeType"], size=int(file["size"]),
                          modified_time=file["modifiedTime"], sha256=file.get("sha256Checksum"))
        except (KeyError, ValueError, TypeError):
            raise SearchError(409, "The file changed or is unsupported. Refresh your library.") from None


def matches(expected, actual):
    return (expected.name == actual.name and expected.mime_type == actual.mime_type
            and expected.size == actual.size and expected.modified_time == actual.modified_time
            and (not actual.sha256 or expected.sha256 == actual.sha256))
