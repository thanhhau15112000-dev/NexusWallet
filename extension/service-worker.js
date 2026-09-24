const ORIGIN_KEY = 'dashboardOrigin';

function normaliseOrigin(value) {
  try {
    const url = new URL(value);
    const isLocalHttp =
      url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase());
    if (
      (url.protocol !== 'https:' && !isLocalHttp) ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'CHECK_BACKEND') return false;

  void (async () => {
    try {
      const { [ORIGIN_KEY]: savedOrigin } = await chrome.storage.local.get(ORIGIN_KEY);
      const origin = normaliseOrigin(savedOrigin ?? '');
      if (!origin) {
        sendResponse({ ok: false, code: 'not_configured', message: 'Configure the dashboard URL first.' });
        return;
      }

      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      if (!granted) {
        sendResponse({ ok: false, code: 'permission_missing', message: 'Grant access to this dashboard host in settings.' });
        return;
      }

      const response = await fetch(new URL('/api/health', origin), {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}.`);
      const health = await response.json();
      if (health?.ok !== true || health?.cluster !== 'devnet') {
        sendResponse({ ok: false, code: 'wrong_cluster', message: 'Backend did not confirm Solana Devnet.' });
        return;
      }
      sendResponse({
        ok: true,
        origin,
        cluster: health.cluster,
        agentId: health.agentId,
        authRequired: health.authRequired === true,
      });
    } catch (error) {
      sendResponse({
        ok: false,
        code: 'backend_unavailable',
        message: error instanceof Error ? error.message : 'Could not reach the backend.',
      });
    }
  })();

  return true;
});
