import type { GatewayError } from "@moat-browser/types";

// Domain allowlist — empty means allow all
let allowedDomains: Set<string> | null = null;

export function configureAcl(domains: string[]): void {
  if (domains.length === 0) {
    allowedDomains = null; // Allow all
  } else {
    allowedDomains = new Set(domains.map((d) => d.toLowerCase()));
  }
}

export function checkUrl(url: string): GatewayError | null {
  if (!allowedDomains) return null; // No ACL configured

  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.toLowerCase();

    // Check exact match and parent domain match
    if (allowedDomains.has(domain)) return null;

    // Check wildcard: if "example.com" is allowed, "sub.example.com" is too
    for (const allowed of allowedDomains) {
      if (domain.endsWith(`.${allowed}`)) return null;
    }

    return { _tag: "DomainBlocked", url, domain };
  } catch {
    return { _tag: "DomainBlocked", url, domain: "invalid-url" };
  }
}

// Initialize from env
const envDomains = process.env["MOAT_ALLOWED_DOMAINS"];
if (envDomains) {
  configureAcl(envDomains.split(",").map((d) => d.trim()).filter(Boolean));
}
