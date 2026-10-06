const APP_ORIGIN = "http://127.0.0.1:5500";
const reportedExternalFailures = new Set();

function monitorRequests(page, errors) {
  const externalFailures = new Set();
  page.route(`${APP_ORIGIN}/favicon.ico`, route => route.fulfill({ status: 204, body: "" }));
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() !== "error") return;

    const text = message.text();
    const networkError = text.match(/Failed to load resource: (net::[A-Z_]+)/)?.[1];
    if (networkError && externalFailures.has(networkError)) {
      console.warn(`External resource console failure: ${text}`);
      return;
    }

    errors.push(`console: ${text}`);
  });
  page.on("requestfailed", request => {
    const errorText = request.failure()?.errorText || "request failed";
    const failure = `${request.url()} (${errorText})`;
    if (new URL(request.url()).origin === APP_ORIGIN) {
      errors.push(`network: ${failure}`);
      return;
    }

    externalFailures.add(errorText);
    if (!reportedExternalFailures.has(failure)) {
      reportedExternalFailures.add(failure);
      console.warn(`External network/CDN failure: ${failure}`);
    }
  });
}

module.exports = { monitorRequests };
