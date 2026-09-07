const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const CLOUDFLARE_HTTPS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);

function enabled(value, defaultValue = false) {
  if (value == null) return defaultValue;
  return String(value).toLowerCase() === "true";
}

function readPublicEndpoint(incomingUrl, env) {
  const port = env.PUBLIC_PORT == null || String(env.PUBLIC_PORT).trim() === ""
    ? 443
    : Number(env.PUBLIC_PORT);
  if (!Number.isInteger(port) || !CLOUDFLARE_HTTPS_PORTS.has(port)) {
    throw new Error(
      "PUBLIC_PORT must be a Cloudflare-supported HTTPS port: " +
      [...CLOUDFLARE_HTTPS_PORTS].join(", "),
    );
  }

  const publicUrl = new URL(env.PUBLIC_ORIGIN || incomingUrl.origin);
  if (publicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use https");
  }
  if (
    publicUrl.username ||
    publicUrl.password ||
    (publicUrl.pathname !== "/" && publicUrl.pathname !== "") ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error("PUBLIC_ORIGIN must contain only https scheme and hostname");
  }
  publicUrl.port = String(port);

  return { origin: publicUrl.origin, port };
}

function readTarget(env) {
  const scheme = String(env.TARGET_SCHEME || "https")
    .trim()
    .toLowerCase()
    .replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https") {
    throw new Error("TARGET_SCHEME must be http or https");
  }

  const host = String(env.TARGET_HOST || "").trim();
  if (!host) throw new Error("TARGET_HOST is required");

  // TARGET_HOST must not contain a scheme, path, credentials, or port.
  const target = new URL(`${scheme}://${host}`);
  if (
    target.username ||
    target.password ||
    target.port ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error("TARGET_HOST must contain only a hostname");
  }

  const defaultPort = scheme === "https" ? 443 : 80;
  const port = env.TARGET_PORT == null || String(env.TARGET_PORT).trim() === ""
    ? defaultPort
    : Number(env.TARGET_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TARGET_PORT must be an integer between 1 and 65535");
  }

  target.port = String(port);
  const basePath = String(env.TARGET_BASE_PATH || "").trim();
  target.pathname = basePath
    ? `/${basePath.replace(/^\/+|\/+$/g, "")}/`
    : "/";

  return target;
}

function buildUpstreamUrl(incomingUrl, targetBase) {
  const target = new URL(targetBase);
  const prefix = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
  target.pathname = `${prefix}${incomingUrl.pathname}` || "/";
  target.search = incomingUrl.search;
  target.hash = "";
  return target;
}

function buildUpstreamHeaders(request, incomingUrl, upstreamUrl, env) {
  const headers = new Headers(request.headers);

  // Host is generated from upstreamUrl by fetch(), so it also matches TLS SNI.
  headers.delete("host");

  const isWebSocket =
    request.headers.get("upgrade")?.toLowerCase() === "websocket";
  for (const name of HOP_BY_HOP_HEADERS) {
    if (isWebSocket && name === "upgrade") continue;
    headers.delete(name);
  }

  // Do not trust X-Forwarded-* supplied by an Internet client.
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  else headers.delete("x-forwarded-for");
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.slice(0, -1));
  headers.set("x-forwarded-port", incomingUrl.port || "443");

  // Enable this only when the upstream checks Origin/Referer against its own host.
  if (enabled(env.REWRITE_ORIGIN)) {
    if (headers.get("origin") === incomingUrl.origin) {
      headers.set("origin", upstreamUrl.origin);
    }
    const referer = headers.get("referer");
    if (referer?.startsWith(`${incomingUrl.origin}/`)) {
      headers.set("referer", `${upstreamUrl.origin}${referer.slice(incomingUrl.origin.length)}`);
    }
  }

  // Store this binding as a Secret. It is the complete header value,
  // for example: "Bearer abc123".
  if (env.UPSTREAM_AUTHORIZATION) {
    headers.set("authorization", String(env.UPSTREAM_AUTHORIZATION));
  }

  return headers;
}

function rewriteLocation(headers, upstreamUrl, targetOrigin, publicOrigin) {
  const location = headers.get("location");
  if (!location) return;

  try {
    const absolute = new URL(location, upstreamUrl);
    if (absolute.origin !== new URL(targetOrigin).origin) return;

    const publicUrl = new URL(publicOrigin);
    absolute.protocol = publicUrl.protocol;
    absolute.host = publicUrl.host;
    headers.set("location", absolute.toString());
  } catch {
    // Keep a malformed Location header unchanged.
  }
}

function rewriteCookieDomains(headers, targetOrigin, publicOrigin) {
  if (typeof headers.getSetCookie !== "function") return;

  const cookies = headers.getSetCookie();
  if (cookies.length === 0) return;

  const targetHost = new URL(targetOrigin).hostname.toLowerCase();
  const publicHost = new URL(publicOrigin).hostname;
  headers.delete("set-cookie");

  for (const cookie of cookies) {
    const rewritten = cookie.replace(/;\s*Domain=([^;]+)/i, (whole, domain) => {
      const normalized = domain.trim().replace(/^\./, "").toLowerCase();
      return normalized === targetHost ? `; Domain=${publicHost}` : whole;
    });
    headers.append("set-cookie", rewritten);
  }
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);

    let upstreamUrl;
    let targetBase;
    let publicEndpoint;
    try {
      targetBase = readTarget(env);
      upstreamUrl = buildUpstreamUrl(incomingUrl, targetBase);
      publicEndpoint = readPublicEndpoint(incomingUrl, env);
    } catch (error) {
      console.error("Invalid proxy configuration", error);
      return new Response("Reverse proxy is not configured correctly", { status: 500 });
    }

    const actualPublicPort = Number(incomingUrl.port || 443);
    if (actualPublicPort !== publicEndpoint.port) {
      return new Response(
        `Use ${publicEndpoint.origin}${incomingUrl.pathname}${incomingUrl.search}`,
        {
          status: 421,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    const headers = buildUpstreamHeaders(
      request,
      incomingUrl,
      upstreamUrl,
      env,
    );

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    };

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, init);
    } catch (error) {
      console.error("Upstream request failed", {
        upstream: upstreamUrl.toString(),
        error: String(error),
      });
      return new Response("Bad Gateway", { status: 502 });
    }

    // Returning the original 101 response preserves Cloudflare's WebSocket handle.
    if (upstreamResponse.status === 101) return upstreamResponse;

    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const name of HOP_BY_HOP_HEADERS) responseHeaders.delete(name);

    const publicOrigin = publicEndpoint.origin;
    if (enabled(env.REWRITE_REDIRECTS, true)) {
      rewriteLocation(responseHeaders, upstreamUrl, targetBase.origin, publicOrigin);
    }
    if (enabled(env.REWRITE_COOKIE_DOMAIN, true)) {
      rewriteCookieDomains(responseHeaders, targetBase.origin, publicOrigin);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
