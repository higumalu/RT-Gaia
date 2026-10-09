# Security policy

> **Regulatory status.** RT-Gaia is research software. It is not a medical device, has not been
> cleared or approved by any regulatory authority, and must not be used for clinical decision
> making. Use only de-identified data for testing and demonstrations.

## Supported versions

RT-Gaia is pre-release software (version 0.1.0). Security fixes are made on the latest `dev`
branch. Once releases are published, only the most recent release receives security fixes.

| Version | Supported |
|---|---|
| Latest commit on the `dev` branch | Yes |
| Most recent release (when releases exist) | Yes |
| Older commits and releases | No |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and select
**Report a vulnerability**. Do not open a public issue, pull request or discussion about a suspected
vulnerability.

Please include:

- the affected component (for example the API server, the viewer, the DICOM receiver, the plugin
  host or a deployment file) and the commit or version;
- how RT-Gaia was deployed (Docker Compose or from source, with or without a database, HTTP or
  HTTPS, plugins in use);
- steps to reproduce, and a proof of concept if you have one;
- the impact you expect (for example data disclosure, privilege escalation, denial of service);
- whether the issue is already public or has been reported elsewhere.

Never include real patient data in a report. Use synthetic or de-identified data.

What to expect: the maintainers acknowledge reports as soon as they can, investigate them, keep you
informed about the fix, and coordinate the timing of public disclosure with you. RT-Gaia is a small
project without guaranteed response times. Tell us in your report whether and how you would like
to be credited.

## Security model

This section summarizes the protections built into RT-Gaia and their limits. The
[Administration guide](docs/administration.md) describes how to configure them.

### Intended deployment

RT-Gaia is designed for an on-premises installation on a trusted hospital or research network:
one API process, PostgreSQL, an optional job worker and DICOM receiver, behind a reverse proxy that
terminates HTTPS. Running without a database, or with `RTGAIA_AUTH=off`, disables authentication
and is meant only for single-user development.

### Authentication

- Accounts are local to RT-Gaia and stored in PostgreSQL. The first administrator can be created
  only while the database has no accounts; the check and the creation run in one transaction.
- Passwords are hashed with Argon2id. The password policy requires a minimum length (12 characters
  by default) and rejects passwords that contain the username, repeat a single character or are
  common. Consecutive failed sign-ins lock the account (5 failures, 15 minutes by default). Unknown
  usernames and wrong passwords produce the same response and take comparable time.
- A password set by an administrator must, by default, be changed at the next sign-in; until then
  the account can call no API other than changing its password.
- A session is a token signed with HMAC-SHA-256 using a key derived from `RTGAIA_SECRET`. It
  expires after 12 hours and is delivered in an `HttpOnly`, `SameSite=Lax` cookie, which is also
  marked `Secure` when the request reaches the API over HTTPS.
- Tokens issued before a password change are rejected. Disabling an account, changing its role or
  resetting its password takes effect immediately, including for open WebSocket connections, which
  are also re-validated every 30 seconds.

### Authorization

- Every API request is checked on the server against four ordered roles: `viewer`, `contourer`,
  `approver` and `admin`. Reading requires `viewer`, as do a few actions that do not change stored
  data (opening a case, rendering, DVH export, temporary dose computations); other changes require
  `contourer`; approving structures requires `approver`; accounts, service settings, DICOM node
  configuration, plugin registration, the archive and removing data from the library require
  `admin`.
- Object-level checks apply on top of roles. The contours of approved structures cannot be edited
  by anyone until an approver reopens them. Imported structure sets are read-only, and users edit only their own
  working sets (administrators excepted). Unsaved plugin results and dose-operation results are
  visible only to their creator, administrators included; other users receive "not found". Import
  batches, trash items and plugin jobs can be managed only by their creator and by administrators.
  A WebSocket connection is refused if the session belongs to another user.

### Audit log

- Every successful request that changes data is recorded with the user, time, action, object and
  client address, as are background events such as purges, capacity warnings and integrity
  problems.
- The audit table is append-only: a database trigger rejects `UPDATE` and `DELETE`. Database owners
  can still alter the schema, so protect the database credentials.
- If an event cannot be written, it is kept in a retry table; if that also fails, the request
  returns `503 AUDIT_UNAVAILABLE` instead of reporting success.
- Read-only requests (including downloads of library data) and sign-ins are not recorded.

### Input and resource limits

- Uploads are limited while they stream (4 GiB per request by default). Zip archives are checked
  against limits for total uncompressed size, number of files and compression ratio before any
  file is extracted; files whose actual size exceeds the size declared in the archive are
  rejected. Archive paths are sanitized, and staged files get random names.
- Only files with the DICOM preamble are imported. A file with an existing SOP Instance UID but
  different content is rejected and never overwrites stored data.
