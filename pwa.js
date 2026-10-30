'use strict';
(() => {
  const knownTrackingIds = new Set(['gclid', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'twclid']);
  const currentSearch = window.location.search;
  if (currentSearch) {
    let removedTrackingParameter = false;
    const remainingParameters = currentSearch.slice(1).split('&').filter(parameter => {
      const encodedName = parameter.split('=', 1)[0];
      let name;
      try { name = decodeURIComponent(encodedName.replace(/\+/g, ' ')).toLowerCase(); }
      catch { return true; }
      if (name.startsWith('utm_') || knownTrackingIds.has(name)) {
        removedTrackingParameter = true;
        return false;
      }
      return true;
    });
    if (removedTrackingParameter) {
      const hasRemainingValue = remainingParameters.some(parameter => parameter !== '');
      const search = hasRemainingValue ? '?' + remainingParameters.join('&') : '';
      window.history.replaceState(window.history.state, '', window.location.pathname + search + window.location.hash);
    }
  }

  const connectedMode = new URLSearchParams(location.search).get('mode') === 'connected';
  let storagePersistence = 'not-requested';

  const serviceWorkerReady = !('serviceWorker' in navigator) || !window.isSecureContext
    ? Promise.resolve(null)
    : navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
      .catch(() => null);

  async function requestPersistentStorage() {
    if (connectedMode || !navigator.storage || typeof navigator.storage.persist !== 'function') {
      storagePersistence = 'unsupported';
      return false;
    }
    try {
      if (typeof navigator.storage.persisted === 'function' && await navigator.storage.persisted()) {
        storagePersistence = 'granted';
        return true;
      }
      const granted = await navigator.storage.persist();
      storagePersistence = granted ? 'granted' : 'not-granted';
      return granted;
    } catch {
      storagePersistence = 'not-granted';
      return false;
    }
  }

  if (!connectedMode) {
    const app = document.getElementById('app');
    let requested = false;
    let observer = null;
    const requestAfterOwnerEntry = () => {
      if (requested || app?.classList.contains('hidden')) return;
      requested = true;
      void requestPersistentStorage();
      observer?.disconnect();
    };
    if (app) {
      observer = new MutationObserver(requestAfterOwnerEntry);
      observer.observe(app, { attributes: true, attributeFilter: ['class'] });
      requestAfterOwnerEntry();
    }
  }

  window.PosLocalPwa = Object.freeze({
    serviceWorkerReady,
    requestPersistentStorage,
    storagePersistence: () => storagePersistence
  });
})();
