'use strict';
// The Docker frontend and API share one public origin; Nginx proxies /api internally.
window.POS_API_BASE_URL = new URL('/api', window.location.origin).href;
