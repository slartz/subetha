// Adapted from an earlier worker by the same author; see LICENSE. Three deliberate changes
// — each marked CHANGED below:
//   1. the team-domain var is ACCESS_TEAM_DOMAIN here (the original calls it TEAM_DOMAIN);
//      SubEtha names both Access vars with the same prefix.
//   2. the JWT is also read from the CF_Authorization cookie, not only the
//      Cf-Access-Jwt-Assertion header — the UI is a browser page reached by a plain
//      navigation, and Access sets the cookie on that path.
//   3. ACCESS_AUD is REQUIRED, not optional. With the placeholder value shipped in
//      wrangler.jsonc no JWT can match it, so the worker is closed until the Access app
//      exists and its AUD is pasted in. Fail-closed is the point: a worker that can send
//      mail as any mailbox must not be open for the window between deploy and Access.
let certCache = { at: 0, keys: [] };
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// CHANGED (2): header first, cookie second.
export function accessToken(request) {
  const h = request.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h;
  const cookie = request.headers.get("cookie") || "";
  return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1] || null;
}

// Who is behind a verified JWT: the email for a person, none for a service token. Only
// valid after accessOk() said yes — this decodes without verifying.
export function accessEmail(request) {
  try {
    const p = JSON.parse(new TextDecoder().decode(b64u(accessToken(request).split(".")[1])));
    return typeof p.email === "string" && p.email.includes("@") ? p.email.toLowerCase() : null;
  } catch { return null; }
}

export async function accessOk(request, env) {
  const tok = accessToken(request);
  if (!tok || !env.ACCESS_TEAM_DOMAIN) return false;          // CHANGED (1)
  const [h, p, s] = tok.split(".");
  if (!s) return false;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64u(h)));
    payload = JSON.parse(new TextDecoder().decode(b64u(p)));
  } catch { return false; }
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || payload.exp * 1000 < Date.now()) return false;
  // Pin the application: a valid JWT for any other app on the same team must not pass.
  // CHANGED (3): no `env.ACCESS_AUD &&` escape hatch — unset or placeholder means denied.
  if (!env.ACCESS_AUD) return false;
  if (!(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).includes(env.ACCESS_AUD)) return false;
  if (Date.now() - certCache.at > 3600e3) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!r.ok) return false;
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
}
