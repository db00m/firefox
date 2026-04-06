/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ENROLLMENT_PREF = "security.tls.client_certificate_enrollment.enabled";
const BACKEND_CONTRACT_ID =
  "@mozilla.org/security/site-client-cert-enrollment-backend;1";
const APPROVED_TOPIC = "psm:site-client-cert-enrollment-approved";
const DENIED_TOPIC = "psm:site-client-cert-enrollment-denied";
const logger = console.createInstance({ prefix: "SiteClientCertEnrollment" });
const ENROLLMENT_REQUEST_CONTENT_TYPE = "application/pkcs10";
const ENROLLMENT_AUTHORIZATION_SCHEME = "Bearer";
const ENROLLMENT_ACCEPT_HEADER =
  "application/json, application/pkix-cert, application/pkcs7-mime, application/x-pem-file, application/pem-certificate-chain, text/plain";

function log(level, message, details = undefined) {
  let suffix = details ? ` ${JSON.stringify(details)}` : "";
  logger[level](`${message}${suffix}`);
}

function getTopBrowsingContext(browserId) {
  if (!browserId) {
    return null;
  }
  return BrowsingContext.getCurrentTopByBrowserId(browserId);
}

function getPromptModalType(browsingContext) {
  const docViewer = browsingContext?.docShell?.docViewer;
  if (docViewer?.isTabModalPromptAllowed) {
    return Services.prompt.MODAL_TYPE_CONTENT;
  }
  return Services.prompt.MODAL_TYPE_WINDOW;
}

function getDisplayHost(requestingURI) {
  try {
    return requestingURI.displayHost || requestingURI.host;
  } catch {
    return requestingURI.spec;
  }
}

function getEnrollmentBackend() {
  return Cc[BACKEND_CONTRACT_ID].getService(
    Ci.nsISiteClientCertEnrollmentBackend
  );
}

function getEnrollmentSubjectCommonName(requestingURI) {
  try {
    return requestingURI.asciiHost || requestingURI.host;
  } catch {
    return "";
  }
}

function isSameOriginURI(firstURI, secondURI) {
  if (!firstURI || !secondURI) {
    return false;
  }

  try {
    return firstURI.prePath == secondURI.prePath;
  } catch {
    return false;
  }
}

function stringToUtf8Bytes(value) {
  return new TextEncoder().encode(value);
}

function base64ToBytes(value) {
  let binary = atob(value.replace(/\s+/g, ""));
  let bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getEnrollmentResponseName(payload) {
  if (!payload || typeof payload.name != "string") {
    return null;
  }

  let name = payload.name.trim();
  return name || null;
}

function getEnrollmentCertificateNickname(requestingURI, responseName) {
  let host = getDisplayHost(requestingURI);
  if (!responseName || responseName == host) {
    return host;
  }
  return `${host} (${responseName})`;
}

function normalizeEnrollmentJsonResponse(payload, requestingURI) {
  if (
    !payload ||
    typeof payload != "object" ||
    typeof payload.certificate != "string"
  ) {
    throw new Error("enrollment JSON response missing certificate");
  }

  let certificateBytes;
  if (payload.encoding == "pem" || payload.certificate.includes("-----BEGIN")) {
    certificateBytes = stringToUtf8Bytes(payload.certificate);
  } else if (
    !payload.encoding ||
    payload.encoding == "base64" ||
    payload.encoding == "base64-der"
  ) {
    certificateBytes = base64ToBytes(payload.certificate);
  } else {
    throw new Error(
      `unsupported enrollment certificate encoding: ${payload.encoding}`
    );
  }

  return {
    certificateBytes,
    certificateNickname: getEnrollmentCertificateNickname(
      requestingURI,
      getEnrollmentResponseName(payload)
    ),
  };
}

async function readEnrollmentResponse(response, requestingURI) {
  let contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return normalizeEnrollmentJsonResponse(
      await response.json(),
      requestingURI
    );
  }
  return {
    certificateBytes: new Uint8Array(await response.arrayBuffer()),
    certificateNickname: getEnrollmentCertificateNickname(requestingURI, null),
  };
}

async function promptForEnrollment(
  requestingURI,
  enrollmentURI,
  destinationURI,
  browsingContext
) {
  const title = "Client certificate enrollment request";
  const host = getDisplayHost(requestingURI);
  const text =
    `${host} requested permission to enroll a new client certificate for this browser.\n\n` +
    `Enrollment URL: ${enrollmentURI.spec}\n\n` +
    (destinationURI
      ? `After enrollment, Firefox will navigate this tab to: ${destinationURI.spec}\n\n`
      : "") +
    "Allow this site to start client certificate enrollment?";
  const buttonFlags =
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
    Services.prompt.BUTTON_TITLE_CANCEL * Services.prompt.BUTTON_POS_1;

  if (browsingContext) {
    const result = await Services.prompt.asyncConfirmEx(
      browsingContext,
      getPromptModalType(browsingContext),
      title,
      text,
      buttonFlags,
      "Allow",
      null,
      null,
      null,
      false,
      {}
    );
    return (
      result.QueryInterface(Ci.nsIPropertyBag2).get("buttonNumClicked") == 0
    );
  }

  const browserWindow = Services.wm.getMostRecentBrowserWindow();
  return (
    Services.prompt.confirmEx(
      browserWindow,
      title,
      text,
      buttonFlags,
      "Allow",
      null,
      null,
      null,
      {}
    ) == 0
  );
}

