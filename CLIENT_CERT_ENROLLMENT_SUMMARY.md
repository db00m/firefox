# Site Client Certificate Enrollment Summary

## Overview

This patch set adds the first slice of a site-driven client certificate enrollment feature.

The intended flow is:

1. A site returns an HTTP response header indicating that it wants to enroll a client certificate.
2. Firefox validates the request and asks the user for permission.
3. If the user approves, Firefox will eventually generate a key pair, create a CSR, submit it to the enrollment endpoint, and install the returned certificate and private key for later mTLS use.

The request trigger, prompting, and a first backend are now implemented. The current state includes request detection in necko, prompting in PSM, key generation, CSR creation, POST submission to the enrollment endpoint, and import of returned certificate material through the existing cert DB path. It still does not implement a finalized protocol, policy integration, persistence, or tests.

## What Is Implemented

### 1. Response header detection in necko

Files:

- [netwerk/protocol/http/nsHttpChannel.cpp](/home/dbl00m11/Projects/firefox-source/firefox/netwerk/protocol/http/nsHttpChannel.cpp)
- [netwerk/protocol/http/nsHttpChannel.h](/home/dbl00m11/Projects/firefox-source/firefox/netwerk/protocol/http/nsHttpChannel.h)

Implemented behavior:

- Added `ProcessClientCertEnrollmentHeader()`.
- Called it from `ProcessSecurityHeaders()`.
- Detects the `Client-Cert-Enrollment` response header.
- Restricts processing to secure top-level document loads.
- Requires a trustworthy TLS connection with no overridable certificate error.
- Requires the enrollment URL to be `https`.
- Currently restricts the enrollment URL to be same-origin with the requesting page.
- Supports an optional `https` destination URL in the header after
  the token parameter.
- Dispatches valid requests into a new PSM service.

Why this was added here:

- `nsHttpChannel` already handles security-sensitive response headers such as HSTS.
- The enrollment trigger is a server response header, so the natural entry point is necko.
- This keeps parsing and initial validation near other response-header security logic.

### 2. New PSM enrollment service

Files:

- [security/manager/ssl/nsISiteClientCertEnrollmentService.idl](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/nsISiteClientCertEnrollmentService.idl)
- [security/manager/ssl/SiteClientCertEnrollmentService.sys.mjs](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/SiteClientCertEnrollmentService.sys.mjs)
- [security/manager/ssl/components.conf](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/components.conf)
- [security/manager/ssl/moz.build](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/moz.build)

Implemented behavior:

- Added a new XPCOM service:
  - contract id: `@mozilla.org/security/site-client-cert-enrollment-service;1`
- Service accepts:
  - requesting URI
  - enrollment URI
  - optional enrollment token
  - optional destination URI
  - browser id
- Resolves the top-level `BrowsingContext`.
- Deduplicates concurrent identical requests.
- Prompts the user for approval.
- Emits observer notifications for approval and denial.
- Calls into the enrollment backend to:
  - create a CSR
  - submit it with `POST`
  - parse the response
  - complete or abort the pending enrollment
- Sends the CSR as `application/pkcs10`.
- If the header includes `token="..."`, sends that token on the CSR request as
  `Authorization: Bearer <token>`.
- If the header includes a destination URI, redirects the same tab to that URI
  after the certificate is successfully installed.
- Accepts either:
  - raw response bytes
  - JSON with a `certificate` field and optional `encoding`

Observer topics added:

- `psm:site-client-cert-enrollment-approved`
- `psm:site-client-cert-enrollment-denied`

Why this was added here:

- This is certificate and security behavior, so it belongs in PSM rather than in necko or browser UI code.
- PSM already owns client-auth selection, cert DB operations, and certificate-related prompting.
- Centralizing orchestration in one service keeps the necko trigger path simple while allowing the backend to evolve without touching necko again.

### 3. New PSM enrollment backend helper

Files:

- [security/manager/ssl/nsISiteClientCertEnrollmentBackend.idl](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/nsISiteClientCertEnrollmentBackend.idl)
- [security/manager/ssl/SiteClientCertEnrollmentBackend.h](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/SiteClientCertEnrollmentBackend.h)
- [security/manager/ssl/SiteClientCertEnrollmentBackend.cpp](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/SiteClientCertEnrollmentBackend.cpp)
- [security/manager/ssl/components.conf](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/components.conf)
- [security/manager/ssl/moz.build](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/moz.build)

Implemented behavior:

