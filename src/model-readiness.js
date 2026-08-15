const readinessCache = new WeakMap();
const CACHE_TTL_MS = 1_000;

function valueOf(response) {
  return response?.result?.ok ? response.result.value : undefined;
}

function atPath(value, path) {
  let current = value;
  for (const segment of path ?? []) current = current?.[segment];
  return current;
}

function cacheFor(api) {
  if (!api || typeof api !== 'object') return undefined;
  let cache = readinessCache.get(api);
  if (!cache) {
    cache = { expiresAt: 0, promise: undefined };
    readinessCache.set(api, cache);
  }
  return cache;
}

async function catalogFor(api) {
  const cache = cacheFor(api);
  if (!cache) return undefined;
  if (cache.promise && cache.expiresAt > Date.now()) return cache.promise;
  if (!api.llm?.providers || !api.settings?.describe || !api.credentials?.describe) return undefined;
  cache.promise = Promise.all([
    api.llm.providers({}),
    api.settings.describe({}),
  ]).then(([providersResponse, settingsResponse]) => {
    const providers = valueOf(providersResponse)?.providers;
    const namespaces = valueOf(settingsResponse)?.namespaces;
    if (!Array.isArray(providers) || !Array.isArray(namespaces)) return undefined;
    return { providers, namespaces };
  }).catch(() => undefined);
  cache.expiresAt = Date.now() + CACHE_TTL_MS;
  return cache.promise;
}

/**
 * Check only the credential contract that a native DSH provider explicitly
 * declares. Unknown or provider-native authentication remains fail-open.
 * The returned object never contains a credential value.
 */
export async function checkNativeModelRoute(api, selection) {
  const catalog = await catalogFor(api);
  if (!catalog) return { state: 'unknown' };
  const provider = catalog.providers.find((item) => item.provider === selection?.provider);
  if (!provider?.settingsNs) return { state: 'unknown' };
  const namespace = catalog.namespaces.find((item) => item.ns === provider.settingsNs);
  const profile = atPath(namespace?.value, provider.settingsPath);
  const ref = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.trim()
    ? profile.apiKeyEnv.trim()
    : undefined;
  if (!ref) return { state: 'unknown' };
  const response = await api.credentials.describe({ refs: [ref] }).catch(() => undefined);
  const info = valueOf(response)?.credentials?.[ref];
  if (!info) return { state: 'unknown', ref };
  return info.configured ? { state: 'ready', ref } : { state: 'missing', ref };
}