function reloadBrowsingContextForNewClientCertificate(
  requestingURI,
  browsingContext
) {
  if (!browsingContext) {
    log("info", "skipping reload after enrollment without browsing context", {
      requestingURI: requestingURI.spec,
    });
    return;
  }

  let currentURI = browsingContext.currentURI;
  if (!isSameOriginURI(requestingURI, currentURI)) {
    log("info", "skipping reload after enrollment on different page", {
      requestingURI: requestingURI.spec,
      currentURI: currentURI?.spec ?? null,
      browserId: browsingContext.browserId,
    });
    return;
  }

  try {
    browsingContext.reload(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
    log("info", "reloading page after client certificate enrollment", {
      requestingURI: requestingURI.spec,
      currentURI: currentURI?.spec ?? null,
      browserId: browsingContext.browserId,
    });
  } catch (error) {
    log("error", "failed to reload page after client certificate enrollment", {
      requestingURI: requestingURI.spec,
      currentURI: currentURI?.spec ?? null,
      browserId: browsingContext.browserId,
      error: `${error}`,
    });
  }
}

function navigateBrowsingContextForNewClientCertificate(
  requestingURI,
  destinationURI,
  browsingContext
) {
  if (!destinationURI) {
    reloadBrowsingContextForNewClientCertificate(
      requestingURI,
      browsingContext
    );
    return;
  }

  if (!browsingContext) {
    log("info", "skipping redirect after enrollment without browsing context", {
      requestingURI: requestingURI.spec,
      destinationURI: destinationURI.spec,
    });
    return;
  }

  let currentURI = browsingContext.currentURI;
  if (!isSameOriginURI(requestingURI, currentURI)) {
    log("info", "skipping redirect after enrollment on different page", {
      requestingURI: requestingURI.spec,
      destinationURI: destinationURI.spec,
      currentURI: currentURI?.spec ?? null,
      browserId: browsingContext.browserId,
    });
    return;
  }

  try {
    let triggeringPrincipal =
      browsingContext.currentWindowGlobal?.documentPrincipal ??
      Services.scriptSecurityManager.getSystemPrincipal();
    browsingContext.loadURI(destinationURI, { triggeringPrincipal });
    log("info", "redirecting page after client certificate enrollment", {
      requestingURI: requestingURI.spec,
      destinationURI: destinationURI.spec,
      currentURI: currentURI?.spec ?? null,
      browserId: browsingContext.browserId,
    });
  } catch (error) {
    log(
      "error",
      "failed to redirect page after client certificate enrollment",
      {
        requestingURI: requestingURI.spec,
        destinationURI: destinationURI.spec,
        currentURI: currentURI?.spec ?? null,
        browserId: browsingContext.browserId,
        error: `${error}`,
      }
    );
  }
}

export function SiteClientCertEnrollmentService() {
  this._pendingRequests = new Set();
}

SiteClientCertEnrollmentService.prototype = {
  classID: Components.ID("{8df03baa-2f95-4a97-af2b-3f77c764f8d1}"),
  QueryInterface: ChromeUtils.generateQI([
    "nsISiteClientCertEnrollmentService",
  ]),

  requestEnrollment(
    requestingURISpec,
    enrollmentURISpec,
    enrollmentToken,
    destinationURISpec,
    browserId
  ) {
    if (!Services.prefs.getBoolPref(ENROLLMENT_PREF, false)) {
      log("debug", "ignoring request while pref is disabled", {
        requestingURISpec,
        enrollmentURISpec,
        destinationURISpec,
      });
      return;
    }

    let requestingURI;
    let enrollmentURI;
    let destinationURI = null;
    try {
      requestingURI = Services.io.newURI(requestingURISpec);
      enrollmentURI = Services.io.newURI(enrollmentURISpec);
      if (destinationURISpec) {
        destinationURI = Services.io.newURI(destinationURISpec);
      }
    } catch (error) {
      log("error", "failed to parse enrollment request URIs", {
        requestingURISpec,
        enrollmentURISpec,
        destinationURISpec,
        error: `${error}`,
      });
      return;
    }

    const requestKey =
      `${requestingURI.prePath}|${enrollmentURI.spec}|` +
      `${enrollmentToken}|${destinationURI?.spec ?? ""}|${browserId}`;
    if (this._pendingRequests.has(requestKey)) {
      log("debug", "ignoring duplicate pending enrollment request", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
        browserId,
        hasEnrollmentToken: !!enrollmentToken,
      });
      return;
    }

    this._pendingRequests.add(requestKey);
    log("info", "received enrollment request", {
      requestingURI: requestingURI.spec,
      enrollmentURI: enrollmentURI.spec,
      destinationURI: destinationURI?.spec ?? null,
      browserId,
      hasEnrollmentToken: !!enrollmentToken,
    });

    void this._handleEnrollmentRequest(
      requestingURI,
      enrollmentURI,
      enrollmentToken,
      destinationURI,
      browserId
    )
      .catch(error => {
        log("error", "unexpected enrollment failure", {
          requestingURI: requestingURI.spec,
          enrollmentURI: enrollmentURI.spec,
          destinationURI: destinationURI?.spec ?? null,
          error: `${error}`,
        });
      })
      .finally(() => {
        this._pendingRequests.delete(requestKey);
      });
  },

  async _handleEnrollmentRequest(
    requestingURI,
    enrollmentURI,
    enrollmentToken,
    destinationURI,
    browserId
  ) {
    const browsingContext = getTopBrowsingContext(browserId);
    const approved = await promptForEnrollment(
      requestingURI,
      enrollmentURI,
      destinationURI,
      browsingContext
    );
    const details = JSON.stringify({
      requestingURI: requestingURI.spec,
      enrollmentURI: enrollmentURI.spec,
      destinationURI: destinationURI?.spec ?? null,
      browserId,
    });

    if (!approved) {
      log("info", "user denied enrollment request", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
      });
      Services.obs.notifyObservers(null, DENIED_TOPIC, details);
      return;
    }

    log("info", "user approved enrollment request", {
      requestingURI: requestingURI.spec,
      enrollmentURI: enrollmentURI.spec,
      destinationURI: destinationURI?.spec ?? null,
    });
    Services.obs.notifyObservers(null, APPROVED_TOPIC, details);
    await this._beginEnrollment(
      requestingURI,
      enrollmentURI,
      enrollmentToken,
      destinationURI,
      browsingContext
    );
  },

  async _beginEnrollment(
    requestingURI,
    enrollmentURI,
    enrollmentToken,
    destinationURI,
    browsingContext
  ) {
    let backend = getEnrollmentBackend();
    let subjectCommonName = getEnrollmentSubjectCommonName(requestingURI);
    if (!subjectCommonName) {
      log("error", "unable to derive enrollment subject common name", {
        requestingURI: requestingURI.spec,
      });
      return;
    }

    let requestId;
    try {
      requestId = backend.createEnrollmentRequest(subjectCommonName);
      let csr = backend.getEnrollmentRequestCsr(requestId);

      log("info", "submitting client certificate enrollment request", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
        browserId: browsingContext?.browserId ?? 0,
        requestId,
        hasEnrollmentToken: !!enrollmentToken,
      });

      let headers = {
        Accept: ENROLLMENT_ACCEPT_HEADER,
        "Content-Type": ENROLLMENT_REQUEST_CONTENT_TYPE,
      };
      if (enrollmentToken) {
        headers.Authorization = `${ENROLLMENT_AUTHORIZATION_SCHEME} ${enrollmentToken}`;
      }

      let response = await fetch(enrollmentURI.spec, {
        method: "POST",
        body: csr,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers,
      });

      if (!response.ok) {
        throw new Error(
          `enrollment endpoint returned HTTP ${response.status} ${response.statusText}`
        );
      }

      log("info", "reading enrollment response body", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
        browserId: browsingContext?.browserId ?? 0,
        requestId,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
      });
      let { certificateBytes, certificateNickname } =
        await readEnrollmentResponse(response, requestingURI);
      log("info", "parsed enrollment response body", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
        browserId: browsingContext?.browserId ?? 0,
        requestId,
        certificateBytesLength: certificateBytes.length,
        hasCertificateName:
          certificateNickname != getDisplayHost(requestingURI),
      });
      log("info", "calling enrollment backend completion", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
        browserId: browsingContext?.browserId ?? 0,
        requestId,
      });
      backend.completeEnrollment(
        requestId,
        certificateBytes,
        certificateNickname
      );
      log("info", "enrollment backend completion returned", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
        browserId: browsingContext?.browserId ?? 0,
        requestId,
      });
      navigateBrowsingContextForNewClientCertificate(
        requestingURI,
        destinationURI,
        browsingContext
      );

      log("info", "completed client certificate enrollment", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
        browserId: browsingContext?.browserId ?? 0,
        requestId,
      });
    } catch (error) {
      if (requestId) {
        try {
          backend.abortEnrollment(requestId);
        } catch (abortError) {
          log("error", "failed to clean up aborted enrollment", {
            requestId,
            error: `${abortError}`,
          });
        }
      }

      log("error", "client certificate enrollment failed", {
        requestingURI: requestingURI.spec,
        enrollmentURI: enrollmentURI.spec,
        destinationURI: destinationURI?.spec ?? null,
        browserId: browsingContext?.browserId ?? 0,
        requestId: requestId ?? null,
        error: `${error}`,
      });
    }
  },
};