- Added a new XPCOM backend:
  - contract id: `@mozilla.org/security/site-client-cert-enrollment-backend;1`
- Generates a persistent NSS key pair on the internal key slot.
- Constructs a PKCS#10 CSR using a P-256 key and a subject CN derived from the requesting host.
- Returns the CSR in PEM form to the JS orchestration layer.
- Tracks pending enrollments by request id.
- On success:
  - imports the returned certificate material through `nsIX509CertDB.importUserCertificate()`
  - leaves the new cert discoverable through the existing NSS/user-cert path
- On failure:
  - deletes the generated private key with `PK11_DeleteTokenPrivateKey()`

Why this was added here:

- Key generation and cert import belong in PSM/NSS, not in JS-only code.
- Reusing `nsIX509CertDB.importUserCertificate()` avoids creating a second user-cert installation path.
- Tracking pending key material in one helper keeps cleanup and successful completion symmetric.

### 4. Pref gate

File:

- [modules/libpref/init/StaticPrefList.yaml](/home/dbl00m11/Projects/firefox-source/firefox/modules/libpref/init/StaticPrefList.yaml)

Implemented behavior:

- Added:
  - `security.tls.client_certificate_enrollment.enabled`

Default value:

- `false`

Why this was added:

- The feature is incomplete and should be disabled by default.
- This makes it possible to test the plumbing without exposing unfinished behavior by default.

### 5. Logging

Files:

- [netwerk/protocol/http/nsHttpChannel.cpp](/home/dbl00m11/Projects/firefox-source/firefox/netwerk/protocol/http/nsHttpChannel.cpp)
- [security/manager/ssl/SiteClientCertEnrollmentService.sys.mjs](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/SiteClientCertEnrollmentService.sys.mjs)

Implemented behavior:

- Added logging for:
  - pref-disabled early exit
  - malformed or unreasonable header values
  - missing security info
  - untrustworthy TLS connections
  - non-HTTPS enrollment URLs
  - cross-origin enrollment URLs
  - service dispatch
  - duplicate suppression
  - user approval
  - user denial
  - inability to derive the CSR subject host
  - CSR submission start
  - enrollment completion
  - enrollment failure
  - abort-cleanup failure
  - enrollment response status/content-type before body parsing
  - parsed response byte length
  - call into backend completion
  - return from backend completion
  - C++ backend entry into completion
  - C++ backend call into `ImportUserCertificate()`
  - C++ backend result from `ImportUserCertificate()`

Current logging shape:

- The new backend flow is logged in the JS service layer, not in the C++ backend helper.
- Temporary crash-triage logging has also been added in `SiteClientCertEnrollmentBackend.cpp` via `gPIPNSSLog`.
- As a result:
  - request validation failures are visible in necko
  - prompt and network/backend orchestration failures are visible in `SiteClientCertEnrollmentService.sys.mjs`
  - low-level import-path progress is now partially visible in the C++ helper
  - lower-level NSS failures still do not all have dedicated helper-specific error detail beyond the surrounding progress logs

Why this was added:

- This feature crosses necko, PSM, prompting, and later certificate storage.
- Without explicit logs, failures would be difficult to localize.

## What Still Needs To Be Implemented

### 1. Enrollment backend

Current state:

- `_beginEnrollment()` in [SiteClientCertEnrollmentService.sys.mjs](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/SiteClientCertEnrollmentService.sys.mjs) now drives a first working backend.
- A new backend helper in [SiteClientCertEnrollmentBackend.cpp](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/SiteClientCertEnrollmentBackend.cpp) generates keys, creates CSRs, and imports returned certificates.

Still needed:

- Define and stabilize the enrollment protocol.
- Validate the returned certificate material beyond successful import.
- Decide how server-provided chains and non-leaf material should be handled.
- Decide whether the current host-derived subject is sufficient or whether the protocol should carry subject details explicitly.

Likely home:

- Backend orchestration should stay in `security/manager/ssl`.
- Crypto primitives should come from NSS.
- Installation should reuse existing cert DB paths where possible.

### 2. Certificate/key installation path

Relevant existing files:

- [security/manager/ssl/nsNSSCertificateDB.cpp](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/nsNSSCertificateDB.cpp)
- [security/manager/ssl/nsPKCS12Blob.cpp](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/nsPKCS12Blob.cpp)

Still needed:

