# Shared extension identity

The original unpacked build had no manifest `key`, so its ID depended on its installation
path. Downloading it on another device changed that ID. The Google OAuth client was
registered for the first device's ID, producing `OAuth2 request failed: Bad client id`
on the other device.

Version 0.1.3 includes a fixed public RSA key in `frontend/extension/manifest.json`.
Every unpacked installation of this build must report the same ID:

```text
llobmhbiebleflpmbfdobhbkecbgefab
```

Users do not generate keys, register IDs, or create Google Cloud projects. The maintainer
configures this once and distributes the same configured build to everyone.

## One-time maintainer setup

1. In the existing Google Cloud project, open **Google Auth Platform → Clients → Create
   client**. Select **Chrome Extension** and set the **Item ID** to the shared ID above.
   Create a separate client so existing 0.1.2 installations keep their registration.
2. Put the resulting public client ID in `frontend/extension/manifest.json` under
   `oauth2.client_id`. On 2026-10-01 the maintainer supplied
   `305934899702-prd0qghi34ijrcud27cs3o2rrpap42jf.apps.googleusercontent.com`, which is now
   configured in this build. The previous client must not be reused for the new ID.
3. Publish the updated `frontend/picker-bridge/config.js` alongside the existing helper
   assets. Its allowlist includes both the original and shared extension origins.
4. If the Google project is in **Testing**, add the testers' accounts to its test-user
   list. For general availability, configure the appropriate production audience and
   complete any verification Google requires. This is independent of the extension ID.
5. Distribute the configured build. On two computers, confirm the ID above, sign in,
   choose a Drive file/folder, upload, and download before declaring the rollout complete.

The manifest key is public and belongs in the distributed build. Keep the signing private
key outside the repository and outside user ZIPs. Do not regenerate the identity for each
release. If a Chrome Web Store item is created later, check its assigned ID and public key
before using the same OAuth registration; uploading a ZIP alone does not establish that
the store and GitHub builds have the same identity.

## User installation after configuration

Download the configured ZIP, extract it to a folder that will remain in place, open
`chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select
the folder containing this build's `manifest.json`, then open Filewise and connect the
user's own Google account. No ID configuration or local backend is required.

Moving from the old ID to this ID creates a separate extension storage area. Existing Drive
originals remain where they are, but the old profile's local file registrations and pending
upload journals do not automatically migrate. Finish or reconcile pending uploads in the
old installation before replacing it, and register existing files through **Add from Drive**
in the new installation.

## Verification status

All 113 Node tests pass. Two actual Chromium installations in separate folders and fresh
profiles both report `llobmhbiebleflpmbfdobhbkecbgefab` and pass the configured-build check.
The maintainer supplied the new OAuth client ID. The helper allowlist update is committed
to `gh-pages` at `5c4da10a0c43ec14c9b6dd79e0cc58dcb2485d93`. The hosted `config.js` returns
HTTP 200 and contains both extension IDs. An authenticated test on the second device is
pending. The currently working 0.1.2
installation has not been modified by preparation of this separate candidate.

References: [Chrome manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key),
[Chrome OAuth setup](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth),
[Google OAuth audience](https://support.google.com/cloud/answer/15549945).
