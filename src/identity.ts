/**
 * Resolve which PDS hosts an account so login goes to the right server —
 * accounts on third-party PDSes (northsky.social, myatproto.social, self-
 * hosted) can't authenticate against bsky.social.
 *
 * Chain: handle → DID (public AppView) → DID document (plc.directory or
 * did:web well-known) → #atproto_pds service endpoint. Any failure falls
 * back to bsky.social, preserving the old behavior for Bluesky-hosted
 * accounts.
 */

// Env overrides exist for tests only; production uses the defaults.
const APPVIEW_URL = process.env.APPVIEW_URL ?? 'https://public.api.bsky.app';
const PLC_DIRECTORY_URL = process.env.PLC_DIRECTORY_URL ?? 'https://plc.directory';
const FALLBACK_PDS = 'https://bsky.social';
const RESOLVE_TIMEOUT_MS = 10_000;

interface DidService {
  id?: string;
  type?: string;
  serviceEndpoint?: unknown;
}

interface DidDocument {
  service?: DidService[];
}

async function fetchJson(url: string): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the PDS endpoint out of a DID document. Only https:// endpoints are
 * accepted — the document is user-controlled and we send credentials to the
 * returned URL.
 */
export function pickPdsEndpoint(doc: DidDocument): string | null {
  for (const svc of doc.service ?? []) {
    const idMatches = svc.id === '#atproto_pds' || (typeof svc.id === 'string' && svc.id.endsWith('#atproto_pds'));
    const typeMatches = svc.type === 'AtprotoPersonalDataServer';
    if (!idMatches && !typeMatches) continue;
    if (typeof svc.serviceEndpoint === 'string' && svc.serviceEndpoint.startsWith('https://')) {
      return svc.serviceEndpoint;
    }
  }
  return null;
}

export async function resolvePdsService(handle: string): Promise<string> {
  const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
  try {
    const resolved = await fetchJson(
      `${APPVIEW_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalized)}`,
    ) as { did?: string };
    const did = resolved.did;
    if (!did) throw new Error('no DID in resolveHandle response');

    let doc: DidDocument;
    if (did.startsWith('did:plc:')) {
      doc = await fetchJson(`${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`) as DidDocument;
    } else if (did.startsWith('did:web:')) {
      const domain = did.slice('did:web:'.length).split(':')[0];
      doc = await fetchJson(`https://${domain}/.well-known/did.json`) as DidDocument;
    } else {
      throw new Error(`unsupported DID method: ${did}`);
    }

    const endpoint = pickPdsEndpoint(doc);
    if (!endpoint) throw new Error('no https #atproto_pds service in DID document');
    return endpoint;
  } catch (err) {
    console.log(`[identity] falling back to bsky.social for ${normalized}: ${err instanceof Error ? err.message : String(err)}`);
    return FALLBACK_PDS;
  }
}
