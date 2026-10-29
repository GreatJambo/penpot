/**
 * Cloudflare Access answers an expired session with a redirect.
 * fetch redirect:"manual" surfaces that as an opaque redirect or a 3xx.
 */

export function sessionExpired(response) {
    if (!response) {
        return false;
    }
    if (response.type === "opaqueredirect") {
        return true;
    }
    if (response.status === 0) {
        return true;
    }
    if (response.status >= 300 && response.status < 400) {
        return true;
    }
    return response.redirected === true;
}

export const RELOAD_MESSAGE = "The access check expired. Reload this page.";