- Image sizes for reslicing and 3D rendering, concurrent CPU-bound work and concurrent password
  hashing are bounded.

### Host name validation and the public URL

The externally visible address of RT-Gaia is configuration (`RTGAIA_PUBLIC_URL`), never learned
from incoming requests. With authentication enabled, the API refuses to start without it. Requests
to `/api/v1/*` whose `Host` header is not in the allowed list (derived from `RTGAIA_PUBLIC_URL`, or
`RTGAIA_ALLOWED_HOSTS`) are rejected with `400 BAD_HOST`.

The API allows cross-origin requests from any origin but without credentials, and the session
cookie is `SameSite=Lax`, so browsers do not send it with cross-site requests that change data.
RT-Gaia does not use separate CSRF tokens.

### Plugins

- Plugins are trusted services. Only administrators register them, or the plugin itself when an
  administrator has set a registration token. Manifests are validated, and licenses outside an
  allow-list (MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0) must be accepted explicitly; the
  override is audited.
- RT-Gaia authenticates to a plugin with a per-plugin bearer token and forwards the calling user's
  name and role. A plugin calls back with a random per-job token that RT-Gaia stores only as a
  SHA-256 hash, that expires 10 minutes after the job's time limit and that is revoked when the
  job ends. Callbacks are limited to the capabilities declared in the manifest.
- A plugin UI bundle runs in the user's browser with the same privileges as RT-Gaia. It is not
  sandboxed. RT-Gaia loads a bundle only if the manifest declares `ui.trust: host-equivalent`, pins
  its SHA-256 digest at registration and on version changes, and checks the digest on the server
  and in the browser before loading it. A changed bundle quarantines the plugin until an administrator registers it again.
- Result files that a plugin offers as URLs are downloaded only from approved origins (the plugin's
  endpoint, origins declared in its manifest, and origins approved by an administrator), only over
  `http` or `https`, without following redirects, never from paths containing `..`, and never
  from hosts that resolve to link-local (including cloud metadata), multicast, reserved or
  unspecified addresses. Downloads stop at a size limit. Private network addresses are allowed for
  approved origins.
- Plugin results stay private to the requesting user until the user saves them.

### DICOM networking

DICOM associations are not encrypted or authenticated beyond AE titles: TLS is not supported. The
receiver accepts associations only from AE titles registered with the receive role, optionally
bound to a source IP address (unless an administrator allows unregistered sources). The called AE
title is not checked. Received data is recorded as import jobs, not in the audit log. Operate the
DICOM port only on a trusted network.

### Test endpoints

The production command `rtgaia-server` never mounts the test endpoints under `/api/v1/_test/`.
They exist only in the test server `rtgaia-testbe --test-api`, which `scripts/dev.sh` uses; that
server must not be used with real data or on a shared network.

### Patient data

Patient names are not stored in clear text in the database or caches; RT-Gaia stores a keyed
HMAC-SHA-256 hash (key from `RTGAIA_PHI_KEY` or `RTGAIA_SECRET`). Patient IDs and study metadata
are stored in clear text, and the original DICOM files are kept unchanged. Exports are de-identified
by default, but de-identification replaces only the patient name, ID, birth date and sex; UIDs and
other attributes remain.

### Known limitations

- Session tokens are stateless: signing out removes the cookie, but a copied token stays valid
  until it expires (12 hours) unless the password is changed or the account is disabled.
- No single sign-on, directory integration or multi-factor authentication.
- No TLS for DICOM; no sandbox for plugin UI bundles.
- RT-Gaia does not encrypt stored data. Use disk or volume encryption if you need it.
- `/healthz` and `/readyz` are unauthenticated and reveal internal details.
- Users with the `contourer` role can import from any server directory that the API process can
  read.

## Deployment recommendations

- Serve RT-Gaia only over HTTPS, behind a reverse proxy; do not publish the API port (8080) or the
  database port.
- Set a long random `RTGAIA_SECRET` (and keep `RTGAIA_PHI_KEY`, if used) for every RT-Gaia process,
  and set `RTGAIA_PUBLIC_URL` to the address users type.
- Create the first administrator immediately after deployment, and change all default passwords
  and tokens (`POSTGRES_PASSWORD`, example plugin tokens).
- Expose the DICOM receiver port only to the PACS and TPS that need it; keep
  **Accept unregistered sources** off and bind nodes to source IP addresses where possible.
- Run RT-Gaia under an unprivileged account with access only to its own directories.
- Restrict `/healthz` and `/readyz` at the reverse proxy if they should not be public.
- Register only plugins you have reviewed, and leave the plugin registration token unset unless
  you need it.
- Back up the database and data directories regularly, and protect the backups: they contain
  patient data, password hashes and plugin tokens.
- Keep RT-Gaia up to date with the `dev` branch or the latest release.
