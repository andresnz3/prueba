(() => {
  const currentSearch = window.location.search;
  if (!currentSearch) return;

  let removedUtmParameter = false;
  const remainingParameters = currentSearch.slice(1).split('&').filter(parameter => {
    const encodedName = parameter.split('=', 1)[0];
    let name;

    try {
      name = decodeURIComponent(encodedName.replace(/\+/g, ' ')).toLowerCase();
    } catch {
      return true;
    }

    if (name.startsWith('utm_')) {
      removedUtmParameter = true;
      return false;
    }
    return true;
  });

  if (!removedUtmParameter) return;

  const hasRemainingValue = remainingParameters.some(parameter => parameter !== '');
  const search = hasRemainingValue ? '?' + remainingParameters.join('&') : '';
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + search + window.location.hash
  );
})();
