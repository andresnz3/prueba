/* icons.js - Reemplaza emojis por iconos SVG (estilo Lucide) en toda la interfaz.
   Funciona también con el contenido que app.js genera dinámicamente. */
(function () {
  "use strict";

  const P = {
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
    box: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    cash: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
    chart: '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
    trend: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    printer: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    xcircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    card: '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>'
  };

  // emoji -> [icono, clase extra]
  const MAP = {
    "🛒": ["cart"], "📦": ["box"], "📥": ["inbox"], "💸": ["cash"], "💵": ["cash"],
    "👥": ["users"], "🏢": ["building"], "📊": ["chart"], "💰": ["wallet"], "🧾": ["receipt"],
    "📈": ["trend"], "🗑": ["trash"], "➕": ["plus"], "➖": ["minus"], "📷": ["camera"],
    "🖨": ["printer"], "📄": ["file"], "🔒": ["lock"], "🔍": ["search"], "⚠": ["alert"],
    "⭐": ["star"], "❌": ["xcircle", "ic-danger"], "✅": ["check", "ic-success"],
    "💳": ["card"], "⏳": ["clock"], "✏": ["pencil"], "🟢": ["dot", "ic-success"], "🔴": ["dot", "ic-danger"], "⚫": ["dot"],
    "🍪": ["box"], "🥤": ["box"], "💧": ["box"], "🍟": ["box"], "🍫": ["box"], "🧃": ["box"], "🍘": ["box"], "⚡": ["box"]
  };

  const RE = new RegExp("(" + Object.keys(MAP).join("|") + ")\uFE0F?", "g");
  const RE_STRIP = new RegExp("(" + Object.keys(MAP).join("|") + ")\uFE0F?\\s*", "g");

  function svg(key, extra) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "ic" + (extra ? " " + extra : ""));
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = P[key];
    return s;
  }

  function replaceInText(node) {
    const txt = node.nodeValue;
    RE.lastIndex = 0;
    if (!RE.test(txt)) return;
    RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = RE.exec(txt))) {
      if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
      const def = MAP[m[1]];
      frag.appendChild(svg(def[0], def[1]));
      last = m.index + m[0].length;
    }
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function scan() {
    observer.disconnect();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = n.parentNode && n.parentNode.nodeName;
        return (t === "SCRIPT" || t === "STYLE" || t === "TEXTAREA" || t === "OPTION") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(replaceInText);
    document.querySelectorAll("[placeholder]").forEach(el => {
      const p = el.getAttribute("placeholder");
      RE_STRIP.lastIndex = 0;
      if (RE_STRIP.test(p)) { RE_STRIP.lastIndex = 0; el.setAttribute("placeholder", p.replace(RE_STRIP, "").trim()); }
    });
    connect();
  }

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  });
  function connect() { observer.observe(document.body, { childList: true, subtree: true, characterData: true }); }

  // Estilos de los iconos
  const style = document.createElement("style");
  style.textContent =
    ".ic{width:1.15em;height:1.15em;vertical-align:-.2em;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}" +
    ".ic-success{color:var(--success,#16a34a)}.ic-danger{color:var(--danger,#dc2626)}" +
    ".topbar .nav-btn{display:flex;align-items:center;gap:10px}.topbar .nav-btn .ic{width:18px;height:18px;opacity:.9}" +
    ".empty-cart-icon .ic{width:2.4rem;height:2.4rem;stroke-width:1.5}" +
    ".product-card .ic{width:2.2rem;height:2.2rem;stroke-width:1.5;color:var(--text-muted,#64748b);display:block;margin:0 0 6px}" +
    ".history-table td .ic{width:1em;height:1em}" +
    ".seller-info span .ic{width:.7em;height:.7em}" +
    ".btn .ic{width:1.1em;height:1.1em}" +
    "#searchProductInput{padding-left:36px!important;background-repeat:no-repeat!important;background-position:12px center!important;background-size:16px!important;" +
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E\")!important}";
  document.head.appendChild(style);

  scan();
})();