/**
 * Pure decisions for the headless sidecar. No browser and no network.
 *
 * One nav HTTP call has a hard deadline of 240s. Nginx allows 300s.
 * Task drain, navigation, plugin wait, list walks, and one re-login
 * all share that deadline. A step gets only the time still left.
 */

export const TASK_WAIT_MS = 60_000;
export const OPEN_WAIT_MS = 120_000;
export const RELOGIN_BUDGET_MS = 45_000;
export const NAV_CALL_DEADLINE_MS = 240_000;
export const PROXY_READ_TIMEOUT_MS = 300_000;

export class NavTimeout extends Error {
    constructor() {
        super("nav call timed out");
        this.name = "NavTimeout";
    }
}

/**
 * Milliseconds left for one step, capped, or a timeout if the nav
 * deadline has already passed.
 *
 * @param {number} deadline
 * @param {number} cap
 * @param {number} [now]
 * @returns {number}
 */
export function stepBudget(deadline, cap, now = Date.now()) {
    const left = deadline - now;
    if (left <= 0) {
        throw new NavTimeout();
    }
    return Math.min(cap, left);
}

export const HOSTS_LIMIT = 32;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ hashLogin?: boolean, loginFormVisible?: boolean, rpcStatus?: number | null }} signals
 * @returns {boolean}
 */
export function sessionDead(signals) {
    if (!signals) {
        return false;
    }
    if (signals.hashLogin || signals.loginFormVisible) {
        return true;
    }
    return signals.rpcStatus === 401 || signals.rpcStatus === 403;
}

/**
 * How open_file should wait for the plugin.
 *
 * A page change inside the open file does not open a new plugin socket.
 * Waiting for the socket serial to increase would time out.
 *
 * @returns {"noop" | "page" | "file"}
 */
export function openWaitMode({ currentFileId, targetFileId, currentPageId, requestedPageId, pluginOpen }) {
    const sameFile = Boolean(currentFileId) && currentFileId === targetFileId;
    const samePage = !requestedPageId || currentPageId === requestedPageId;
    if (sameFile && samePage && pluginOpen) {
        return "noop";
    }
    if (sameFile && pluginOpen && requestedPageId && currentPageId !== requestedPageId) {
        return "page";
    }
    return "file";
}

/**
 * Track one plugin WebSocket frame. Incoming task requests are in flight
 * until a response with the same id is sent.
 *
 * @param {Set<string>} ids
 * @param {boolean} incoming
 * @param {string} text
 * @returns {Set<string>}
 */
export function notePluginFrame(ids, incoming, text) {
    if (!text || !text.startsWith("{")) {
        return ids;
    }
    let message;
    try {
        message = JSON.parse(text);
    } catch {
        return ids;
    }
    if (incoming && message && message.id && message.task) {
        ids.add(String(message.id));
    }
    if (!incoming && message && message.id && Object.prototype.hasOwnProperty.call(message, "success")) {
        ids.delete(String(message.id));
    }
    return ids;
}

/**
 * @param {Set<string>} hosts
 * @param {string} host
 * @param {number} [limit]
 * @returns {Set<string>}
 */
export function rememberHost(hosts, host, limit = HOSTS_LIMIT) {
    if (!host) {
        return hosts;
    }
    if (hosts.has(host)) {
        return hosts;
    }
    hosts.add(host);
    while (hosts.size > limit) {
        const oldest = hosts.values().next().value;
        hosts.delete(oldest);
    }
    return hosts;
}

/**
 * @param {Map<string, number>} sessions
 * @param {number} now
 * @param {number} idleMs
 */
export function expireSessions(sessions, now, idleMs) {
    for (const [id, seen] of sessions) {
        if (now - seen > idleMs) {
            sessions.delete(id);
        }
    }
}

/**
 * @param {{ ageMs: number, navDepth: number, inflight: number, maxAge: number }} state
 * @returns {boolean}
 */
export function shouldRecycleContext(state) {
    return state.navDepth === 0 && state.inflight === 0 && state.ageMs >= state.maxAge;
}