- Decide the canonical format of the enrollment server response.
- Handle server responses that return more than a single leaf certificate in a more explicit way.
- Validate that the returned certificate actually matches the pending private key before or after import.
- Ensure the installed cert is discoverable by the existing TLS client-auth selection flow.

### 3. Integration with existing client-auth selection

Relevant existing file:

- [security/manager/ssl/TLSClientAuthCertSelection.cpp](/home/dbl00m11/Projects/firefox-source/firefox/security/manager/ssl/TLSClientAuthCertSelection.cpp)

Still needed:

- Bind the enrolled certificate to the requesting site or origin policy.
- Decide whether enrollment should happen only on header receipt, or also be tied to later mTLS requests.
- Ensure the newly enrolled certificate is selected correctly during later client-auth handshakes.

### 4. Better permission and persistence model

Current state:

- The user is prompted each time a request comes through unless deduplicated in-flight.
- Approval/denial is only signaled via observer notifications.

Still needed:

- Persist allow/deny decisions if desired.
- Decide whether this should integrate with site permissions.
- Possibly add a dedicated permission type and management UI.

### 5. Better prompt/UI integration

Current state:

- The prompt is implemented inside the new PSM service using `Services.prompt`.

Still needed:

- Evaluate whether this should move to browser permission UI for a more native site-permission experience.
- Add localized strings.
- Improve wording and UX around the enrollment request.

### 6. Tests

Still needed:

- Header-processing tests.
- PSM service tests.
- Prompt behavior tests.
- End-to-end tests for approval and denial.
- Backend tests for CSR generation, certificate import, and abort cleanup.

## Current Header Format For Testing

The currently implemented trigger is a response header:

```http
Client-Cert-Enrollment: https://example.com/enroll; token="opaque-one-time-token"
```

Current enforced constraints:

- Response must be a top-level HTTPS document load.
- TLS connection must be trustworthy.
- Enrollment URL must be HTTPS.
- Enrollment URL must currently be same-origin with the response URL.
- Destination URL, if present, must be HTTPS.
- Pref must be enabled:

```text
security.tls.client_certificate_enrollment.enabled = true
```

## Current CSR Request Format

Once the user approves enrollment, Firefox sends a CSR to the enrollment URL as
an HTTPS `POST`.

Current request shape:

```http
POST /enroll HTTP/1.1
Host: example.com
Accept: application/json, application/pkix-cert, application/pkcs7-mime, application/x-pem-file, application/pem-certificate-chain, text/plain
Content-Type: application/pkcs10
Authorization: Bearer opaque-one-time-token
```

Request body:

```pem
-----BEGIN CERTIFICATE REQUEST-----
MIIB...
-----END CERTIFICATE REQUEST-----
```

Notes:

- The `Authorization` header is only sent if the `Client-Cert-Enrollment`
  header included a `token="..."` parameter.
- The request body is a PEM-encoded PKCS#10 CSR.
- The CSR is generated from a newly-created persistent NSS token key pair.
- The CSR currently uses a P-256 key.
- The CSR subject is currently `CN=<requesting host>`.

## Current CSR Response Formats

The enrollment endpoint must return an HTTP `2xx` response. Any non-OK response
is treated as enrollment failure.

Firefox currently accepts either JSON or raw certificate bytes.

### 1. JSON response

Recommended shape:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "encoding": "pem"
}
```

Supported JSON encodings:

- `encoding: "pem"`
- `encoding: "base64"`
- `encoding: "base64-der"`
- no `encoding`, which is treated the same as base64/base64-der
- if the `certificate` string contains `-----BEGIN`, it is treated as PEM even
  without `encoding: "pem"`

### 2. Raw response body

If the response `Content-Type` is not JSON, Firefox reads the response body as
raw bytes and passes it directly to `nsIX509CertDB.importUserCertificate()`.

Example:

```http
HTTP/1.1 200 OK
Content-Type: application/pkix-cert
Cache-Control: no-store
```

```text
...raw DER certificate bytes...
```

Notes:

- Firefox currently does not enforce a narrow response `Content-Type` beyond
  treating `application/json` specially.
- The returned certificate material is passed directly to
  `nsIX509CertDB.importUserCertificate()`.
- The current implementation is simplest and most predictable when the server
  returns a single leaf certificate matching the generated private key.

## Important Notes

- This is still an in-progress implementation rather than a finalized feature.
- The current backend assumes a simple `POST`-based enrollment exchange and is intentionally conservative.
- The current implementation is still safe to keep disabled behind the pref while protocol, policy, and test coverage are finished.
