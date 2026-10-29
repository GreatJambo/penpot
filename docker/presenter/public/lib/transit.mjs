/**
 * The subset of Transit JSON that the Penpot exporter speaks.
 * Maps are ["^ ", k, v, ...]. Keywords are "~:name". UUIDs are "~u...".
 */

export class Keyword {
    constructor(name) {
        this.name = name;
    }
}

export class Uuid {
    constructor(value) {
        this.value = value;
    }
}

function escapeString(value) {
    if (value.startsWith("~") || value.startsWith("^")) {
        return `~${value}`;
    }
    return value;
}

export function encode(value) {
    if (value instanceof Keyword) {
        return `~:${value.name}`;
    }
    if (value instanceof Uuid) {
        return `~u${value.value}`;
    }
    if (typeof value === "string") {
        return escapeString(value);
    }
    if (typeof value === "number" || typeof value === "boolean" || value == null) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(encode);
    }
    if (typeof value === "object") {
        const out = ["^ "];
        for (const [key, item] of Object.entries(value)) {
            out.push(encode(key instanceof Keyword ? key : new Keyword(key)));
            out.push(encode(item));
        }
        return out;
    }
    throw new Error(`cannot encode ${typeof value}`);
}

function decodeString(value) {
    if (value.startsWith("~:")) {
        return new Keyword(value.slice(2));
    }
    if (value.startsWith("~u")) {
        return new Uuid(value.slice(2));
    }
    if (value.startsWith("~~") || value.startsWith("~^")) {
        return value.slice(1);
    }
    return value;
}

export function decode(value) {
    if (typeof value === "string") {
        return decodeString(value);
    }
    if (Array.isArray(value)) {
        if (value[0] === "^ ") {
            const map = {};
            for (let i = 1; i < value.length; i += 2) {
                const key = decode(value[i]);
                const name = key instanceof Keyword ? key.name : String(key);
                map[name] = decode(value[i + 1]);
            }
            return map;
        }
        return value.map(decode);
    }
    if (value && typeof value === "object") {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0].startsWith("~#")) {
            const tag = keys[0].slice(2);
            const inner = decode(value[keys[0]]);
            if (tag === "uri") {
                return typeof inner === "string" ? inner : String(inner);
            }
            return inner;
        }
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            const name = key.startsWith("~:") ? key.slice(2) : key;
            out[name] = decode(item);
        }
        return out;
    }
    return value;
}

export function keywordName(value) {
    if (value instanceof Keyword) {
        return value.name;
    }
    if (typeof value === "string" && value.startsWith("~:")) {
        return value.slice(2);
    }
    return value;
}
