/* global Dexie, Html5Qrcode, html2pdf, XLSX */
"use strict";

window.onerror = function(msg, url, lineNo) { console.error("Error detectado:", msg, "en línea:", lineNo); return false; };

const connectedMode = new URLSearchParams(location.search).get('mode') === 'connected';
let DEFAULT_BUSINESS_ID = '00000000-0000-0000-0000-000000000000';
function createPosDatabase(name) {
const db = new Dexie(name);
db.version(9).stores({
    products: 'id, barcode, name, category, business_id, deleted', 
    clients: 'id, name, phone, business_id', 
    suppliers: 'id, name, business_id', 
    sales: 'id, numero, fecha, business_id', 
    purchases: 'id, fecha, business_id', 
    sync_queue: '++id, action, table_name, status',
    cajaSessions: '++id, business_id, estado, fechaAperturaTS',
    gastos: '++id, business_id, fecha, categoria, sessionId',
    abonos: '++id, business_id, tipo, referenciaId, monto, fecha, fechaTS, usuario',
    inventory_movements: '++id, business_id, producto_id, fechaTS',
    audit_logs: '++id, business_id, fechaTS, usuario, modulo, accion'
});
db.version(10).stores({ saleOrders: "id, business_id, status, createdAt" });
return db;
}
let localDB = connectedMode ? null : createPosDatabase('POS_OfflineDB');

const USERS = [
    { username: "andres", password: "4321", role: "gestor" },
    { username: "gestor", password: "4321", role: "gestor" },
    { username: "sergio", password: "4321", role: "gestor" },
    { username: "sergio", password: "1234", role: "vendedor" },
    { username: "vendedor1", password: "1234", role: "vendedor" }
];

let products = [], clients = [], suppliers = [], purchasesHistory = [], salesHistory = [], cart = [];
let cajaActual = null, cajaHistorial = [], gastosHistory = [], abonosHistory = [], auditHistory = [];
let buyerType = "retail", paymentMethod = "cash", currentUser = null;
let unlockedModuleId = null;
let renderizandoCarrito = false;
let saleNumber = 1, totalTemporal = 0, descuentoPct = 0, descuentoMonto = 0, pendingAdminView = null, tempImageBase64 = null, tempConfigLogoBase64 = null;
let procesandoVenta = false;
let ticketEsVentaNueva = false;
let html5QrCode = null, isCameraActive = false;
let isProdCameraActive = false, prodHtml5QrCode = null;
const GASTOS_CATEGORIES = ["Servicios Básicos", "Renta / Alquiler", "Transporte", "Sueldos", "Mantenimiento", "Insumos de Limpieza", "Otro"];

let configStorageKey = connectedMode ? null : 'posSystemConfig';
const defaultSystemConfig = () => ({
    name: "POS DISTRIBUIDORA", ruc: "", address: "", phone: "", currency: "C$", header: "", footer: "¡Gracias por su compra!", tax: 0, minStock: 5, logo: null, salesFlow: "DIRECT"
});
function readSystemConfig(key) {
    const defaults = defaultSystemConfig();
    if (!key) return defaults;
    try {
        const raw = localStorage.getItem(key);
        const saved = raw ? JSON.parse(raw) : null;
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaults;
        const config = { ...defaults, ...saved };
        const currency = typeof saved.currency === "string" ? saved.currency.trim() : "";
        config.currency = currency && !["undefined", "null"].includes(currency.toLowerCase()) ? currency : defaults.currency;
        // Complete older partial preferences without removing existing business fields.
        try { if (JSON.stringify(config) !== JSON.stringify(saved)) localStorage.setItem(key, JSON.stringify(config)); }
        catch { /* Keep repaired preferences in memory if storage is unavailable. */ }
        return config;
    } catch { return defaults; }
}
let sysConfig = readSystemConfig(configStorageKey);

let reporteDesdeTS = null, reporteHastaTS = null;

const loginScreen = document.getElementById("loginScreen"), app = document.getElementById("app"), barcodeInput = document.getElementById("barcodeInput"), searchProductInput = document.getElementById("searchProductInput"), cameraScannerContainer = document.getElementById("cameraScannerContainer");

function isAdmin(viewId) { if (connectedMode) return window.PosConnected?.canManageModule(viewId) || false; return !!currentUser && (currentUser.role === "gestor" || unlockedModuleId !== null); }

function puedeAccederAVista(viewId) {
    if (connectedMode) return window.PosConnected?.canView(viewId) || false;
    if (viewId === "salesView") return true;
    if (!currentUser) return false;
    if (currentUser.role === "gestor") return true;
    return viewId === unlockedModuleId;
}

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const PRODUCT_CODE_FIELDS = ['barcode', 'codigoBarras', 'code', 'codigo', 'sku', 'product_code', 'productCode', 'internalCode', 'internal_code'];
function normalizarBusquedaProducto(value) {
    return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('es');
}
function codigosDeProducto(product) {
    return PRODUCT_CODE_FIELDS.map(field => product?.[field]).filter(value => value !== undefined && value !== null && String(value).trim() !== '').map(String);
}
function productosConCodigoExacto(list, query) {
    const normalized = normalizarBusquedaProducto(query);
    if (!normalized) return [];
    const matches = list.filter(product => codigosDeProducto(product).some(code => normalizarBusquedaProducto(code) === normalized));
    return matches.filter((product, index) => matches.findIndex(candidate => String(candidate.id) === String(product.id)) === index);
}
function productoCoincideBusqueda(product, query, { category = false } = {}) {
    const normalized = normalizarBusquedaProducto(query);
    if (!normalized) return true;
    const textValues = [product?.name, ...(category ? [product?.category, product?.categoria] : [])];
    return textValues.some(value => normalizarBusquedaProducto(value).includes(normalized)) || codigosDeProducto(product).some(code => normalizarBusquedaProducto(code).includes(normalized));
}
function ordenarResultadosProducto(list, query) {
    const normalized = normalizarBusquedaProducto(query);
    if (!normalized) return list;
    return list.map((product, index) => ({ product, index })).sort((a, b) => {
        const rank = product => codigosDeProducto(product).some(code => normalizarBusquedaProducto(code) === normalized) ? 0 : normalizarBusquedaProducto(product.name) === normalized ? 1 : 2;
        return rank(a.product) - rank(b.product) || a.index - b.index;
    }).map(entry => entry.product);
}
window.PosProductSearch = Object.freeze({ normalize: normalizarBusquedaProducto, codes: codigosDeProducto, exactCodeMatches: productosConCodigoExacto, matches: productoCoincideBusqueda, prioritizeExact: ordenarResultadosProducto });

const LOGIN_FAILURE_KEY = "posLoginFailState";

function readLoginFailureState() {
    try {
        const raw = localStorage.getItem(LOGIN_FAILURE_KEY);
        if (!raw) return { count: 0, firstFailureTs: 0, lockedUntil: 0 };
        const parsed = JSON.parse(raw);
        return {
            count: Number(parsed.count) || 0,
            firstFailureTs: Number(parsed.firstFailureTs) || 0,
            lockedUntil: Number(parsed.lockedUntil) || 0
        };
    } catch (error) {
        console.warn("No se pudo leer estado de bloqueo de login:", error);
        return { count: 0, firstFailureTs: 0, lockedUntil: 0 };
    }
}

function saveLoginFailureState(state) {
    localStorage.setItem(LOGIN_FAILURE_KEY, JSON.stringify(state));
}

function clearLoginFailureState() {
    localStorage.removeItem(LOGIN_FAILURE_KEY);
}

function getLoginRemainingSeconds() {
    const state = readLoginFailureState();
    const now = Date.now();
    if (!state.lockedUntil || state.lockedUntil <= now) return 0;
    return Math.ceil((state.lockedUntil - now) / 1000);
}

function isLoginBlocked() {
    const state = readLoginFailureState();
    const now = Date.now();
    return Boolean(state.lockedUntil && state.lockedUntil > now);
}

const r2 = value => Math.round((Number(value) || 0) * 100) / 100;
const mediosPagoVenta = { cash: "Efectivo", card: "Tarjeta", transfer: "Transferencia", credit: "Crédito" };
function obtenerMedioPagoVenta(venta) { return venta.medioPago || ({ "Contado": "cash", "Tarjeta": "card", "Transferencia": "transfer", "Crédito": "credit" }[venta.metodo] || "cash"); }
const fechaLocalISO = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const esHoyTS = timestamp => new Date(timestamp).toLocaleDateString() === new Date().toLocaleDateString();
const MSG_SIN_CAJA = "Debes abrir caja antes de facturar o cobrar";
let ultimoEscaneo = 0, camaraVentasBusy = false, reporteHastaManual = false;

function blockPendingConnected() {
    if (!connectedMode) return false;
    showAlert('Operacion pendiente de integrar con MySQL. En modo conectado no se guardan ventas, compras, caja, cobros ni gastos en Dexie.');
    return true;
}
function stockReal(item) {
    const live = products.find(product => String(product.id) === String(item.id));
    return live ? (live.stock || 0) : 0;
}

function detenerCamaraVentas() {
    if (isCameraActive && html5QrCode) html5QrCode.stop().catch(() => {});
    cameraScannerContainer?.classList.add("hidden");
    isCameraActive = false;
}

function iconoAjuste() {
    return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>`;
}

// Cola local reservada para conectar con una futura capa backend; no realiza llamadas de red.
async function encolarSincronizacion(action, table_name, data) {
    if (connectedMode) return;
    try {
        await localDB.sync_queue.add({ action, table_name, data: JSON.stringify(data), status: 'pending' });
    } catch (e) { console.error("Error encolando sincronización:", e); }
}

async function initApp() {
    if (connectedMode) {
        products = []; clients = []; suppliers = []; salesHistory = []; purchasesHistory = [];
        abonosHistory = []; gastosHistory = []; auditHistory = []; cajaHistorial = []; cajaActual = null;
        return;
    }
    try {
        products = await localDB.products.toArray() || [];
        clients = await localDB.clients.toArray() || [];
        suppliers = await localDB.suppliers.toArray() || [];
        salesHistory = await localDB.sales.toArray() || [];
        purchasesHistory = await localDB.purchases.toArray() || [];
        abonosHistory = await localDB.abonos.toArray() || [];
        gastosHistory = await localDB.gastos.toArray() || [];
        auditHistory = await localDB.audit_logs.toArray() || [];
        for (const client of clients) {
            const deudaMigrada = client.deudaSinFactura === undefined;
            if (deudaMigrada) {
                client.deudaSinFactura = r2(Math.max(0, (Number(client.debt) || 0) - calcularSaldoFacturasCliente(client)));
            }
            const debt = calcularDeudaFacturasCliente(client);
            if (deudaMigrada || r2(client.debt || 0) !== debt) {
                client.debt = debt;
                await localDB.clients.put(client);
                await encolarSincronizacion("UPDATE", "clients", client);
            }
        }
        if(salesHistory.length > 0) saleNumber = Math.max(...salesHistory.map(s => s.numero || 0)) + 1;
        const saleNumberEl = document.getElementById("currentSaleNumber");
        if (saleNumberEl) saleNumberEl.textContent = String(saleNumber).padStart(6, "0");
        
        const brandName = document.getElementById("brandNameDisplay");
        if(brandName) brandName.textContent = sysConfig.name;

        await initCaja();
        actualizarCarrito();
    } catch (err) { console.error("Error cargando base de datos local:", err.message); }
}
const appInitialization = new Promise(resolve => {
    const initialize = () => { if (connectedMode) resolve(); else initApp().then(resolve); };
    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
});

async function registrarAuditoria(modulo, accion, detalleTexto) {
    if (connectedMode) return;
    const log = { business_id: DEFAULT_BUSINESS_ID, fecha: new Date().toLocaleString(), fechaTS: Date.now(), usuario: currentUser ? currentUser.displayName : 'Sistema', modulo: modulo, accion: accion, detalle: detalleTexto };
    auditHistory.push(log); await localDB.audit_logs.put(log); await encolarSincronizacion('INSERT', 'audit_logs', log); if (!document.getElementById("historyView")?.classList.contains("hidden")) actualizarTablaAuditoria();
}

const modalFocusReturn = new Map();

function modalFocusableElements(modal) {
    return [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
}

function topOpenModal() {
    return [...document.querySelectorAll(".modal:not(.hidden)")]
        .sort((a, b) => (parseInt(getComputedStyle(b).zIndex, 10) || 0) - (parseInt(getComputedStyle(a).zIndex, 10) || 0))[0] || null;
}

function focusModal(modal) {
    const focusTarget = modal.querySelector('[data-initial-focus]') || modalFocusableElements(modal)[0] || modal.querySelector(".modal-card, .ticket-modal");
    focusTarget?.focus();
}

document.querySelectorAll(".modal").forEach(modal => {
    const heading = modal.querySelector("h2");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    if (heading) {
        if (!heading.id) heading.id = `${modal.id}Title`;
        modal.setAttribute("aria-labelledby", heading.id);
    } else {
        modal.setAttribute("aria-label", "Comprobante");
    }
    modal.querySelector(".modal-card, .ticket-modal")?.setAttribute("tabindex", "-1");
});

const modalObserver = new MutationObserver(records => {
    records.forEach(record => {
        const modal = record.target;
        const wasOpen = !(record.oldValue || "").split(/\s+/).includes("hidden");
        const isOpen = !modal.classList.contains("hidden");

        if (!wasOpen && isOpen) {
            modalFocusReturn.set(modal, document.activeElement);
            setTimeout(() => {
                if (topOpenModal() === modal && !modal.contains(document.activeElement)) focusModal(modal);
            }, 0);
        } else if (wasOpen && !isOpen) {
            const returnTarget = modalFocusReturn.get(modal);
            modalFocusReturn.delete(modal);
            queueMicrotask(() => {
                const topModal = topOpenModal();
                if (topModal) {
                    if (!topModal.contains(document.activeElement)) focusModal(topModal);
                } else if (returnTarget?.isConnected && returnTarget.getClientRects().length > 0) {
                    returnTarget.focus();
                }
            });
        }
    });
});

document.querySelectorAll(".modal").forEach(modal => {
    modalObserver.observe(modal, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
});

document.addEventListener("keydown", event => {
    const modal = topOpenModal();
    if (!modal) return;

    if (event.key === "Escape") {
        event.preventDefault();
        const closeButton = modal.querySelector(".close-modal-btn, .modal-close, #newSaleBtn") ||
            [...modal.querySelectorAll("button")].find(button => button.textContent.trim().startsWith("Cancelar"));
        if (closeButton) closeButton.click();
        else modal.classList.add("hidden");
        return;
    }

    if (event.key !== "Tab") return;
    const focusable = modalFocusableElements(modal);
    if (!focusable.length) {
        event.preventDefault();
        modal.querySelector(".modal-card, .ticket-modal")?.focus();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
    }
});

function showAlert(mensaje) { const msgEl = document.getElementById("customAlertMessage"); const modalEl = document.getElementById("customAlertModal"); if(msgEl && modalEl) { msgEl.innerHTML = escapeHtml(mensaje).replace(/\n/g, "<br>"); modalEl.style.zIndex = "10100"; modalEl.classList.remove("hidden"); } else { alert(mensaje); } }
let confirmCallback = null;
function showConfirm(mensaje, callback) { const msgEl = document.getElementById("customConfirmMessage"); const modalEl = document.getElementById("customConfirmModal"); if(msgEl && modalEl) { msgEl.innerHTML = escapeHtml(mensaje).replace(/\n/g, "<br>"); confirmCallback = callback; modalEl.style.zIndex = "10100"; modalEl.classList.remove("hidden"); } else { if(confirm(mensaje)) callback(); } }
document.getElementById("customConfirmBtn")?.addEventListener("click", () => { document.getElementById("customConfirmModal")?.classList.add("hidden"); if(confirmCallback) confirmCallback(); });

document.querySelectorAll(".close-modal-btn").forEach(btn => { 
    btn.addEventListener("click", (e) => { 
        const modal = e.target.closest(".modal"); 
        if (!modal) return;
        const modalesLectura = ["customAlertModal", "customConfirmModal", "strictConfirmModal", "ticketModal", "statementModal", "kardexModal", "authModal", "supplierModal", "cierreCajaModal", "detalleCierreCajaModal"];
        if (modalesLectura.includes(modal.id)) {
            modal.classList.add("hidden");
            if (modal.id === "supplierModal") modal.style.zIndex = ""; 
            if (typeof window.detenerProdCamara === 'function') window.detenerProdCamara();
        } else {
            showConfirm("¿Estás seguro de cancelar? Se perderá la operación actual.", () => {
                modal.classList.add("hidden");
                if (typeof window.detenerProdCamara === 'function') window.detenerProdCamara();
                if (modal.id === "purchaseModal") currentPurchaseCart = [];
            });
        }
    }); 
});

let anularRegistroCallback = null;
function showAnularRegistro(titulo, descripcion, callback) {
    const tituloEl = document.getElementById("anularRegistroTitulo"); const descEl = document.getElementById("anularRegistroDescripcion");
    const motivoEl = document.getElementById("anularRegistroMotivo"); const modalEl = document.getElementById("anularRegistroModal");
    if (!modalEl) return;
    if (tituloEl) tituloEl.textContent = titulo; if (descEl) descEl.textContent = descripcion; if (motivoEl) motivoEl.value = "";
    anularRegistroCallback = callback; modalEl.classList.remove("hidden");
}
window.confirmarAnularRegistro = function() {
    const motivoEl = document.getElementById("anularRegistroMotivo"); const motivo = motivoEl ? motivoEl.value.trim() : "";
    if (!motivo) { showAlert("Debe indicar un motivo de anulación."); return; }
    document.getElementById("anularRegistroModal")?.classList.add("hidden");
    if (anularRegistroCallback) anularRegistroCallback(motivo);
};

document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await appInitialization;
    if (connectedMode) { await window.PosConnected.login(); return; }
    const uVal = document.getElementById("loginUsername").value.trim();
    const pVal = document.getElementById("loginPassword").value;
    const loginError = document.getElementById("loginError");
    const now = Date.now();

    if (isLoginBlocked()) {
        const remainingSeconds = getLoginRemainingSeconds();
        loginError?.classList.remove("hidden");
        loginError.textContent = `Demasiados intentos. Inténtalo nuevamente en ${remainingSeconds} segundos.`;
        return;
    }

    const user = USERS.find(candidate => candidate.username === uVal && candidate.password === pVal);

    if (user && uVal !== "") {
        clearLoginFailureState();
        loginError?.classList.add("hidden");
        currentUser = { ...user, displayName: user.username };
        loginScreen?.classList.add("hidden"); app?.classList.remove("hidden");
        if(document.getElementById("sellerName")) document.getElementById("sellerName").textContent = currentUser.username;
        if(document.getElementById("roleBadge")) document.getElementById("roleBadge").textContent = currentUser.role === "gestor" ? "Administrador" : "Usuario";
        unlockedModuleId = null; switchView("salesView"); actualizarCatalogo();
        registrarAuditoria('SESION', 'LOGIN', `Inicio de sesión (${currentUser.role})`);
    } else {
        let nextState = readLoginFailureState();
        if (!nextState.count || !nextState.firstFailureTs || (now - nextState.firstFailureTs) > 5 * 60 * 1000) {
            nextState = { count: 1, firstFailureTs: now, lockedUntil: 0 };
        } else {
            nextState.count += 1;
        }

        if (nextState.count >= 5) {
            nextState.lockedUntil = now + 120000;
        } else if (nextState.count >= 3) {
            nextState.lockedUntil = now + 30000;
        }

        saveLoginFailureState(nextState);
        loginError?.classList.remove("hidden");

        if (nextState.lockedUntil && nextState.lockedUntil > now) {
            const remainingSeconds = Math.ceil((nextState.lockedUntil - now) / 1000);
            loginError.textContent = `Demasiados intentos. Inténtalo nuevamente en ${remainingSeconds} segundos.`;
        } else {
            loginError.textContent = "Credenciales incorrectas";
        }
    }
});

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    if (connectedMode) { await window.PosConnected.logout(); return; }
    detenerCamaraVentas();
    if (currentUser) await registrarAuditoria('SESION', 'LOGOUT', `Cierre de sesión`);
    app?.classList.add("hidden"); loginScreen?.classList.remove("hidden"); document.getElementById("loginForm")?.reset(); cart = []; resetearDescuentoVenta(); actualizarCarrito(); unlockedModuleId = null; currentUser = null;
});

const NAV_MAP = { "navSalesBtn": "salesView", "navInventoryBtn": "inventoryView", "navPurchasesBtn": "purchasesView", "navPayablesBtn": "payablesView", "navClientsBtn": "clientsView", "navSuppliersBtn": "suppliersView", "navHistoryBtn": "historyView", "navCajaBtn": "cajaView", "navGastosBtn": "gastosView", "navReportesBtn": "reportesView", "navDashboardBtn": "dashboardView", "navConfigBtn": "configView" };

document.querySelectorAll("nav .nav-btn").forEach(btn => { 
    btn.addEventListener("click", (e) => { 
        const navBtn = e.target.closest('.nav-btn'); if (!navBtn) return; const targetView = NAV_MAP[navBtn.id]; if (!targetView) return;
        if (connectedMode) { window.PosConnected.navigate(targetView); return; }
        if(puedeAccederAVista(targetView)) { switchView(targetView); } else { pendingAdminView = targetView; document.getElementById("authModal")?.classList.remove("hidden"); setTimeout(() => { if (topOpenModal()?.id === "authModal") document.getElementById("gestorPassword")?.focus(); }, 100); }
    }); 
});

document.getElementById("authForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (connectedMode) { window.PosConnected.authorize(); return; }
    const gestorUser = USERS.find(u => u.role === "gestor");
    const enteredPass = document.getElementById("gestorPassword").value;
    if (gestorUser && enteredPass === gestorUser.password) {
        unlockedModuleId = pendingAdminView; document.getElementById("authModal")?.classList.add("hidden"); document.getElementById("gestorPassword").value = ""; document.getElementById("authError")?.classList.add("hidden");
        registrarAuditoria('SESION', 'DESBLOQUEO_GESTOR', `Desbloqueó acceso administrativo (vista: ${pendingAdminView || '-'})`);
        if (pendingAdminView) switchView(pendingAdminView);
    } else { document.getElementById("authError")?.classList.remove("hidden"); }
});

let salesFocusTimer = null;
function switchView(viewId) {
    if (connectedMode) return window.PosConnected.navigate(viewId);
    return renderPosView(viewId);
}
function renderPosView(viewId) {
    clearTimeout(salesFocusTimer);
    if (viewId !== "salesView") detenerCamaraVentas();
    if (viewId !== unlockedModuleId) unlockedModuleId = null;
    document.querySelectorAll(".view-panel").forEach(panel => panel.classList.add("hidden")); 
    document.querySelectorAll("nav .nav-btn").forEach(btn => btn.classList.remove("active"));
    const targetElement = document.getElementById(viewId); if(targetElement) targetElement.classList.remove("hidden");
    const activeBtnId = Object.keys(NAV_MAP).find(k => NAV_MAP[k] === viewId);
    if (activeBtnId && document.getElementById(activeBtnId)) document.getElementById(activeBtnId).classList.add("active");

    if(viewId === "salesView") salesFocusTimer = setTimeout(() => {
        const activeElement = document.activeElement;
        const editingField = activeElement?.matches('input, textarea, select') || activeElement?.isContentEditable;
        if (!app?.classList.contains("hidden") && !targetElement?.classList.contains("hidden") && !topOpenModal() && !editingField) barcodeInput?.focus();
    }, 100);
    if(viewId === "inventoryView") actualizarTablaInventario();
    if(viewId === "purchasesView") actualizarTablaCompras();
    if(viewId === "payablesView") actualizarTablaCuentasPorPagar();
    if(viewId === "clientsView") actualizarTablaClientes();
    if(viewId === "suppliersView") actualizarTablaProveedores();
    if(viewId === "historyView") { actualizarTablaHistorial(); actualizarTablaAuditoria(); }
    if(viewId === "cajaView") { renderCajaView(); if (!connectedMode) window.PosLocalFlow?.load().catch(error => showAlert(error.message)); }
    if(viewId === "gastosView") renderGastosView();
    if(viewId === "reportesView") { initReportesFiltros(); renderReportes(); }
    if(viewId === "dashboardView") renderDashboard();
    if(viewId === "configView") cargarVistaConfiguracion();
}

document.getElementById("confLogoInput")?.addEventListener("change", function(e) { const file = e.target.files[0]; if(file) { const reader = new FileReader(); reader.onload = function(evt) { tempConfigLogoBase64 = evt.target.result; const prev = document.getElementById("confLogoPreview"); if(prev) { prev.src = tempConfigLogoBase64; prev.style.display = "block"; } }; reader.readAsDataURL(file); } });
document.getElementById("prodImageInput")?.addEventListener("change", function(e) {
    const file = e.target.files[0];
    if (connectedMode) { window.PosInventory.selectImage(file); return; }
    if(file) {
        const reader = new FileReader();
        reader.onload = function(evt) {
            tempImageBase64 = evt.target.result;
            const prev = document.getElementById("prodImagePreview");
            if(prev) { prev.src = tempImageBase64; prev.style.display = "block"; }
        };
        reader.readAsDataURL(file);
    }
});

function cargarVistaConfiguracion() {
    document.getElementById("confName").value = sysConfig.name || ""; document.getElementById("confRuc").value = sysConfig.ruc || ""; document.getElementById("confAddress").value = sysConfig.address || ""; document.getElementById("confPhone").value = sysConfig.phone || ""; document.getElementById("confCurrency").value = sysConfig.currency || "C$"; document.getElementById("confHeader").value = sysConfig.header || ""; document.getElementById("confFooter").value = sysConfig.footer || ""; document.getElementById("confMinStock").value = sysConfig.minStock || 5;
    tempConfigLogoBase64 = sysConfig.logo || null; const logoPrev = document.getElementById("confLogoPreview"); if (logoPrev) { if (tempConfigLogoBase64) { logoPrev.src = tempConfigLogoBase64; logoPrev.style.display = "block"; } else { logoPrev.style.display = "none"; } }
}

window.guardarConfiguracion = function() {
    if (!isAdmin('configView')) { showAlert("No tiene permisos."); return; }
    const minStockInput = document.getElementById("confMinStock");
    if (!minStockInput.checkValidity()) { minStockInput.reportValidity(); return; }
    const prevConfig = JSON.stringify(sysConfig);
    sysConfig = { salesFlow: connectedMode ? sysConfig.salesFlow || "DIRECT" : window.PosLocalFlow.salesFlow(), name: document.getElementById("confName").value.trim() || "POS DISTRIBUIDORA", ruc: document.getElementById("confRuc").value.trim(), address: document.getElementById("confAddress").value.trim(), phone: document.getElementById("confPhone").value.trim(), currency: connectedMode ? "C$" : document.getElementById("confCurrency").value.trim() || "C$", header: document.getElementById("confHeader").value.trim(), footer: document.getElementById("confFooter").value.trim(), tax: 0, minStock: parseInt(minStockInput.value) || 5, logo: tempConfigLogoBase64 };
    localStorage.setItem(configStorageKey, JSON.stringify(sysConfig));
    if (prevConfig !== JSON.stringify(sysConfig)) registrarAuditoria('CONFIGURACION', 'ACTUALIZACION', 'Actualizó configuración del negocio');
    showAlert("Configuración guardada exitosamente.");
    const brandName = document.getElementById("brandNameDisplay"); if(brandName) brandName.textContent = sysConfig.name;
    actualizarCatalogo();
};

window.resetConfiguracion = function() {
    if (!isAdmin('configView')) { showAlert("No tiene permisos."); return; }
    showConfirm("⚠️ ¿Seguro que deseas restablecer la configuración?", () => {
        sysConfig = { salesFlow: connectedMode ? sysConfig.salesFlow || "DIRECT" : window.PosLocalFlow.salesFlow(), name: "POS DISTRIBUIDORA", ruc: "", address: "", phone: "", currency: "C$", header: "", footer: "¡Gracias por su compra!", tax: 0, minStock: 5, logo: null };
        localStorage.setItem(configStorageKey, JSON.stringify(sysConfig));
        cargarVistaConfiguracion();
        const brandName = document.getElementById("brandNameDisplay"); if(brandName) brandName.textContent = sysConfig.name;
        actualizarCatalogo(); showAlert("Configuración restablecida.");
    });
};

function obtenerCostoHistoricoItem(item) {
    if (item && item.cost !== undefined && item.cost !== null) return item.cost;
    const prod = products.find(p => String(p.id) === String(item.id) || p.name === item.name);
    return prod ? (prod.cost || 0) : 0;
}

function renderDashboard() {
    const hoyStr = new Date().toLocaleDateString(); const ahora = new Date(); const mesActual = ahora.getMonth(); const anoActual = ahora.getFullYear();
    const ventasValidas = salesHistory.filter(v => !v.anulada);
    const ventasHoy = ventasValidas.filter(v => new Date(v.fechaTS || v.id).toLocaleDateString() === hoyStr).reduce((sum, v) => sum + (v.total || 0), 0);
    const ventasMesValidas = ventasValidas.filter(v => { const d = new Date(v.fechaTS || v.id); return d.getMonth() === mesActual && d.getFullYear() === anoActual; });
    const ventasMes = ventasMesValidas.reduce((sum, v) => sum + (v.total || 0), 0);
    const totalVentasHistoricas = ventasValidas.reduce((sum, v) => sum + (v.total || 0), 0);
    
    let costoMercanciaTotal = 0; ventasValidas.forEach(v => { if (v.items) { v.items.forEach(i => { costoMercanciaTotal += obtenerCostoHistoricoItem(i) * (i.cantidad || 0); }); } });
    const gananciaBrutaTotal = totalVentasHistoricas - costoMercanciaTotal; const gastosTotales = gastosHistory.filter(g => !g.anulado).reduce((sum, g) => sum + (g.monto || 0), 0); const gananciaEstimadaTotal = gananciaBrutaTotal - gastosTotales;
    const prodsVendidosCount = ventasValidas.reduce((sum, v) => { return sum + (v.items ? v.items.reduce((s, i) => s + (i.cantidad || 0), 0) : 0); }, 0);
    
    const stockMinimoSys = sysConfig.minStock !== undefined ? sysConfig.minStock : 5;
    const bajoStockCount = products.filter(p => !p.deleted && p.active !== false && (p.stock || 0) <= (p.minStock !== undefined ? p.minStock : stockMinimoSys)).length;
    
    const cxcTotal = clients.reduce((sum, c) => sum + (c.debt || 0), 0); const cxpTotal = suppliers.reduce((sum, s) => sum + (s.debt || 0), 0);

    const setEl = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
    setEl("dashGananciaVentas", `${sysConfig.currency}${totalVentasHistoricas.toFixed(2)}`); setEl("dashGananciaCosto", `${sysConfig.currency}${costoMercanciaTotal.toFixed(2)}`); setEl("dashGananciaBruta", `${sysConfig.currency}${gananciaBrutaTotal.toFixed(2)}`); setEl("dashGananciaGastos", `${sysConfig.currency}${gastosTotales.toFixed(2)}`); setEl("dashGananciaEstimada", `${sysConfig.currency}${gananciaEstimadaTotal.toFixed(2)}`);
    setEl("dashVentasHoy", `${sysConfig.currency}${ventasHoy.toFixed(2)}`); setEl("dashVentasMes", `${sysConfig.currency}${ventasMes.toFixed(2)}`); setEl("dashGanancia", `${sysConfig.currency}${gananciaEstimadaTotal.toFixed(2)}`); setEl("dashProdsVendidos", `${prodsVendidosCount} uds.`); setEl("dashBajoStock", `${bajoStockCount}`); setEl("dashCxC", `${sysConfig.currency}${cxcTotal.toFixed(2)}`); setEl("dashCxP", `${sysConfig.currency}${cxpTotal.toFixed(2)}`); setEl("dashGastos", `${sysConfig.currency}${gastosTotales.toFixed(2)}`);

    const porVendedor = {}; ventasValidas.forEach(v => { const vend = v.vendedor || 'Desconocido'; if(!porVendedor[vend]) porVendedor[vend] = { ventas: 0, total: 0 }; porVendedor[vend].ventas++; porVendedor[vend].total += (v.total || 0); });
    const vendBody = document.getElementById("dashVendedoresBody");
    if(vendBody) {
        const sortedVend = Object.entries(porVendedor).sort((a,b) => b[1].total - a[1].total);
        if(sortedVend.length === 0) { vendBody.innerHTML = `<tr><td colspan="3" class="text-center">Sin registros.</td></tr>`; } else { vendBody.innerHTML = sortedVend.map(([nombre, d]) => `<tr><td><strong>${escapeHtml(nombre)}</strong></td><td>${d.ventas}</td><td style="font-weight:bold; color:#16a34a;">${sysConfig.currency}${d.total.toFixed(2)}</td></tr>`).join(""); }
    }
}

document.getElementsByName("buyerType").forEach(radio => { radio.addEventListener("change", (e) => { buyerType = e.target.value; const applied = document.getElementById("appliedRate"); if(applied) applied.textContent = buyerType === "retail" ? "Menudeo" : "Mayoreo"; actualizarCarrito(); actualizarCatalogo(); }); });
function refrescarSelectClientesCredito(seleccionarId) {
    if (connectedMode) { window.PosClients?.refreshCreditClients(seleccionarId || ""); return; }
    const sel = document.getElementById("creditClientSelect");
    if (!sel) return;
    const actual = seleccionarId !== undefined ? seleccionarId : sel.value;
    sel.innerHTML = clients.filter(c => c.active !== false).map(c =>
        `<option value="${c.id}">${escapeHtml(c.name)} (Disp: ${sysConfig.currency}${((c.creditLimit || 0) - (c.debt || 0)).toFixed(2)})</option>`
    ).join("");
    if (actual) sel.value = String(actual);
}

document.getElementsByName("paymentMethod").forEach(radio => { radio.addEventListener("change", (e) => { paymentMethod = e.target.value; const clientBox = document.getElementById("creditClientContainer"); if(paymentMethod === "credit") { clientBox?.classList.remove("hidden"); refrescarSelectClientesCredito(); } else { clientBox?.classList.add("hidden"); } }); });

function obtenerDescuentoPctActual() {
    const applies = document.querySelector('input[name="descApplies"][value="si"]')?.checked;
    const input = document.getElementById("descuentoPct");

    if (!applies) {
        descuentoPct = 0;
        if (input && input.value) input.value = "";
        return 0;
    }

    const value = parseFloat(input?.value ?? "");
    descuentoPct = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
    return descuentoPct;
}

document.getElementsByName("descApplies").forEach(radio => radio.addEventListener("change", e => {
    const applies = e.target.value === "si";
    document.getElementById("descuentoBox")?.classList.toggle("hidden", !applies);
    if (!applies) {
        descuentoPct = 0;
        const input = document.getElementById("descuentoPct");
        if (input) input.value = "";
    }
    actualizarCarrito();
}));
document.getElementById("descuentoPct")?.addEventListener("input", () => {
    obtenerDescuentoPctActual();
    actualizarCarrito();
});

function resetearDescuentoVenta() {
    descuentoPct = 0;
    descuentoMonto = 0;
    const input = document.getElementById("descuentoPct");
    if (input) input.value = "";
    const noDiscount = document.querySelector('input[name="descApplies"][value="no"]');
    if (noDiscount) noDiscount.checked = true;
    document.getElementById("descuentoBox")?.classList.add("hidden");
}
document.getElementById("purchType")?.addEventListener("change", (e) => { const pdc = document.getElementById("purchDaysContainer"); if (pdc) pdc.style.display = e.target.value === "credito" ? "block" : "none"; });

barcodeInput?.addEventListener("keypress", (e) => { if (e.key === "Enter") { e.preventDefault(); procesarCodigoBarras(barcodeInput.value); } });
document.getElementById("addBarcodeBtn")?.addEventListener("click", () => { procesarCodigoBarras(barcodeInput.value); });

let scannerBuffer = "", scannerTimeout;
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === 'INPUT' && e.target.id !== 'barcodeInput') return;
    if (e.key === "Enter") {
        const codigo = e.target?.id === "barcodeInput" ? e.target.value : scannerBuffer;
        if ((codigo || "").trim().length > 2) { e.preventDefault(); procesarCodigoBarras(codigo); scannerBuffer = ""; }
    } else if (e.key.length === 1) {
        scannerBuffer += e.key; clearTimeout(scannerTimeout);
        scannerTimeout = setTimeout(() => { scannerBuffer = ""; }, 200);
    }
});

searchProductInput?.addEventListener("input", actualizarCatalogo);
searchProductInput?.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    const matches = window.PosProductSearch.exactCodeMatches(products.filter(product => !product.deleted), searchProductInput.value);
    if (!matches.length) return;
    event.preventDefault();
    procesarCodigoBarras(searchProductInput.value);
    searchProductInput.value = "";
    actualizarCatalogo();
});
document.getElementById("inventorySearchInput")?.addEventListener("input", actualizarTablaInventario);
document.getElementById("toggleCameraBtn")?.addEventListener("click", async () => {
    if (camaraVentasBusy) return;
    camaraVentasBusy = true;
    try {
        if (isCameraActive) { detenerCamaraVentas(); return; }
        cameraScannerContainer?.classList.remove("hidden");
        html5QrCode = new Html5Qrcode("interactiveReader");
        await html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, texto => {
            if (Date.now() - ultimoEscaneo < 1500) return;
            ultimoEscaneo = Date.now();
            procesarCodigoBarras(texto);
        });
        isCameraActive = true;
    } catch {
        cameraScannerContainer?.classList.add("hidden"); isCameraActive = false;
        showAlert("No se pudo iniciar la cámara.");
    } finally { camaraVentasBusy = false; }
});

function procesarCodigoBarras(codigo) {
    codigo = String(codigo ?? "").trim();
    if (!codigo) return;
    const coincidencias = window.PosProductSearch.exactCodeMatches(products, codigo).filter(p => !p.deleted);
    if (connectedMode) {
        const producto = coincidencias.length === 1 ? coincidencias[0] : null;
        if (coincidencias.length > 1) showAlert("Hay varios productos con ese código. Revisa el inventario antes de agregarlo.");
        else if (!producto) showAlert("Producto no encontrado en el inventario conectado.");
        else if (producto.active === false) showAlert("El producto est\u00e1 inactivo y no se puede agregar al carrito.");
        else agregarAlCarrito(producto);
    } else {
        const activos = coincidencias.filter(p => p.active !== false);
        if (activos.length > 1) showAlert("Hay varios productos con ese código. Revisa el inventario antes de agregarlo.");
        else if (activos.length === 1) agregarAlCarrito(activos[0]);
        else showAlert("Producto no encontrado o inactivo.");
    }
    if (barcodeInput) barcodeInput.value = "";
}

function actualizarCatalogo() {
    const searchTerm = searchProductInput ? searchProductInput.value : "";
    const list = ordenarResultadosProducto(products.filter(p => !p.deleted && p.active !== false && productoCoincideBusqueda(p, searchTerm)), searchTerm);
    const pCount = document.getElementById("productCount"); if(pCount) pCount.textContent = list.length;
    const pGrid = document.getElementById("productGrid");
    if(pGrid) {
        pGrid.innerHTML = list.map(p => { 
            const retail = p.retailPrice || p.retail || 0; const wholesale = p.wholesalePrice || p.wholesale || 0; const precio = buyerType === "retail" ? retail : wholesale; 
            const iconOrImage = p.image ? `<img src="${escapeHtml(p.image)}" style="width:100%; height:80px; object-fit:cover; border-radius:4px; margin-bottom:5px;">` : `<div style="text-align:center; padding:15px;">${iconoProducto("width:2.2rem;height:2.2rem;stroke-width:1.5;")}</div>`;
            const minStock = p.minStock !== undefined ? p.minStock : (sysConfig.minStock || 5); const stockColor = p.stock <= minStock ? "color: red;" : "color: #666;";
            return `<div class="product-card" onclick="window.agregarAlCarritoPorId('${p.id}')">${iconOrImage}<strong>${escapeHtml(p.name)}</strong><br><small style="color:#666;">Cód: ${escapeHtml(codigosDeProducto(p)[0] || '')}</small><br><div style="font-size:.85rem; font-weight:600; ${stockColor}">Stock: ${p.stock||0}</div><br><span style="color: #28a745; font-weight: bold;">${sysConfig.currency}${precio.toFixed(2)}</span></div>`;
        }).join("");
    }
}

function iconoProducto(style) {
    return `<svg class="ic" style="${style}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;
}

window.agregarAlCarritoPorId = function(id) { const prod = products.find(p => String(p.id) === String(id)); if(prod) agregarAlCarrito(prod); };
function agregarAlCarrito(producto) { const existe = cart.find(item => String(item.id) === String(producto.id)); if ((existe ? existe.cantidad : 0) + 1 > producto.stock) { showAlert(`❌ ¡STOCK INSUFICIENTE!\nSolo te quedan ${producto.stock} unidades de ${producto.name}.`); return; } if (existe) { existe.cantidad += 1; } else { cart.push({ ...producto, cantidad: 1 }); } actualizarCarrito(); }

window.cambiarCantidadManual = function(index, valorStr) {
    const item = cart[index]; if (!item) return;
    let nuevaCant = connectedMode ? Number(valorStr) : parseInt(valorStr);
    if (connectedMode && (!/^\d+(?:\.\d{1,3})?$/.test(valorStr) || nuevaCant <= 0)) { showAlert("Ingresa una cantidad mayor que cero, con hasta tres decimales."); actualizarCarrito(); return; }
    if (isNaN(nuevaCant) || nuevaCant <= 0) nuevaCant = 1;
    const disp = stockReal(item);
    if (nuevaCant > disp) { showAlert(`❌ ¡STOCK INSUFICIENTE!\nSolo quedan ${disp} unidades de ${item.name}.`); actualizarCarrito(); return; }
    item.cantidad = nuevaCant; actualizarCarrito();
};
window.cambiarCantidad = function(index, delta) {
    const item = cart[index]; if (!item) return;
    const nuevaCant = item.cantidad + delta;
    if (nuevaCant <= 0) { window.eliminarDelCarrito(index); return; }
    const disp = stockReal(item);
    if (nuevaCant > disp) { showAlert(`❌ ¡STOCK INSUFICIENTE!\nSolo quedan ${disp} unidades de ${item.name}.`); return; }
    item.cantidad = nuevaCant; actualizarCarrito();
};
window.eliminarDelCarrito = function(index) { cart.splice(index, 1); actualizarCarrito(); };
document.getElementById("clearCartBtn")?.addEventListener("click", () => { 
    if (cart.length === 0) return;
    showConfirm("¿Desea cancelar esta venta y vaciar el carrito?", () => { cart = []; resetearDescuentoVenta(); actualizarCarrito(); });
});

function actualizarCarrito() { 
    if (renderizandoCarrito) return;
    renderizandoCarrito = true;
    try {
    let subtotalSinImpuesto = 0; let total = 0; const cartItemsDiv = document.getElementById("cartItems"); 
    if (cart.length === 0) { if(cartItemsDiv) cartItemsDiv.innerHTML = `<div class="text-center" style="padding:20px; color:#999;">Carrito vacío</div>`; } else { 
        if(cartItemsDiv) cartItemsDiv.innerHTML = cart.map((item, index) => { const retail = item.retailPrice || item.retail || 0; const wholesale = item.wholesalePrice || item.wholesale || 0; const precio = buyerType === "retail" ? retail : wholesale; const itemTotal = r2(precio * item.cantidad); const currentStock = stockReal(item); subtotalSinImpuesto = r2(subtotalSinImpuesto + itemTotal); total = r2(total + itemTotal); return `<div class="cart-item-row" style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:12px 0;"><div style="flex:1;"><strong>${escapeHtml(item.name)}</strong><br><small>${sysConfig.currency}${precio.toFixed(2)} c/u · Stock: ${currentStock}</small></div><div class="qty-control" style="display:flex; align-items:center; gap:8px;"><button class="qty-btn" onclick="window.cambiarCantidad(${index}, -1)">-</button><input type="number" value="${item.cantidad}" onchange="window.cambiarCantidadManual(${index}, this.value)" style="width: 45px; text-align: center;"><button class="qty-btn" onclick="window.cambiarCantidad(${index}, 1)">+</button></div><div style="text-align:right; margin-left:15px;"><strong>${sysConfig.currency}${itemTotal.toFixed(2)}</strong><br><button onclick="window.eliminarDelCarrito(${index})" style="background:transparent; color:#d32f2f; border:none; cursor:pointer; font-size:12px;">Quitar</button></div></div>`; }).join(""); 
    } 
    const descuentoPctActual = obtenerDescuentoPctActual();
    descuentoMonto = r2(subtotalSinImpuesto * descuentoPctActual / 100);
    total = r2(subtotalSinImpuesto - descuentoMonto);
    totalTemporal = total;
    document.getElementById("descuentoRow")?.classList.toggle("hidden", descuentoMonto <= 0);
    const descuentoEl = document.getElementById("descuentoMonto");
    if (descuentoEl) descuentoEl.textContent = `-${sysConfig.currency}${descuentoMonto.toFixed(2)}`;
    if(document.getElementById("subtotal")) document.getElementById("subtotal").textContent = `${sysConfig.currency}${subtotalSinImpuesto.toFixed(2)}`; 
    if(document.getElementById("total")) document.getElementById("total").textContent = `${sysConfig.currency}${total.toFixed(2)}`; 
    if(document.getElementById("cartItemCount")) document.getElementById("cartItemCount").textContent = `${cart.length} productos`; 
    } finally {
        renderizandoCarrito = false;
    }
}

async function registrarMovimientoKardex(productoId, tipoMovimiento, cantidadFisica, motivoRef) {
    if (blockPendingConnected()) return;
    const prodIndex = products.findIndex(p => String(p.id) === String(productoId)); if (prodIndex === -1) return false;
    const stockAnterior = products[prodIndex].stock || 0; const stockNuevo = stockAnterior + cantidadFisica;
    if (stockNuevo < 0) return false;
    const costoUnitarioActual = products[prodIndex].cost || 0;
    products[prodIndex].stock = stockNuevo; await localDB.products.put(products[prodIndex]); await encolarSincronizacion('UPDATE', 'products', products[prodIndex]);
    const movimiento = { id: Date.now() + Math.random(), business_id: DEFAULT_BUSINESS_ID, producto_id: products[prodIndex].id, tipo: tipoMovimiento, cantidad: cantidadFisica, costo_unitario: costoUnitarioActual, stock_nuevo: stockNuevo, fecha: new Date().toLocaleString(), fechaTS: Date.now(), motivo: motivoRef, usuario: currentUser ? currentUser.displayName : 'Sistema' };
    await localDB.inventory_movements.put(movimiento); await encolarSincronizacion('INSERT', 'inventory_movements', movimiento);
    return true;
}

document.getElementById("processSaleBtn")?.addEventListener("click", () => {
    if (connectedMode) { window.PosSales.checkout(); return; }
    if (procesandoVenta) return;
    if (cart.length === 0) {
        showAlert("El carrito está vacío. Agregue productos antes de cobrar.");
        return;
    }

    if (window.PosLocalFlow.isCentralized()) { window.PosLocalFlow.prepare(); return; }
    if (cajaActual?.estado !== "abierta") { showAlert(MSG_SIN_CAJA); return; }
    if (paymentMethod === "cash") {
        const cDisp = document.getElementById("cashTotalDisplay");
        if (cDisp) cDisp.textContent = `${sysConfig.currency}${totalTemporal.toFixed(2)}`;

        const cRec = document.getElementById("cashReceivedInput");
        if (cRec) cRec.value = "";

        document.getElementById("cashModal")?.classList.remove("hidden");
        setTimeout(() => document.getElementById("cashReceivedInput")?.focus(), 100);
    } else if (paymentMethod === "credit") {
        const clientSelectId = document.getElementById("creditClientSelect")?.value;
        const client = clients.find(c => String(c.id) === String(clientSelectId));

        if (!clientSelectId || !client) {
            showAlert("Debe seleccionar o crear un cliente para vender a crédito.");
            return;
        }

        if (((client.debt || 0) + totalTemporal) > (client.creditLimit || 0)) {
            showAlert(`Crédito Excedido.\nDisponible: ${sysConfig.currency}${((client.creditLimit || 0) - (client.debt || 0)).toFixed(2)}`);
            return;
        }

        procesandoVenta = true;
        registrarVenta(totalTemporal, totalTemporal, 0);
    } else {
        procesandoVenta = true;
        registrarVenta(totalTemporal, totalTemporal, 0);
    }
});

document.getElementById("confirmCashBtn")?.addEventListener("click", () => {
    if (blockPendingConnected()) return;
    if (procesandoVenta) return;
    if (cajaActual?.estado !== "abierta") { document.getElementById("cashModal")?.classList.add("hidden"); showAlert(MSG_SIN_CAJA); return; }
    const montoPagado = r2(parseFloat(document.getElementById("cashReceivedInput")?.value));
    if (montoPagado < totalTemporal) {
        document.getElementById("cashError")?.classList.remove("hidden");
        return;
    }

    document.getElementById("cashError")?.classList.add("hidden");
    document.getElementById("cashModal")?.classList.add("hidden");

    procesandoVenta = true;
    registrarVenta(totalTemporal, montoPagado, r2(montoPagado - totalTemporal));
});

async function registrarVenta(total, pago, vuelto) {
    if (blockPendingConnected()) return;
    try {
        if (cajaActual?.estado !== "abierta") { showAlert(MSG_SIN_CAJA); return; }
        const sale = await window.PosLocalFlow.record(window.PosLocalFlow.cartInput(), { paymentMethod, received: pago, expectedTotal: total });
        await initApp(); actualizarTablaInventario(); actualizarCatalogo(); renderDashboard(); renderCajaView();
        ticketEsVentaNueva = true;
        generarVisualizacionTicket(sale, pago, vuelto, false);
    } catch (error) { showAlert(error.message || "No se pudo completar la venta."); }
    finally { procesandoVenta = false; refrescarSelectClientesCredito(); }
}

window.reimprimirTicket = function(id) { ticketEsVentaNueva = false; const sale = salesHistory.find(s => String(s.id) === String(id)); if(!sale) return; generarVisualizacionTicket(sale, sale.total, 0, true); };

function generarVisualizacionTicket(sale, pago, vuelto, esCopia) {
    let prods; let subtotalTicket = 0;
    if (sale.items && sale.items.length > 0) { prods = sale.items.map(i => { const precio = sale.tarifa === "Menudeo" ? (i.retailPrice || i.retail || 0) : (i.wholesalePrice || i.wholesale || 0); const lineAmount = connectedMode && Number.isFinite(i.connectedSubtotal) ? i.connectedSubtotal : precio * i.cantidad; subtotalTicket += lineAmount; return `<div style="display:flex; justify-content:space-between; margin-bottom:5px; font-size:12px;"><span>${i.cantidad}x ${escapeHtml(i.name)}</span><span>${sysConfig.currency}${lineAmount.toFixed(2)}</span></div>`; }).join(""); } else { prods = `<div style="text-align:center; font-size:12px; color:#888;">(Detalle no disponible)</div>`; subtotalTicket = sale.total; }
    let saldoPendienteHtml = "";
    if (sale.metodo === "Crédito") {
        const c = clients.find(cl => String(cl.id) === String(sale.clienteId)) || clients.find(cl => cl.name === sale.cliente);
        const saldo = connectedMode && Number.isFinite(sale.saldoPendiente) ? sale.saldoPendiente : (c ? obtenerSaldoFactura("cliente", sale) : 0);
        if (c || connectedMode) saldoPendienteHtml = `<div style="display:flex; justify-content:space-between; font-weight:bold; margin-top:5px; border-top:1px dashed #000; padding-top:5px; color:#d32f2f;"><span>Saldo Pendiente:</span><span>${sysConfig.currency}${saldo.toFixed(2)}</span></div>`;
    }
    let pagoH;
    if (sale.metodo === "Contado") {
        const medio = obtenerMedioPagoVenta(sale);
        const recibido = medio === "cash" && !esCopia ? `<span>Recibido: ${sysConfig.currency}${(pago||0).toFixed(2)}</span>` : "";
        const cambio = medio === "cash" && !esCopia ? `<div style="display:flex; justify-content:space-between; font-weight:bold;"><span>CAMBIO:</span><span>${sysConfig.currency}${(vuelto||0).toFixed(2)}</span></div>` : "";
        pagoH = `<div style="display:flex; justify-content:space-between; margin-top:10px;"><span>Pago con ${mediosPagoVenta[medio] || "Efectivo"}</span>${recibido}</div>${cambio}`;
    } else if (sale.metodo === "Crédito") {
        pagoH = `<div style="border: 2px dashed #000; padding: 10px; margin-top:10px; background:#f9f9f9; font-size:12px;"><div style="text-align:center; font-weight:bold; margin-bottom:5px;">*** FACTURA DE CRÉDITO ***</div><div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>A nombre de:</span><span style="font-weight:bold; text-align:right;">${escapeHtml(sale.cliente)}</span></div>${sale.plazo && sale.plazo !== "-" ? `<div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Plazo a pagar:</span><span>${sale.plazo}</span></div>` : ''}<div style="display:flex; justify-content:space-between; font-weight:bold; border-top:1px solid #ccc; padding-top:2px;"><span>VENCE:</span><span style="color:#d32f2f;">${sale.vencimiento || '-'}</span></div>${saldoPendienteHtml}</div>`;
    } else {
        pagoH = `<div style="display:flex; justify-content:space-between; margin-top:10px;"><span>Pago con ${escapeHtml(sale.metodo)}</span><strong>${sysConfig.currency}${r2(sale.total).toFixed(2)}</strong></div>`;
    }
    const statusAnulada = sale.anulada ? `<div style="text-align:center; color:white; background:#d32f2f; font-weight:bold; padding:5px; margin-bottom:10px;">FACTURA ANULADA</div>` : ``;
    const confLogoImg = sysConfig.logo ? `<div style="text-align:center; margin-bottom: 5px;"><img src="${escapeHtml(sysConfig.logo)}" style="max-width: 120px; max-height: 80px; object-fit: contain;"></div>` : ''; const confH3 = `<h3 style="text-align:center; margin:0;">${escapeHtml(sysConfig.name)}</h3>`; const confRucInfo = sysConfig.ruc ? `<div style="text-align:center; font-size:12px;">RUC: ${escapeHtml(sysConfig.ruc)}</div>` : ''; const confAddressInfo = sysConfig.address ? `<div style="text-align:center; font-size:12px;">Dir: ${escapeHtml(sysConfig.address)}</div>` : ''; const confPhoneInfo = sysConfig.phone ? `<div style="text-align:center; font-size:12px;">Tel: ${escapeHtml(sysConfig.phone)}</div>` : ''; const confExtraHeader = sysConfig.header ? `<div style="text-align:center; font-size:12px; margin-bottom:5px;">${escapeHtml(sysConfig.header)}</div>` : ''; const confFooterFinal = sysConfig.footer ? `<div style="text-align: center; margin-top: 15px; font-size: 13px;">${escapeHtml(sysConfig.footer)}</div>` : `<div style="text-align: center; margin-top: 15px; font-size: 13px;">¡Gracias por su compra!</div>`;
    const subtotalFinal = Number.isFinite(Number(sale.subtotal)) ? Number(sale.subtotal) : subtotalTicket;
    const descuentoTicket = r2(sale.descuentoMonto || 0);
    const resumenDescuento = descuentoTicket > 0 ? `<div style="display:flex; justify-content:space-between; font-size:14px; margin-bottom:3px;"><span>Subtotal</span><span>${sysConfig.currency}${subtotalFinal.toFixed(2)}</span></div><div style="display:flex; justify-content:space-between; font-size:14px; margin-bottom:3px;"><span>Descuento${sale.descuentoPct ? ` (${sale.descuentoPct}%)` : ""}</span><span>-${sysConfig.currency}${descuentoTicket.toFixed(2)}</span></div>` : "";
    const tkCont = document.getElementById("ticketContent"); if(tkCont) { tkCont.innerHTML = `<div id="imprimibleTicket" style="font-family: monospace; background: #fff; border: 1px dashed #ccc; padding: 25px; width: 100%; max-width: 350px; margin: 0 auto;">${statusAnulada}${confLogoImg}${confH3}${confRucInfo}${confAddressInfo}${confPhoneInfo}${confExtraHeader}<div style="text-align:center; color:#555; font-size:12px; margin-bottom:10px;">${esCopia ? "COPIA DE FACTURA" : "COMPROBANTE DE VENTA"}</div><div style="border-top:1px dashed #000; margin:10px 0;"></div><div style="display:flex; justify-content:space-between; margin-bottom:3px; font-size:12px;"><span>Factura:</span><span>#${String(sale.numero).padStart(6, '0')}</span></div><div style="display:flex; justify-content:space-between; margin-bottom:3px; font-size:12px;"><span>Fecha/Hora:</span><span>${sale.fecha}</span></div><div style="display:flex; justify-content:space-between; margin-bottom:3px; font-size:12px;"><span>Cajero:</span><span>${escapeHtml(sale.vendedor)}</span></div><div style="border-top:1px dashed #000; margin:10px 0;"></div>${prods}<div style="border-top:1px dashed #000; margin:10px 0;"></div>${resumenDescuento}<div style="display:flex; justify-content:space-between; font-weight:bold; font-size:18px; margin-top:5px; border-top:1px solid #000; padding-top:5px;"><span>TOTAL</span><span>${sysConfig.currency}${(sale.total||0).toFixed(2)}</span></div>${pagoH}<div style="border-top:1px dashed #000; margin:10px 0;"></div>${confFooterFinal}${esCopia ? '<div style="text-align: center; color: #333; margin-top: 5px; font-size: 13px;">*** REIMPRESIÓN ***</div>' : ''}</div>`; }
    document.getElementById("ticketModal")?.classList.remove("hidden"); actualizarTablaClientes();
}

document.querySelectorAll("#closeTicketBtn, #newSaleBtn").forEach(b => {
    b.addEventListener("click", () => {
        document.getElementById("ticketModal")?.classList.add("hidden");
        if (!ticketEsVentaNueva) return;
        ticketEsVentaNueva = false;
        cart = [];
        resetearDescuentoVenta();
        saleNumber = Math.max(1, (salesHistory.length > 0 ? Math.max(...salesHistory.map(s => s.numero || 0)) : 0) + 1);
        const csn = document.getElementById("currentSaleNumber"); if (csn) csn.textContent = String(saleNumber).padStart(6, '0');
        const sdi = document.getElementById("saleDetailInput"); if (sdi) sdi.value = "";
        actualizarCarrito(); actualizarCatalogo();
        if (barcodeInput) barcodeInput.value = "";
        barcodeInput?.focus();
    });
});

document.getElementById("pdfTicketBtn")?.addEventListener("click", () => {
    const el = document.getElementById("imprimibleTicket");
    if (!el) return;
    if (typeof html2pdf === 'undefined') { showAlert("La librería PDF no está cargada."); return; }
    html2pdf().set({ filename: `ticket_${Date.now()}.pdf`, jsPDF: { unit: 'mm', format: [58, 200] } }).from(el).save();
});

window.abrirAnularVenta = function(id) { if (!isAdmin('historyView')) { showAlert("No tiene permisos para anular ventas."); return; } const s = salesHistory.find(x => String(x.id) === String(id)); if(!s) return; document.getElementById("anularVentaId").value = s.id; document.getElementById("anularVentaNumero").textContent = '#' + String(s.numero).padStart(6, '0'); document.getElementById("anularVentaMotivo").value = ""; document.getElementById("anularVentaModal").classList.remove("hidden"); };
window.confirmarAnularVenta = async function() {
    if (connectedMode) return window.PosSales.cancel();
    if (!isAdmin('historyView')) { showAlert("No tiene permisos para anular ventas."); return; }
    const id = document.getElementById("anularVentaId").value; const motivo = document.getElementById("anularVentaMotivo").value.trim(); const sale = salesHistory.find(x => String(x.id) === String(id)); if (!sale || sale.anulada) return;
    if ((calcFactura(sale.id)?.abonado || 0) > 0) { showAlert("Anule primero los abonos aplicados a esta factura antes de anular la venta."); return; }
    if (sale.estadoCaja === "confirmado" && ["card", "transfer"].includes(obtenerMedioPagoVenta(sale))) { showAlert("El pago ya fue confirmado. Se requiere registrar el reembolso externo antes de anular."); return; }
    sale.anulada = true; sale.motivoAnulacion = motivo; sale.fechaAnulacion = new Date().toLocaleString(); sale.usuarioAnulacion = currentUser.displayName;
    
    if (sale.items) { for (let item of sale.items) { let prod = products.find(p => String(p.id) === String(item.id)); if (!prod) prod = products.find(p => (p.name||"").toLowerCase() === (item.name||"").toLowerCase()); if (prod) { await registrarMovimientoKardex(prod.id, 'DEVOLUCION_VENTA', item.cantidad, `Anulación Venta #${sale.numero}: ${motivo}`); } } }
    if (sale.metodo === "Crédito") { let c = clients.find(cl => String(cl.id) === String(sale.clienteId)) || clients.find(cl => cl.name === sale.cliente); if (c) { c.debt = calcularDeudaFacturasCliente(c); await localDB.clients.put(c); await encolarSincronizacion('UPDATE', 'clients', c); } }
    
    for (const session of cajaHistorial) {
        let changed = false;
        for (const movement of session.movimientos || []) if (String(movement.saleId) === String(sale.id)) { movement.anulado = true; movement.estado = "void"; changed = true; }
        if (changed) await localDB.cajaSessions.put(session);
    }
    await localDB.sales.put(sale); await encolarSincronizacion('UPDATE', 'sales', sale); await registrarAuditoria('VENTAS', 'ANULACION', `Anuló Factura #${sale.numero} por C$${sale.total}. Motivo: ${motivo}`);
    document.getElementById("anularVentaModal").classList.add("hidden"); actualizarTablaHistorial(); actualizarTablaInventario(); actualizarCatalogo(); actualizarTablaClientes(); if (cajaActual) renderCajaView(); renderDashboard(); showAlert(`Venta #${sale.numero} anulada exitosamente.`);
};

function actualizarTablaHistorial() {
    const tbody = document.getElementById("historyTableBody"); if (!tbody) return; tbody.innerHTML = "";
    let tV = 0, cV = 0, cardV = 0, transferV = 0, crV = 0, tG = 0; const productSalesCounter = {};
    purchasesHistory.forEach(p => { if (!p.anulada) tG += p.total; });
    gastosHistory.forEach(g => { if (!g.anulado) tG += g.monto; });
    if (salesHistory.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center">No hay ventas registradas.</td></tr>`;
    } else {
        [...salesHistory].reverse().forEach(v => {
            if (!v.anulada) {
                if (esHoyTS(v.fechaTS || v.id)) tV += v.total;
                const medioVenta = obtenerMedioPagoVenta(v);
                if (medioVenta === "cash") cV += v.total;
                else if (medioVenta === "card") cardV += v.total;
                else if (medioVenta === "transfer") transferV += v.total;
                else if (v.metodo === "Crédito") crV += v.total;
                if (v.items) v.items.forEach(i => { productSalesCounter[i.name] = (productSalesCounter[i.name] || 0) + i.cantidad; });
            }
            const medioPago = mediosPagoVenta[obtenerMedioPagoVenta(v)] || "Efectivo";
            const estadoPago = v.anulada ? "ANULADA" : v.estadoCaja === "pendiente" ? "PENDIENTE DE CONFIRMACIÓN" : v.estadoCaja === "confirmado" ? "CONFIRMADO" : "";
            const pagoHtml = v.metodo === "Crédito" ? '<span style="color:#d32f2f; font-weight:bold;">CRÉDITO</span><br><small style="color:#666;">Vence: ' + escapeHtml(v.vencimiento) + " · " + (obtenerSaldoFactura("cliente", v) > 0 ? "Pendiente" : "Pagada") + '</small>' : v.conectado ? '<span style="color:' + (v.anulada ? "#777" : v.estadoCaja === "pendiente" ? "#b45309" : "#166534") + '; font-weight:bold;">' + escapeHtml(medioPago.toUpperCase()) + '</span><br><small>' + estadoPago + '</small>' : '<span style="color:#28a745; font-weight:bold;">' + escapeHtml(medioPago.toUpperCase()) + '</span>';
            const detalleFormat = v.anulada ? `<strong>${escapeHtml(v.detalle)}</strong><br><span style="color:#d32f2f; font-size:10px; font-weight:bold;">❌ ANULADA</span>` : `<strong>${escapeHtml(v.detalle)}</strong> (${escapeHtml(v.tarifa)})`;
            const totalFormat = v.anulada ? `<del>${sysConfig.currency}${r2(v.total).toFixed(2)}</del>` : `${sysConfig.currency}${r2(v.total).toFixed(2)}`;
            const actionBtns = v.anulada ? `<button class="btn btn-sm btn-secondary" onclick="window.reimprimirTicket('${v.id}')">Ver Factura</button>` : `<button class="btn btn-sm btn-secondary" onclick="window.reimprimirTicket('${v.id}')">Ver Factura</button> <button class="btn btn-sm btn-danger" onclick="window.abrirAnularVenta('${v.id}')">Anular</button>`;
            const tr = document.createElement("tr");
            if (v.anulada) tr.style.cssText = "background-color:#fdf5f5;color:#888;";
            tr.innerHTML = `<td>#${escapeHtml(v.numero)}</td><td>${escapeHtml(v.fecha)}</td><td>${escapeHtml(v.vendedor)}</td><td>${detalleFormat}</td><td>${pagoHtml}</td><td style="font-weight:bold;">${totalFormat}</td><td>${actionBtns}</td>`;
            tbody.appendChild(tr);
        });
    }
    const setTotal = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = `${sysConfig.currency}${r2(value).toFixed(2)}`; };
    setTotal("summaryTodaySales", tV); setTotal("summaryTotalSales", salesHistory.filter(sale => !sale.anulada).reduce((sum, sale) => sum + (Number(sale.total) || 0), 0)); setTotal("summaryCashSales", cV); setTotal("summaryCardSales", cardV); setTotal("summaryTransferSales", transferV); setTotal("summaryCreditSales", crV); setTotal("summaryTotalExpenses", tG);

    const minGlobal = sysConfig.minStock || 5;
    const bajos = products.filter(p => !p.deleted && p.active !== false && (p.stock || 0) <= (p.minStock ?? minGlobal));
    const lowEl = document.getElementById("lowStockList");
    if (lowEl) lowEl.innerHTML = bajos.length ? bajos.map(p => `<li>${escapeHtml(p.name)}: <strong>${p.stock || 0}</strong> uds.</li>`).join("") : `<li>Sin alertas.</li>`;
    const topEl = document.getElementById("topSellingList");
    if (topEl) {
        const top = Object.entries(productSalesCounter).sort((a, b) => b[1] - a[1]).slice(0, 5);
        topEl.innerHTML = top.length ? top.map(([name, count]) => `<li>${escapeHtml(name)}: <strong>${count}</strong> uds.</li>`).join("") : `<li>Sin datos.</li>`;
    }
}

function actualizarTablaAuditoria() { const tbody = document.getElementById("auditTableBody"); if(!tbody) return; if (auditHistory.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="text-center">Sin registros de auditoría.</td></tr>`; } else { tbody.innerHTML = [...auditHistory].reverse().map(a => `<tr><td>${a.fecha}</td><td><strong>${escapeHtml(a.usuario)}</strong></td><td>${escapeHtml(a.modulo)}</td><td>${escapeHtml(a.accion)}</td><td style="white-space: pre-line; font-size: 0.9em;">${escapeHtml(a.detalle)}</td></tr>`).join(""); } }

// CORRECCIÓN BUGS 2 Y 3: Discrepancia Margen vs Margin. Ahora mapea correctamente con tu HTML prodMargenRetail
document.getElementById("addNewProductBtn")?.addEventListener("click", () => { document.getElementById("productForm")?.reset(); tempImageBase64 = null; const imgPrevNew = document.getElementById("prodImagePreview"); if (imgPrevNew) { imgPrevNew.src = ""; imgPrevNew.style.display = "none"; } const pi = document.getElementById("prodId"); if(pi) pi.value = ""; document.getElementById("prodMinStock").value = sysConfig.minStock || "5"; document.getElementById("prodMargenRetail").value = "10"; document.getElementById("prodMargenWholesale").value = "10"; actualizarSelectProveedoresProducto(); const pstat = document.getElementById("prodStatus"); if(pstat) pstat.value = "true"; document.getElementById("productModal")?.classList.remove("hidden"); window.calcularPreciosPorMargen(); });
document.getElementById("quickAddProductFromPurchBtn")?.addEventListener("click", () => { document.getElementById("productForm")?.reset(); tempImageBase64 = null; const imgPrevNew = document.getElementById("prodImagePreview"); if (imgPrevNew) { imgPrevNew.src = ""; imgPrevNew.style.display = "none"; } const pi = document.getElementById("prodId"); if(pi) pi.value = ""; document.getElementById("prodMinStock").value = sysConfig.minStock || "5"; document.getElementById("prodMargenRetail").value = "10"; document.getElementById("prodMargenWholesale").value = "10"; actualizarSelectProveedoresProducto(); const pstat = document.getElementById("prodStatus"); if(pstat) pstat.value = "true"; document.getElementById("productModal")?.classList.remove("hidden"); window.calcularPreciosPorMargen(); });

function actualizarSelectProveedoresProducto() { const ps = document.getElementById("prodSupplier"); if(ps) { ps.innerHTML = `<option value="">-- Ninguno --</option>` + suppliers.filter(s => s.active !== false).map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join(""); } }

window.calcularPreciosPorMargen = function() {
    const cost = parseFloat(document.getElementById("prodCost")?.value) || 0;
    const mRet = parseFloat(document.getElementById("prodMargenRetail")?.value) || 0;
    const mWho = parseFloat(document.getElementById("prodMargenWholesale")?.value) || 0;
    const pRetEl = document.getElementById("prodRetail");
    const pWhoEl = document.getElementById("prodWholesale");
    if(pRetEl) pRetEl.value = (cost + (cost * (mRet / 100))).toFixed(2);
    if(pWhoEl) pWhoEl.value = (cost + (cost * (mWho / 100))).toFixed(2);
};
['prodCost', 'prodMargenRetail', 'prodMargenWholesale'].forEach(id => { document.getElementById(id)?.addEventListener('input', window.calcularPreciosPorMargen); });

// Sentido inverso: Precio -> Margen. margen = ((precio / costo) - 1) x 100.
// Solo escribe el campo de margen (por .value, sin disparar eventos), asi no hay bucles con costo/margen -> precio.
window.calcularMargenPorPrecio = function(tipo) {
    const ids = tipo === 'wholesale' ? { precio: 'prodWholesale', margen: 'prodMargenWholesale' } : { precio: 'prodRetail', margen: 'prodMargenRetail' };
    const cost = parseFloat(document.getElementById('prodCost')?.value);
    const precio = parseFloat(document.getElementById(ids.precio)?.value);
    const margenEl = document.getElementById(ids.margen);
    if (!margenEl || isNaN(precio) || isNaN(cost) || cost <= 0) return;
    margenEl.value = r2((precio / cost - 1) * 100).toFixed(2);
};
document.getElementById('prodRetail')?.addEventListener('input', () => window.calcularMargenPorPrecio('retail'));
document.getElementById('prodWholesale')?.addEventListener('input', () => window.calcularMargenPorPrecio('wholesale'));

document.getElementById("productForm")?.addEventListener("submit", async (e) => { 
    e.preventDefault();
    if (connectedMode) { await window.PosInventory.save(); return; }
    const barcode = document.getElementById("prodBarcode").value.trim(); if (!barcode) { showAlert("⚠️ El código de barras es obligatorio."); return; }
    const idVal = document.getElementById("prodId").value;
    const nombreVal = document.getElementById("prodName").value.trim(); if (!nombreVal) { showAlert("⚠️ El nombre del producto es obligatorio."); return; }
    
    const barcodeDuplicado = products.find(p => (p.barcode || "").trim() === barcode && String(p.id) !== String(idVal) && !p.deleted);
    if (barcodeDuplicado) { showAlert(`⚠️ El código de barras "${barcode}" ya está registrado.`); return; }
    
    const newStock = parseInt(document.getElementById("prodStock").value); const minStockVal = parseInt(document.getElementById("prodMinStock").value); const costVal = r2(parseFloat(document.getElementById("prodCost").value)); 
    const marginRetailVal = parseFloat(document.getElementById("prodMargenRetail").value) || 0; const marginWholesaleVal = parseFloat(document.getElementById("prodMargenWholesale").value) || 0;
    const retailVal = r2(parseFloat(document.getElementById("prodRetail").value)); const wholesaleVal = r2(parseFloat(document.getElementById("prodWholesale").value)); 
    const supplierVal = document.getElementById("prodSupplier")?.value || "";
    const isActive = document.getElementById("prodStatus").value === "true";
    
    if (isNaN(newStock) || isNaN(minStockVal) || newStock < 0 || minStockVal < 0) { showAlert("⚠️ El stock y el stock mínimo no pueden ser negativos."); return; }
    if (costVal < 0 || retailVal < 0 || wholesaleVal < 0) { showAlert("El costo y los precios no pueden ser negativos."); return; }

    const existente = idVal ? products.find(p => String(p.id) === String(idVal)) : null;
    const newProd = { id: existente ? existente.id : Date.now(), business_id: DEFAULT_BUSINESS_ID, barcode: barcode, name: nombreVal, category: document.getElementById("prodCategory").value, cost: costVal, marginRetail: marginRetailVal, marginWholesale: marginWholesaleVal, retailPrice: retailVal, wholesalePrice: wholesaleVal, stock: newStock, minStock: minStockVal, supplier: supplierVal, active: isActive, deleted: false, image: tempImageBase64 }; 
    
    if (idVal) { const oldIndex = products.findIndex(p => String(p.id) === String(idVal)); if (oldIndex > -1) { const oldProd = products[oldIndex]; if ((oldProd.stock||0) !== newStock) { const diff = newStock - (oldProd.stock||0); await registrarMovimientoKardex(oldProd.id, 'EDICION_MANUAL', diff, 'Ajuste desde edición'); } products[oldIndex] = newProd; await registrarAuditoria('INVENTARIO', 'EDITAR_PRODUCTO', `Editó el producto "${newProd.name}"`); } } else { const stockInicial = newProd.stock; newProd.stock = 0; products.push(newProd); await registrarMovimientoKardex(newProd.id, 'INICIAL', stockInicial, 'Creación de producto'); await registrarAuditoria('INVENTARIO', 'CREAR_PRODUCTO', `Creó el producto "${newProd.name}"`); } 
    
    await localDB.products.put(newProd); await encolarSincronizacion(idVal ? 'UPDATE' : 'INSERT', 'products', newProd); window.detenerProdCamara(); document.getElementById("productModal")?.classList.add("hidden"); 
    actualizarTablaInventario(); actualizarCatalogo(); renderDashboard();

    const purchModalRef = document.getElementById("purchaseModal"); const vieneDesdeCompras = purchModalRef && !purchModalRef.classList.contains("hidden");
    if (vieneDesdeCompras) { actualizarSugerenciasProductosCompra(); const pTemp = document.getElementById("purchProductTemp"); const cTemp = document.getElementById("purchCostTemp"); if (pTemp) { pTemp.value = newProd.name; pTemp.dataset.productId = String(newProd.id); } if (cTemp) cTemp.value = newProd.cost; pTemp?.focus(); }
    showAlert("Producto guardado exitosamente.");
});

function actualizarTablaInventario() { 
    const tb = document.getElementById("inventoryTableBody"); if(!tb) return; 
    const prodActivosReales = products.filter(p => !p.deleted);
    let bajoStock = 0; let agotados = 0;
    prodActivosReales.forEach(p => {
        if (p.active === false) return;
        const minStockLimit = p.minStock !== undefined ? p.minStock : (sysConfig.minStock || 5);
        if ((p.stock || 0) <= 0) agotados++;
        else if ((p.stock || 0) <= minStockLimit) bajoStock++;
    });
    const searchTerm = document.getElementById("inventorySearchInput")?.value || "";
    const visibleProducts = ordenarResultadosProducto(prodActivosReales.filter(p => productoCoincideBusqueda(p, searchTerm, { category: true })), searchTerm);
    tb.innerHTML = visibleProducts.length ? visibleProducts.map(p => {
        let rowStyle = ""; let stockHtml = p.stock || 0; const minStockLimit = p.minStock !== undefined ? p.minStock : (sysConfig.minStock || 5); const isActive = p.active !== false; let estadoHtml;
        if (!isActive) { rowStyle = "background-color: #f4f4f4; color: #888;"; estadoHtml = '<span style="color:#666; font-weight:bold;">Inactivo</span>'; } else if ((p.stock||0) <= 0) { rowStyle = "background-color: #ffebee;"; stockHtml = `<span style="color:#d32f2f; font-weight:bold;">${p.stock||0} (Agotado)</span>`; estadoHtml = 'Agotado'; } else if ((p.stock||0) <= minStockLimit) { stockHtml = `<span style="color:#ff9800; font-weight:bold;">${p.stock} (Bajo)</span>`; estadoHtml = 'Activo'; } else { estadoHtml = 'Activo'; }
        const retail = p.retailPrice || p.retail || 0; const wholesale = p.wholesalePrice || p.wholesale || 0;
        
        const btnKardex = `<button class="btn btn-sm" style="background:#0891b2; color:#fff; margin-right:4px;" onclick="window.verKardex('${p.id}')">Kardex</button>`;
        const btnEditar = `<button class="btn btn-sm" style="background:#2563eb; color:#fff; margin-right:4px;" onclick="window.editarProducto('${p.id}')">Editar</button>`;
        const btnEstado = `<button class="btn btn-sm" style="background:${isActive ? '#d97706' : '#16a34a'}; color:#fff; margin-right:4px;" onclick="window.toggleEstadoProducto('${p.id}')">${isActive ? 'Inactivar' : 'Activar'}</button>`;
        const btnEliminar = connectedMode ? "" : `<button class="btn btn-sm" style="background:#dc2626; color:#fff;" onclick="window.eliminarProductoLogico('${p.id}')">Eliminar</button>`;

        const btnAjuste = `<button class="btn btn-sm" style="background:#d97706; color:#fff; margin-right:4px;" onclick="window.abrirAjuste('${p.id}')">${iconoAjuste()} Ajuste</button>`;
        const fotoHtml = p.image ? `<img src="${escapeHtml(p.image)}" style="width:40px; height:40px; object-fit:cover; border-radius:4px;">` : iconoProducto("width:40px;height:40px;");
        return `<tr style="${rowStyle}"><td>${fotoHtml}</td><td>${escapeHtml(codigosDeProducto(p)[0] || '')}</td><td style="font-weight:bold;">${escapeHtml(p.name)}<br><small>${escapeHtml(p.category)}</small></td><td style="font-size: 1.1em;">${stockHtml}</td><td style="font-weight:bold; color:#0066cc;">${sysConfig.currency}${(p.cost || 0).toFixed(2)}</td><td>Men: ${sysConfig.currency}${retail.toFixed(2)}<br>May: ${sysConfig.currency}${wholesale.toFixed(2)}</td><td>${estadoHtml}</td><td><div style="display:flex; flex-wrap:wrap; gap:5px;">${btnKardex}${btnAjuste}${btnEditar}${btnEstado}${btnEliminar}</div></td></tr>`;
    }).join("") : '<tr><td colspan="8" class="text-center">No hay productos que coincidan con la búsqueda.</td></tr>';
    
    if(document.getElementById("invTotalProducts")) document.getElementById("invTotalProducts").textContent = products.filter(p => !p.deleted && p.active !== false).length; 
    if(document.getElementById("invLowStock")) document.getElementById("invLowStock").textContent = bajoStock; 
    if(document.getElementById("invOutOfStock")) document.getElementById("invOutOfStock").textContent = agotados;
}

window.editarProducto = function(id) {
    if (connectedMode) return window.PosInventory.edit(id);
    const p = products.find(x => String(x.id) === String(id)); if(!p) return;
    showProductEditor(p);
};
function showProductEditor(p) {
    document.getElementById("prodId").value = p.id; document.getElementById("prodBarcode").value = p.barcode || ""; document.getElementById("prodName").value = p.name || ""; document.getElementById("prodCategory").value = p.category || "Abarrotes"; document.getElementById("prodCost").value = p.cost || 0; document.getElementById("prodMargenRetail").value = p.marginRetail !== undefined ? p.marginRetail : 10; document.getElementById("prodMargenWholesale").value = p.marginWholesale !== undefined ? p.marginWholesale : 10; document.getElementById("prodRetail").value = p.retailPrice || p.retail || 0; document.getElementById("prodWholesale").value = p.wholesalePrice || p.wholesale || 0; document.getElementById("prodStock").value = p.stock || 0; document.getElementById("prodMinStock").value = p.minStock !== undefined ? p.minStock : (sysConfig.minStock || 5); document.getElementById("prodStatus").value = p.active !== false ? "true" : "false"; 
    actualizarSelectProveedoresProducto(); const pSupp = document.getElementById("prodSupplier"); if(pSupp) pSupp.value = p.supplier || "";
    tempImageBase64 = p.image || null;
    const imgPrev = document.getElementById("prodImagePreview");
    if (imgPrev) { if (tempImageBase64) { imgPrev.src = tempImageBase64; imgPrev.style.display = "block"; } else { imgPrev.src = ""; imgPrev.style.display = "none"; } }
    document.getElementById("productModal")?.classList.remove("hidden"); 
};

window.toggleEstadoProducto = async function(id) {
    if (connectedMode) return window.PosInventory.toggle(id);
    if (!isAdmin('inventoryView')) { showAlert("No tiene permisos."); return; }
    const p = products.find(x => String(x.id) === String(id)); if(!p) return;
    const nuevoEstado = p.active === false ? true : false;
    showConfirm(`¿Deseas ${nuevoEstado ? 'activar' : 'inactivar'} este producto?\n${nuevoEstado ? 'Estará disponible para ventas.' : 'No podrá venderse temporalmente.'}`, async () => {
        p.active = nuevoEstado; await localDB.products.put(p); await encolarSincronizacion('UPDATE', 'products', p);
        await registrarAuditoria('INVENTARIO', 'CAMBIO_ESTADO', `Cambió estado de "${p.name}" a ${nuevoEstado ? 'Activo' : 'Inactivo'}`);
        actualizarTablaInventario(); actualizarCatalogo(); showAlert(`Producto ${nuevoEstado ? 'activado' : 'inactivado'} correctamente.`);
    });
};

window.eliminarProductoLogico = function(id) {
    if (connectedMode) { showAlert("En modo conectado se inactivan productos y se conserva su historial. Utiliza Inactivar."); return; }
    if (!isAdmin('inventoryView')) { showAlert("No tiene permisos. Ingrese la contraseña de gestor."); return; }
    const p = products.find(x => String(x.id) === String(id));
    if (!p) return;
    const idStr = String(id);
    const barcode = (p.barcode || "").trim();
    const nombre = p.name;

    showConfirm("¿Seguro que deseas eliminar este producto y los registros con el mismo ID o código de barras? No afectará facturas ni compras pasadas.", async () => {
        try {
            const todos = await localDB.products.toArray();
            const afectados = todos.filter(x => !x.deleted && (
                String(x.id) === idStr || (barcode && (x.barcode || "").trim() === barcode)
            ));
            afectados.forEach(x => { x.deleted = true; x.active = false; });

            if (afectados.length) {
                await localDB.products.bulkPut(afectados);
                for (const producto of afectados) await encolarSincronizacion('UPDATE', 'products', producto);
            }

            const idsAfectados = new Set(afectados.map(producto => String(producto.id)));
            const codigosAfectados = new Set(afectados.map(producto => (producto.barcode || "").trim()).filter(Boolean));
            products = await localDB.products.toArray();
            cart = cart.filter(item => !idsAfectados.has(String(item.id)) && !codigosAfectados.has((item.barcode || "").trim()));

            if (afectados.length) {
                await registrarAuditoria('INVENTARIO', 'ELIMINAR_PRODUCTO', `Eliminó el producto "${nombre}" (${afectados.length} registro(s))`);
            }
            showAlert(afectados.length ? `Producto eliminado (${afectados.length} registro(s)).` : "No se encontraron registros activos para eliminar.");
        } catch (err) {
            console.error(err);
            showAlert(`No se pudo eliminar: ${err.message || err}`);
        } finally {
            actualizarTablaInventario();
            actualizarCatalogo();
            actualizarCarrito();
            renderDashboard();
        }
    });
};

// FUNCIONES DE CÁMARA (También estaban causando un posible cuelgue en la edición/cierre)
window.toggleProdCamera = function() {
    const container = document.getElementById("prodCameraScannerContainer");
    if (!container) return;
    if (isProdCameraActive) { window.detenerProdCamara(); return; }
    container.classList.remove("hidden");
    prodHtml5QrCode = new Html5Qrcode("prodInteractiveReader");
    prodHtml5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, decodedText => {
        document.getElementById("prodBarcode").value = (decodedText || "").trim();
        window.detenerProdCamara();
    }).then(() => { isProdCameraActive = true; })
      .catch(err => { console.log(err); isProdCameraActive = false; container.classList.add("hidden"); showAlert("Error al iniciar cámara."); });
};

window.detenerProdCamara = function() {
    const container = document.getElementById("prodCameraScannerContainer");
    if (isProdCameraActive && prodHtml5QrCode) {
        prodHtml5QrCode.stop().catch(() => {}).finally(() => { container?.classList.add("hidden"); isProdCameraActive = false; });
    } else { container?.classList.add("hidden"); }
};

window.verKardex = async function(id) {
    if (connectedMode) return window.PosInventory.kardex(id);
    const p = products.find(x => String(x.id) === String(id)); if(!p) return;
    document.getElementById("kardexModalTitle").textContent = `Kardex: ${p.name||""}`; document.getElementById("kardexModalSubtitle").textContent = `Código: ${p.barcode||""} | Stock Actual: ${p.stock||0}`;
    const movimientos = await localDB.inventory_movements.toArray(); const filtrados = movimientos.filter(m => String(m.producto_id) === String(p.id)).sort((a, b) => b.fechaTS - a.fechaTS);
    const tbody = document.getElementById("kardexTableBody");
    const thead = document.getElementById("kardexTableHead");
    if(thead) thead.innerHTML = `<tr><th>Fecha</th><th>Movimiento</th><th>Cant.</th><th>Costo Unit.</th><th>Stock Final</th><th>Motivo</th><th>Usuario</th></tr>`;
    
    if (filtrados.length === 0) { tbody.innerHTML = `<tr><td colspan="7" class="text-center">No hay movimientos en el Kardex.</td></tr>`; } else { 
        tbody.innerHTML = filtrados.map(m => { 
            const colorCant = m.cantidad > 0 ? '#28a745' : '#d32f2f'; const signo = m.cantidad > 0 ? '+' : ''; 
            return `<tr><td>${m.fecha}</td><td><strong>${m.tipo}</strong></td><td style="color:${colorCant}; font-weight:bold;">${signo}${m.cantidad}</td><td>${sysConfig.currency}${(m.costo_unitario||0).toFixed(2)}</td><td style="font-weight:bold;">${m.stock_nuevo}</td><td>${escapeHtml(m.motivo)}</td><td>${escapeHtml(m.usuario)}</td></tr>`; 
        }).join(""); 
    }
    document.getElementById("kardexModal").classList.remove("hidden");
};
window.abrirAjuste = function(id) { if (connectedMode) return window.PosInventory.openAdjustment(id); if (!isAdmin('inventoryView')) { showAlert("No tiene permisos para ajustar inventario."); return; } const p = products.find(x => String(x.id) === String(id)); if(!p) return; document.getElementById("ajusteProductoId").value = p.id; document.getElementById("ajusteProductoNombre").textContent = `${p.name||""} (Stock Actual: ${p.stock||0})`; document.getElementById("ajusteInventarioForm")?.reset(); document.getElementById("ajusteInventarioModal").classList.remove("hidden"); };
window.guardarAjusteInventario = async function() { if (connectedMode) return window.PosInventory.adjust(); if (!isAdmin('inventoryView')) { showAlert("No tiene permisos para ajustar inventario."); return; } const pId = document.getElementById("ajusteProductoId").value; const tipo = document.getElementById("ajusteTipo").value; const cantidad = parseInt(document.getElementById("ajusteCantidad").value); const motivo = document.getElementById("ajusteMotivo").value.trim(); if (isNaN(cantidad) || cantidad <= 0) { showAlert("Ingrese una cantidad válida, mayor que cero."); return; } if (!motivo) { showAlert("Debe indicar un motivo para el ajuste."); return; } const cantReal = tipo === "MERMA" ? -Math.abs(cantidad) : Math.abs(cantidad); const prod = products.find(p => String(p.id) === String(pId)); if (!prod) { showAlert("Producto no encontrado."); return; } if ((prod.stock || 0) + cantReal < 0) { showAlert(`No puede descontar ${Math.abs(cantReal)} unidades: solo hay ${prod.stock || 0} en stock.`); return; } const ok = await registrarMovimientoKardex(pId, tipo, cantReal, motivo); if (!ok) { showAlert("No se pudo registrar el ajuste."); return; } await registrarAuditoria('INVENTARIO', 'AJUSTE', `Ajuste (${tipo}) de ${cantReal} unidades en "${prod.name}". Motivo: ${motivo}`); document.getElementById("ajusteInventarioModal").classList.add("hidden"); actualizarTablaInventario(); actualizarCatalogo(); renderDashboard(); showAlert("Ajuste de inventario guardado correctamente."); };

function prepararCampoDeudaCliente(esEdicion) {
    const debtInput = document.getElementById("clientDebt"), hint = document.getElementById("clientDebtHint");
    if (!debtInput) return;
    debtInput.readOnly = esEdicion;
    if (hint) hint.textContent = esEdicion ? "La deuda solo cambia con ventas a crédito, abonos y anulaciones." : "";
}

document.getElementById("addNewClientBtn")?.addEventListener("click", () => { document.getElementById("clientForm")?.reset(); const ci = document.getElementById("clientId"); if(ci) ci.value = ""; prepararCampoDeudaCliente(false); document.getElementById("clientModal")?.classList.remove("hidden"); });
document.getElementById("quickAddClientBtn")?.addEventListener("click", () => {
    document.getElementById("clientForm")?.reset();
    const ci = document.getElementById("clientId"); if (ci) ci.value = "";
    prepararCampoDeudaCliente(false);
    document.getElementById("clientModal")?.classList.remove("hidden");
});
document.getElementById("clientForm")?.addEventListener("submit", async (e) => { 
    e.preventDefault(); if (connectedMode) return window.PosClients?.save(); const id = document.getElementById("clientId").value;
    const existingClient = id ? clients.find(c => String(c.id) === String(id)) : null;
    const nuevaDeuda = existingClient ? (existingClient.debt || 0) : r2(parseFloat(document.getElementById("clientDebt").value));
    const nuevoLimite = r2(parseFloat(document.getElementById("clientLimit").value));
    const nombreCliente = document.getElementById("clientName").value.trim(); if (!nombreCliente) { showAlert("⚠️ El nombre del cliente es obligatorio."); return; }
    if (isNaN(nuevoLimite) || isNaN(nuevaDeuda) || nuevoLimite < 0 || nuevaDeuda < 0) { showAlert("⚠️ El límite de crédito y la deuda deben ser valores válidos y no negativos."); return; }
    const clientData = { id: existingClient ? existingClient.id : Date.now(), business_id: DEFAULT_BUSINESS_ID, name: nombreCliente, phone: document.getElementById("clientPhone").value.trim(), ruc: document.getElementById("clientRuc").value.trim(), address: document.getElementById("clientAddress").value.trim(), creditLimit: nuevoLimite, debt: nuevaDeuda, deudaSinFactura: existingClient ? (existingClient.deudaSinFactura ?? nuevaDeuda) : nuevaDeuda, active: id ? (existingClient?.active !== false) : true }; 
    if (id) { const idx = clients.findIndex(c => String(c.id) === String(id)); if(idx > -1) { clients[idx] = clientData; } } else { clients.push(clientData); }
    await localDB.clients.put(clientData); await encolarSincronizacion(id ? 'UPDATE' : 'INSERT', 'clients', clientData); document.getElementById("clientModal")?.classList.add("hidden"); actualizarTablaClientes(); renderDashboard(); refrescarSelectClientesCredito(clientData.id);
});

function actualizarTablaClientes() { 
    const tb = document.getElementById("clientsTableBody"); if(!tb) return; const hoyTS = Date.now(); 
    tb.innerHTML = clients.map(c => { 
        const disponible = (c.creditLimit||0) - (c.debt||0); const facturasCliente = salesHistory.filter(s => s.cliente === c.name && s.metodo === "Crédito" && !s.anulada); const tieneVencido = facturasCliente.some(s => s.vencimientoTS && s.vencimientoTS < hoyTS && (c.debt||0) > 0); 
        const isActive = c.active !== false;
        let estadoHtml;
        if (!isActive) { estadoHtml = `Inactivo`; }
        else if (tieneVencido) { estadoHtml = `⚠️ Vencido`; }
        else if ((c.debt||0) > 0) { estadoHtml = `Activo`; }
        else { estadoHtml = `Al día`; }
        
        const tieneHist = true;
        const btnBorrar = tieneHist ? `<button class="btn btn-sm ${isActive ? 'btn-secondary' : 'btn-success'}" onclick="window.toggleEstadoCliente('${c.id}')">${isActive ? 'Inactivar' : 'Activar'}</button>` : `<button class="btn btn-sm btn-danger" onclick="window.eliminarClienteFisico('${c.id}')">Borrar</button>`;
            
        return `<tr style="${isActive ? '' : 'background-color:#f9f9f9; opacity:0.8;'}"><td>${c.id}<br><strong>${escapeHtml(c.name)}</strong></td><td>${escapeHtml(c.phone)}</td><td>${sysConfig.currency}${(c.creditLimit||0).toFixed(2)}</td><td style="color:${disponible<0?'red':'green'}; font-weight:bold;">${sysConfig.currency}${disponible.toFixed(2)}</td><td style="color:red; font-weight:bold; font-size:1.1em;">${sysConfig.currency}${(c.debt||0).toFixed(2)}</td><td>${estadoHtml}</td><td><button class="btn btn-sm btn-secondary" onclick="window.verEstadoCuentaCliente('${c.id}')">Historial</button> <button class="btn btn-sm btn-primary" onclick="window.editarCliente('${c.id}')">Editar</button> ${btnBorrar}</td></tr>`; 
    }).join(""); 
}

window.toggleEstadoCliente = async function(id) {
    if (connectedMode) return window.PosClients?.toggle(id);
    if (!isAdmin('clientsView')) { showAlert("No tiene permisos."); return; }
    const c = clients.find(x => String(x.id) === String(id)); if(!c) return;
    const nuevoEstado = c.active === false ? true : false;
    showConfirm(`¿Deseas ${nuevoEstado ? 'activar' : 'inactivar'} al cliente ${c.name}?`, async () => {
        c.active = nuevoEstado; await localDB.clients.put(c); await encolarSincronizacion('UPDATE', 'clients', c);
        actualizarTablaClientes(); refrescarSelectClientesCredito(); showAlert(`Cliente ${nuevoEstado ? 'activado' : 'inactivado'}.`);
    });
};

window.editarCliente = function(id) { if (connectedMode) return window.PosClients?.edit(id); const c = clients.find(x => String(x.id) === String(id)); if(!c) return; document.getElementById("clientId").value = c.id; document.getElementById("clientName").value = c.name; document.getElementById("clientPhone").value = c.phone || ""; document.getElementById("clientRuc").value = c.ruc || ""; document.getElementById("clientAddress").value = c.address || ""; document.getElementById("clientLimit").value = c.creditLimit||0; document.getElementById("clientDebt").value = c.debt||0; prepararCampoDeudaCliente(true); document.getElementById("clientModal")?.classList.remove("hidden"); };
function obtenerAbonosDeFactura(tipo, facturaId) {
    return abonosHistory.filter(abono => abono.tipo === tipo && String(abono.facturaId) === String(facturaId) && !abono.anulado);
}

function saldosFacturasCliente(client) {
    if (!client) return { facs: [], abonado: {} };
    const facs = salesHistory
        .filter(sale => sale.metodo === "Crédito" && !sale.anulada &&
            (String(sale.clienteId) === String(client.id) || (!sale.clienteId && sale.cliente === client.name)))
        .sort((a, b) => (a.fechaTS || a.id) - (b.fechaTS || b.id));
    const abonado = {};
    facs.forEach(sale => { abonado[String(sale.id)] = 0; });
    const abonos = abonosHistory.filter(abono =>
        (abono.tipo === "cliente" || abono.tipo === "factura") &&
        String(abono.referenciaId) === String(client.id) && !abono.anulado
    );
    abonos.filter(abono => abono.facturaId).forEach(abono => {
        const saleId = String(abono.facturaId);
        if (abonado[saleId] !== undefined) {
            abonado[saleId] = r2(abonado[saleId] + (Number(abono.monto) || 0));
        }
    });
    let resto = r2(abonos.filter(abono => !abono.facturaId)
        .reduce((total, abono) => total + (Number(abono.monto) || 0), 0));
    for (const sale of facs) {
        if (resto <= 0) break;
        const saleId = String(sale.id);
        const saldo = r2(Math.max(0, (Number(sale.total) || 0) - abonado[saleId]));
        const aplica = Math.min(saldo, resto);
        abonado[saleId] = r2(abonado[saleId] + aplica);
        resto = r2(resto - aplica);
    }
    return { facs, abonado, resto };
}

function calcFactura(saleId) {
    const sale = salesHistory.find(item => String(item.id) === String(saleId));
    if (!sale) return null;
    const client = clients.find(item => String(item.id) === String(sale.clienteId)) ||
        clients.find(item => item.name === sale.cliente);
    if (!client) {
        const abonado = abonosHistory
            .filter(abono => (abono.tipo === "cliente" || abono.tipo === "factura") && String(abono.facturaId) === String(sale.id) && !abono.anulado)
            .reduce((total, abono) => total + (Number(abono.monto) || 0), 0);
        return { s: sale, abonado: r2(abonado), saldo: r2(Math.max(0, (Number(sale.total) || 0) - abonado)) };
    }
    const { abonado } = saldosFacturasCliente(client);
    const totalAbonado = r2(abonado[String(sale.id)] || 0);
    return { s: sale, abonado: totalAbonado, saldo: r2(Math.max(0, (Number(sale.total) || 0) - totalAbonado)) };
}

function calcularSaldoFacturasCliente(client) {
    const { facs, abonado } = saldosFacturasCliente(client);
    return r2(facs.reduce((total, sale) =>
        total + Math.max(0, (Number(sale.total) || 0) - (abonado[String(sale.id)] || 0)), 0));
}

function calcularDeudaFacturasCliente(client) {
    return r2(calcularSaldoFacturasCliente(client) + (Number(client?.deudaSinFactura) || 0));
}

function obtenerTotalAbonadoFactura(tipo, facturaId) {
    if (tipo === "cliente") return calcFactura(facturaId)?.abonado || 0;
    return r2(obtenerAbonosDeFactura(tipo, facturaId).reduce((total, abono) => total + (Number(abono.monto) || 0), 0));
}

function obtenerSaldoFactura(tipo, factura) {
    if (!factura || factura.anulada) return 0;
    if (tipo === "cliente") return calcFactura(factura.id)?.saldo || 0;
    return r2(Math.max(0, (Number(factura.total) || 0) - obtenerTotalAbonadoFactura(tipo, factura.id)));
}

function pintarModalAbonoVenta(sale) {
    const client = clients.find(item => String(item.id) === String(sale.clienteId)) || clients.find(item => item.name === sale.cliente);
    const invoice = calcFactura(sale.id);
    if (!client || !invoice) return;
    const pending = invoice.saldo;
    document.getElementById("paySaleNumero").textContent = `#${String(sale.numero).padStart(6, "0")}`;
    document.getElementById("paySaleCliente").textContent = client.name;
    document.getElementById("paySaleTotal").textContent = `${sysConfig.currency}${r2(sale.total).toFixed(2)}`;
    document.getElementById("paySalePaid").textContent = `${sysConfig.currency}${invoice.abonado.toFixed(2)}`;
    document.getElementById("paySaleSaldo").textContent = `${sysConfig.currency}${pending.toFixed(2)}`;
    const amountInput = document.getElementById("paySaleAmount");
    if (amountInput) { amountInput.value = ""; amountInput.min = "0.01"; amountInput.step = "0.01"; amountInput.max = pending.toFixed(2); amountInput.disabled = pending <= 0; }
    const submitButton = document.querySelector("#paymentSaleForm button[type='submit']");
    if (submitButton) submitButton.disabled = pending <= 0;
}

function registrarMovimientoAbonoEnCaja(tipo, monto, concepto, abono) {
    if (!cajaActual) return false;
    cajaActual.movimientos.push({ id: Date.now() + Math.random(), cajaSessionId: cajaActual.id, tipo, monto, concepto, fechaTS: abono.fechaTS, fecha: new Date(abono.fechaTS).toLocaleString(), usuario: abono.usuario, estado: "pendiente", referenciaAbonoId: abono.id, anulado: false });
    return true;
}

window.abrirAbonoVenta = function(id) {
    if (connectedMode) return window.PosClients?.openPayment(id);
    const sale = salesHistory.find(item => String(item.id) === String(id));
    if (!sale || sale.anulada || sale.metodo !== "Crédito") return;
    const client = clients.find(item => String(item.id) === String(sale.clienteId)) || clients.find(item => item.name === sale.cliente);
    if (!client) { showAlert("No se encontró el cliente de esta factura."); return; }
    document.getElementById("paySaleId").value = sale.id;
    const amountInput = document.getElementById("paySaleAmount");
    if (amountInput) amountInput.value = "";
    pintarModalAbonoVenta(sale);
    document.getElementById("paymentSaleModal")?.classList.remove("hidden");
};

document.getElementById("paymentSaleForm")?.addEventListener("submit", async (e) => {
    e.preventDefault(); if (connectedMode) return window.PosClients?.submitPayment();
    const saleId = document.getElementById("paySaleId").value;
    const sale = salesHistory.find(item => String(item.id) === String(saleId));
    const client = sale && (clients.find(item => String(item.id) === String(sale.clienteId)) || clients.find(item => item.name === sale.cliente));
    const amount = r2(parseFloat(document.getElementById("paySaleAmount").value));
    const metodoPago = document.getElementById("paySaleMethod")?.value || "efectivo";
    if (!sale || sale.anulada || !client) { showAlert("La factura o el cliente ya no están disponibles."); return; }
    const invoice = calcFactura(sale.id);
    if (!invoice || invoice.saldo <= 0) { showAlert("Esta factura ya está pagada."); return; }
    if (!Number.isFinite(amount) || amount <= 0) { showAlert("Ingrese un monto de abono válido, mayor que cero."); return; }
    if (amount > invoice.saldo) { showAlert(`Máximo a abonar: ${sysConfig.currency}${invoice.saldo.toFixed(2)}`); return; }
    if (cajaActual?.estado !== "abierta") { showAlert(MSG_SIN_CAJA); return; }

    const fechaTS = Date.now();
    const newAbono = { id: fechaTS, business_id: DEFAULT_BUSINESS_ID, cajaSessionId: cajaActual.id, tipo: "cliente", referenciaId: client.id, facturaId: sale.id, monto: amount, metodoPago, estado: "pendiente", fecha: new Date(fechaTS).toLocaleDateString(), fechaTS, usuario: currentUser.displayName, anulado: false };
    abonosHistory.push(newAbono);
    await localDB.abonos.put(newAbono);
    await encolarSincronizacion("INSERT", "abonos", newAbono);
    client.debt = calcularDeudaFacturasCliente(client);
    await localDB.clients.put(client);
    await encolarSincronizacion("UPDATE", "clients", client);
    if (metodoPago === "efectivo" && registrarMovimientoAbonoEnCaja("entrada", amount, `Abono Factura #${sale.numero}: ${client.name}`, newAbono)) {
        await localDB.cajaSessions.put(cajaActual);
        await encolarSincronizacion("UPDATE", "cajaSessions", cajaActual);
        renderCajaView();
    }
    pintarModalAbonoVenta(sale);
    await registrarAuditoria("CLIENTES", "ABONO_FACTURA", `Abonó ${sysConfig.currency}${amount.toFixed(2)} a la factura #${sale.numero} (${metodoPago}) de "${client.name}"`);
    document.getElementById("paymentSaleModal")?.classList.add("hidden");
    actualizarTablaClientes();
    refrescarSelectClientesCredito();
    renderDashboard();
    if (document.getElementById("statementModalTitle")?.textContent.includes(client.name)) window.verEstadoCuentaCliente(client.id);
    showAlert("Abono de factura registrado correctamente.");
});

window.abrirAbono = function(id) { const c = clients.find(x => String(x.id) === String(id)); if(!c) return; document.getElementById("payClientId").value = c.id; document.getElementById("payClientName").textContent = c.name; document.getElementById("payClientDebt").textContent = `${sysConfig.currency}${(c.debt||0).toFixed(2)}`; const pa = document.getElementById("payAmount"); if(pa) pa.value = ""; document.getElementById("paymentModal")?.classList.remove("hidden"); };
document.getElementById("paymentForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("payClientId").value;
    const amount = r2(parseFloat(document.getElementById("payAmount").value));
    const client = clients.find(item => String(item.id) === String(id));
    const metodoPago = document.getElementById("payMethod")?.value || "efectivo";
    if (!client) return;
    if (!Number.isFinite(amount) || amount <= 0) { showAlert("Ingrese un monto de abono válido, mayor que cero."); return; }
    if (amount > r2(client.debt || 0)) { showAlert("El abono no puede ser mayor a la deuda total."); return; }
    if (cajaActual?.estado !== "abierta") { showAlert(MSG_SIN_CAJA); return; }
    const restoAbonosAnterior = saldosFacturasCliente(client).resto;
    const fechaTS = Date.now();
    const newAbono = { id: fechaTS, business_id: DEFAULT_BUSINESS_ID, cajaSessionId: cajaActual.id, tipo: "cliente", referenciaId: client.id, monto: amount, metodoPago, fecha: new Date(fechaTS).toLocaleDateString(), fechaTS, usuario: currentUser.displayName, anulado: false };
    abonosHistory.push(newAbono);
    await localDB.abonos.put(newAbono);
    await encolarSincronizacion("INSERT", "abonos", newAbono);
    const restoAbonosNuevo = saldosFacturasCliente(client).resto;
    client.deudaSinFactura = r2(Math.max(0, (Number(client.deudaSinFactura) || 0) - Math.max(0, restoAbonosNuevo - restoAbonosAnterior)));
    client.debt = calcularDeudaFacturasCliente(client);
    await localDB.clients.put(client);
    await encolarSincronizacion("UPDATE", "clients", client);
    await registrarAuditoria("CLIENTES", "ABONO", `Registró abono de ${sysConfig.currency}${amount.toFixed(2)} del cliente "${client.name}" (${metodoPago})`);
    if (metodoPago === "efectivo" && registrarMovimientoAbonoEnCaja("entrada", amount, `Abono de crédito: ${client.name}`, newAbono)) {
        await localDB.cajaSessions.put(cajaActual);
        await encolarSincronizacion("UPDATE", "cajaSessions", cajaActual);
        renderCajaView();
    }
    document.getElementById("paymentModal")?.classList.add("hidden");
    actualizarTablaClientes(); renderDashboard(); refrescarSelectClientesCredito();
    showAlert("Abono registrado exitosamente.");
});

window.verEstadoCuentaCliente = function(id) { 
    if (connectedMode) return window.PosClients?.statement(id);
    const c = clients.find(x => String(x.id) === String(id)); if(!c) return; 
    document.getElementById("statementModalTitle").textContent = `Historial: ${c.name}`; 
    document.getElementById("statementModalSubtitle").textContent = `Límite: ${sysConfig.currency}${(c.creditLimit||0).toFixed(2)} | Deuda Actual: ${sysConfig.currency}${(c.debt||0).toFixed(2)}`; 
    
    const clientSales = salesHistory
        .filter(s => (String(s.clienteId) === String(c.id) || (!s.clienteId && s.cliente === c.name)) && s.metodo === "Crédito")
        .map(s => {
            const invoice = calcFactura(s.id);
            const abonado = invoice?.abonado || 0;
            const saldoFactura = s.anulada ? 0 : (invoice?.saldo || 0);
            return {
                type: 'cargo', date: s.fecha, ts: s.fechaTS || s.id,
                ref: `#${String(s.numero).padStart(6, '0')}`,
                detail: s.anulada ? 'Factura Anulada' : `Factura de crédito · Total ${sysConfig.currency}${r2(s.total).toFixed(2)} · Abonado ${sysConfig.currency}${abonado.toFixed(2)} · Pendiente ${sysConfig.currency}${saldoFactura.toFixed(2)}`,
                amount: s.total, dueDate: s.vencimiento, dueTS: s.vencimientoTS,
                saleId: s.id, saldoFactura, anulado: s.anulada
            };
        });
    const clientAbonos = abonosHistory
        .filter(a => (a.tipo === 'cliente' || a.tipo === 'factura') && String(a.referenciaId) === String(c.id))
        .map(a => {
            const invoice = salesHistory.find(s => String(s.id) === String(a.facturaId));
            return { type: 'abono', date: new Date(a.fechaTS || a.id).toLocaleString(), ts: a.fechaTS || a.id, ref: invoice ? `Abono #${String(invoice.numero).padStart(6, '0')}` : `Abono`, detail: `Pago recibido por ${a.metodoPago || "medio no indicado"} (${a.usuario})`, amount: Number(a.monto) || 0, id: a.id, anulado: a.anulado };
        });
    const ledger = [...clientSales, ...clientAbonos].sort((a,b) => a.ts - b.ts); 
    const tbody = document.getElementById("statementTableBody"); if(!tbody) return; 
    
    if(ledger.length === 0) { tbody.innerHTML = `<tr><td colspan="7" class="text-center">No hay movimientos registrados.</td></tr>`; } else { 
        let saldo = 0; const hoy = Date.now(); 
        tbody.innerHTML = ledger.map(mov => { 
            if (!mov.anulado) {
                if (mov.type === 'cargo') saldo = r2(saldo + mov.amount);
                else if (mov.type === 'abono') saldo = r2(saldo - mov.amount);
            }
            const isOverdue = mov.type === 'cargo' && mov.dueTS && mov.dueTS < hoy && !mov.anulado; 
            const dateHtml = mov.type === 'cargo' ? `${mov.date}<br><small style="color:${isOverdue?'#d32f2f':'#666'}; font-weight:${isOverdue?'bold':'normal'}">Vence: ${mov.dueDate||'-'}</small>` : mov.date; 
            const cargoHtml = mov.type === 'cargo' ? (mov.anulado ? `<del>${sysConfig.currency}${mov.amount.toFixed(2)}</del>` : `${sysConfig.currency}${mov.amount.toFixed(2)}`) : ''; 
            const abonoHtml = mov.type === 'abono' ? (mov.anulado ? `<del>${sysConfig.currency}${mov.amount.toFixed(2)}</del>` : `${sysConfig.currency}${mov.amount.toFixed(2)}`) : ''; 
            
            let btnHtml = '';
            if (mov.type === 'cargo') { 
                btnHtml = `<button class="btn btn-sm btn-secondary" onclick="document.getElementById('statementModal').classList.add('hidden'); setTimeout(() => window.reimprimirTicket('${mov.saleId}'), 100);">Ver Factura</button> ` +
                          (!mov.anulado && mov.saldoFactura > 0 ? `<button class="btn btn-sm btn-success" onclick="document.getElementById('statementModal').classList.add('hidden'); setTimeout(() => window.abrirAbonoVenta('${mov.saleId}'), 100);">Abonar</button>` : '');
            } 
            else if (mov.type === 'abono') { btnHtml = mov.anulado ? `<span style="color:#d32f2f; font-weight:bold; font-size:10px;">ANULADO</span>` : `<button class="btn btn-sm btn-danger" onclick="document.getElementById('statementModal').classList.add('hidden'); setTimeout(() => window.anularAbonoCliente('${mov.id}'), 100);">Anular</button>`; }
            
            const trStyle = mov.anulado ? 'style="background-color:#fdf5f5; color:#888;"' : '';
            return `<tr ${trStyle}><td>${dateHtml}</td><td><strong>${escapeHtml(mov.ref)}</strong></td><td>${escapeHtml(mov.detail)}</td><td style="color:#d32f2f; font-weight:bold;">${cargoHtml}</td><td style="color:#28a745; font-weight:bold;">${abonoHtml}</td><td style="font-weight:bold; font-size:1.1em;">${sysConfig.currency}${saldo.toFixed(2)}</td><td>${btnHtml}</td></tr>`; 
        }).join(""); 
    } 
    document.getElementById("statementModal")?.classList.remove("hidden"); 
};

window.anularAbonoCliente = async function(abonoId) {
    if (blockPendingConnected()) return;
    if (!isAdmin('clientsView')) { showAlert("No tiene permisos."); return; }
    const abono = abonosHistory.find(a => String(a.id) === String(abonoId)); if(!abono || abono.anulado) return;
    const cliente = clients.find(c => String(c.id) === String(abono.referenciaId));
    showAnularRegistro("Anular Abono", `Cliente: ${cliente ? cliente.name : 'Desconocido'} - Monto: ${sysConfig.currency}${abono.monto.toFixed(2)}`, async (motivo) => {
        const restoAbonosAnterior = cliente ? saldosFacturasCliente(cliente).resto : 0;
        abono.anulado = true; abono.motivoAnulacion = motivo; abono.fechaAnulacion = new Date().toLocaleString(); abono.usuarioAnulacion = currentUser.displayName;
        if (cliente) {
            const restoAbonosNuevo = saldosFacturasCliente(cliente).resto;
            cliente.deudaSinFactura = r2((Number(cliente.deudaSinFactura) || 0) + Math.max(0, restoAbonosAnterior - restoAbonosNuevo));
            cliente.debt = calcularDeudaFacturasCliente(cliente);
            await localDB.clients.put(cliente);
            await encolarSincronizacion('UPDATE', 'clients', cliente);
        }
        if (cajaActual && (!abono.metodoPago || abono.metodoPago === "efectivo")) { cajaActual.movimientos.push({ id: Date.now() + Math.random(), cajaSessionId: cajaActual.id, tipo: "salida", monto: abono.monto, concepto: `Anulación Abono Cliente: ${cliente ? cliente.name : ''} - ${motivo}`, fechaTS: Date.now(), fecha: new Date().toLocaleString(), usuario: currentUser.displayName, estado: "pendiente", referenciaAbonoId: abono.id }); await localDB.cajaSessions.put(cajaActual); await encolarSincronizacion('UPDATE', 'cajaSessions', cajaActual); }
        await localDB.abonos.put(abono); await encolarSincronizacion('UPDATE', 'abonos', abono); await registrarAuditoria('CLIENTES', 'ANULAR_ABONO', `Anuló abono de ${sysConfig.currency}${abono.monto.toFixed(2)} del cliente ${cliente ? cliente.name : ''}. Motivo: ${motivo}`);
        const factura = abono.facturaId && salesHistory.find(sale => String(sale.id) === String(abono.facturaId));
        if (factura && !document.getElementById("paymentSaleModal")?.classList.contains("hidden")) pintarModalAbonoVenta(factura);
        actualizarTablaClientes(); refrescarSelectClientesCredito(); if(cajaActual) renderCajaView(); renderDashboard(); showAlert("Abono anulado exitosamente.");
        if(cliente) setTimeout(() => window.verEstadoCuentaCliente(cliente.id), 500);
    });
};

document.getElementById("addNewSupplierBtn")?.addEventListener("click", () => { document.getElementById("supplierForm")?.reset(); const si = document.getElementById("supplierId"); if(si) si.value = ""; document.getElementById("supplierModal")?.classList.remove("hidden"); });

document.getElementById("quickAddSupplierFromPurchBtn")?.addEventListener("click", () => { 
    document.getElementById("supplierForm")?.reset(); 
    const si = document.getElementById("supplierId"); if(si) si.value = ""; 
    const suppModal = document.getElementById("supplierModal");
    if(suppModal) {
        suppModal.style.zIndex = "10050"; 
        suppModal.classList.remove("hidden");
    }
});

document.getElementById("supplierForm")?.addEventListener("submit", async (e) => { 
    e.preventDefault(); 
    const id = document.getElementById("supplierId").value; 
    const existingSupplier = id ? suppliers.find(s => String(s.id) === String(id)) : null;
    const suppData = { 
        id: existingSupplier ? existingSupplier.id : (id ? Number(id) : Date.now()), business_id: DEFAULT_BUSINESS_ID, name: document.getElementById("suppName").value.trim(), 
        contact: document.getElementById("suppContact").value.trim(), phone: document.getElementById("suppPhone").value.trim(), 
        ruc: document.getElementById("suppRuc").value.trim(), address: document.getElementById("suppAddress").value.trim(), 
        debt: id ? (suppliers.find(s => String(s.id) === String(id))?.debt||0) : 0, 
        active: id ? (suppliers.find(s => String(s.id) === String(id))?.active !== false) : true 
    }; 
    if (!suppData.name || !suppData.contact || !suppData.phone) {
        showAlert("Complete nombre, contacto y teléfono.");
        return;
    }
    
    if (id) { 
        const idx = suppliers.findIndex(s => String(s.id) === String(id)); 
        if(idx > -1) suppliers[idx] = suppData; 
        await registrarAuditoria('PROVEEDORES', 'EDITAR_PROVEEDOR', `Editó al proveedor "${suppData.name}"`); 
    } else { 
        suppliers.push(suppData); 
        await registrarAuditoria('PROVEEDORES', 'CREAR_PROVEEDOR', `Creó al proveedor "${suppData.name}"`); 
    } 
    await localDB.suppliers.put(suppData); 
    await encolarSincronizacion(id ? 'UPDATE' : 'INSERT', 'suppliers', suppData); 
    
    const sModal = document.getElementById("supplierModal");
    if(sModal) { sModal.classList.add("hidden"); sModal.style.zIndex = ""; }
    
    actualizarTablaProveedores(); 
    renderDashboard(); 
    
    const purchModalRef = document.getElementById("purchaseModal"); 
    if (purchModalRef && !purchModalRef.classList.contains("hidden")) { 
        const sdl = document.getElementById("supplierDataList"); 
        if (sdl) sdl.innerHTML = suppliers.filter(s => s.active !== false).map(s => `<option value="${escapeHtml(s.name)}">`).join(""); 
        const pSupp = document.getElementById("purchSupplier"); 
        if (pSupp) { pSupp.value = suppData.name; } 
        showAlert("Proveedor creado y añadido a la factura rápida."); 
    } else {
        showAlert("Proveedor guardado correctamente.");
    }
});

function actualizarTablaProveedores() { 
    const tb = document.getElementById("suppliersTableBody"); if(!tb) return; 
    tb.innerHTML = suppliers.map(s => { 
        const comprasProv = purchasesHistory.filter(p => p.proveedor === s.name && !p.anulada); const totalComprado = comprasProv.reduce((sum, p) => sum + p.total, 0); 
        const isActive = s.active !== false;
        const btnBorrar = `<button class="btn btn-sm ${isActive ? 'btn-secondary' : 'btn-success'}" onclick="window.toggleEstadoProveedor('${s.id}')">${isActive ? 'Inactivar' : 'Activar'}</button>`;
        
        return `<tr style="${isActive ? '' : 'background-color:#f9f9f9; opacity:0.8;'}"><td><strong>${escapeHtml(s.name)}</strong><br><small style="color:#666;">RUC: ${escapeHtml(s.ruc) || 'N/A'}</small></td><td>${escapeHtml(s.contact)}<br><small>${escapeHtml(s.phone)}</small></td><td><small>${escapeHtml(s.address) || '-'}</small></td><td><span style="color:#0066cc; font-weight:bold;">${sysConfig.currency}${totalComprado.toFixed(2)}</span><br><small>${comprasProv.length} compras</small></td><td style="color:#d32f2f; font-weight:bold; font-size:1.1em;">${sysConfig.currency}${(s.debt||0).toFixed(2)}</td><td><button class="btn btn-sm btn-secondary" onclick="window.verEstadoCuentaProveedor('${s.id}')">Edo. Cuenta</button> <button class="btn btn-sm btn-primary" onclick="window.editarProveedor('${s.id}')">Editar</button> ${btnBorrar}</td></tr>`; 
    }).join(""); 
}

window.toggleEstadoProveedor = async function(id) {
    if (!isAdmin(['suppliersView', 'payablesView'])) { showAlert("No tiene permisos."); return; }
    const s = suppliers.find(x => String(x.id) === String(id)); if(!s) return;
    const nuevoEstado = s.active === false ? true : false;
    showConfirm(`¿Deseas ${nuevoEstado ? 'activar' : 'inactivar'} al proveedor ${s.name}?`, async () => {
        s.active = nuevoEstado; await localDB.suppliers.put(s); await encolarSincronizacion('UPDATE', 'suppliers', s);
        actualizarTablaProveedores(); showAlert(`Proveedor ${nuevoEstado ? 'activado' : 'inactivado'}.`);
    });
};

window.editarProveedor = function(id) { const s = suppliers.find(x => String(x.id) === String(id)); if(!s) return; document.getElementById("supplierId").value = s.id; document.getElementById("suppName").value = s.name; document.getElementById("suppContact").value = s.contact; document.getElementById("suppPhone").value = s.phone; document.getElementById("suppRuc").value = s.ruc || ""; document.getElementById("suppAddress").value = s.address || ""; document.getElementById("supplierModal")?.classList.remove("hidden"); };

window.verEstadoCuentaProveedor = function(id) { 
    const s = suppliers.find(x => String(x.id) === String(id)); if(!s) return; 
    document.getElementById("statementModalTitle").textContent = `Cuentas por Pagar: ${s.name}`; document.getElementById("statementModalSubtitle").textContent = `Deuda Total: ${sysConfig.currency}${(s.debt||0).toFixed(2)}`; 
    
    const suppPurch = purchasesHistory.filter(p => p.proveedor === s.name && p.tipo === "credito").map(p => ({ type: 'cargo', date: p.fecha, ts: p.fechaTS||p.id, ref: p.factura, detail: p.anulada ? 'Factura Anulada' : `Factura de compra · Total ${sysConfig.currency}${r2(p.total).toFixed(2)} · Abonado ${sysConfig.currency}${obtenerTotalAbonadoFactura("proveedor", p.id).toFixed(2)} · Pendiente ${sysConfig.currency}${obtenerSaldoFactura("proveedor", p).toFixed(2)}`, amount: p.total, id: p.id, anulado: p.anulada }));
    const suppAbonos = abonosHistory.filter(a => a.tipo === 'proveedor' && String(a.referenciaId) === String(s.id)).map(a => { const invoice = purchasesHistory.find(p => String(p.id) === String(a.facturaId)); return { type: 'abono', date: new Date(a.fechaTS || a.id).toLocaleString(), ts: a.fechaTS, ref: invoice ? `Pago ${invoice.factura}` : 'Abono', detail: `Pago a proveedor por ${a.metodoPago || "medio no indicado"} (${a.usuario})`, amount: a.monto, id: a.id, anulado: a.anulado }; });
    const ledger = [...suppPurch, ...suppAbonos].sort((a,b) => a.ts - b.ts);
    
    const tbody = document.getElementById("statementTableBody"); if(!tbody) return; 
    if(ledger.length === 0) { tbody.innerHTML = `<tr><td colspan="7" class="text-center">No hay movimientos registrados.</td></tr>`; } else { 
        let saldo = 0;
        tbody.innerHTML = ledger.map(mov => { 
            if (!mov.anulado) { if (mov.type === 'cargo') saldo += mov.amount; else saldo -= mov.amount; }
            const cargoHtml = mov.type === 'cargo' ? (mov.anulado ? `<del>${sysConfig.currency}${mov.amount.toFixed(2)}</del>` : `${sysConfig.currency}${mov.amount.toFixed(2)}`) : ''; 
            const abonoHtml = mov.type === 'abono' ? (mov.anulado ? `<del>${sysConfig.currency}${mov.amount.toFixed(2)}</del>` : `${sysConfig.currency}${mov.amount.toFixed(2)}`) : '';
            
            let btnHtml = '';
            if (mov.type === 'cargo') { 
                btnHtml = `<button class="btn btn-sm btn-secondary" onclick="document.getElementById('statementModal').classList.add('hidden'); setTimeout(() => window.verFacturaCompra('${mov.id}'), 100);">Ver Factura</button> ` +
                          (mov.anulado || obtenerSaldoFactura("proveedor", purchasesHistory.find(p => String(p.id) === String(mov.id))) <= 0 ? '' : `<button class="btn btn-sm btn-success" onclick="document.getElementById('statementModal').classList.add('hidden'); setTimeout(() => window.abrirAbonoFacturaProveedor('${mov.id}'), 100);">Abonar</button>`);
            }
            else if (mov.type === 'abono') { btnHtml = mov.anulado ? `<span style="color:#d32f2f; font-weight:bold; font-size:10px;">ANULADO</span>` : `<button class="btn btn-sm btn-danger" onclick="document.getElementById('statementModal').classList.add('hidden'); setTimeout(() => window.anularAbonoProveedor('${mov.id}'), 100);">Anular</button>`; }
            
            const trStyle = mov.anulado ? 'style="background-color:#fdf5f5; color:#888;"' : '';
            return `<tr ${trStyle}><td>${mov.date}</td><td><strong>${escapeHtml(mov.ref)}</strong></td><td>${escapeHtml(mov.detail)}</td><td style="color:#d32f2f; font-weight:bold;">${cargoHtml}</td><td style="color:#28a745; font-weight:bold;">${abonoHtml}</td><td style="font-weight:bold; font-size:1.1em;">${sysConfig.currency}${saldo.toFixed(2)}</td><td>${btnHtml}</td></tr>`; 
        }).join(""); 
    } 
    document.getElementById("statementModal")?.classList.remove("hidden"); 
};

window.anularAbonoProveedor = async function(abonoId) {
    if (blockPendingConnected()) return;
    if (!isAdmin(['suppliersView', 'payablesView'])) { showAlert("No tiene permisos."); return; }
    const abono = abonosHistory.find(a => String(a.id) === String(abonoId)); if(!abono || abono.anulado) return;
    const proveedor = suppliers.find(s => String(s.id) === String(abono.referenciaId));
    showAnularRegistro("Anular Pago a Proveedor", `Proveedor: ${proveedor ? proveedor.name : 'Desconocido'} - Monto: ${sysConfig.currency}${abono.monto.toFixed(2)}`, async (motivo) => {
        abono.anulado = true; abono.motivoAnulacion = motivo; abono.fechaAnulacion = new Date().toLocaleString(); abono.usuarioAnulacion = currentUser.displayName;
        if (proveedor) { proveedor.debt = r2((proveedor.debt || 0) + abono.monto); await localDB.suppliers.put(proveedor); await encolarSincronizacion('UPDATE', 'suppliers', proveedor); }
        if (!abono.metodoPago || abono.metodoPago === "efectivo") {
            const session = cajaHistorial.find(item => item.movimientos?.some(mov => String(mov.referenciaAbonoId) === String(abono.id))) || cajaActual;
            if (session) {
                session.movimientos.push({ id: Date.now() + Math.random(), cajaSessionId: session.id, tipo: "entrada", monto: abono.monto, concepto: `Anulación Pago Proveedor: ${proveedor ? proveedor.name : ''} - ${motivo}`, fechaTS: Date.now(), fecha: new Date().toLocaleString(), usuario: currentUser.displayName, estado: "pendiente", referenciaAbonoId: abono.id });
                if (session.estado === "cerrada" && !session.resumenCierre) {
                    const summary = calcularResumenCaja(session);
                    session.efectivoEsperado = summary.esperado;
                    session.diferencia = r2((session.efectivoReal || 0) - summary.esperado);
                }
                await localDB.cajaSessions.put(session);
                await encolarSincronizacion('UPDATE', 'cajaSessions', session);
            }
        }
        await localDB.abonos.put(abono); await encolarSincronizacion('UPDATE', 'abonos', abono); await registrarAuditoria('PROVEEDORES', 'ANULAR_PAGO', `Anuló pago de ${sysConfig.currency}${abono.monto.toFixed(2)} al proveedor ${proveedor ? proveedor.name : ''}. Motivo: ${motivo}`);
        actualizarTablaCuentasPorPagar(); renderCajaView(); renderDashboard(); showAlert("Pago anulado exitosamente.");
        if(proveedor) setTimeout(() => window.verEstadoCuentaProveedor(proveedor.id), 500);
    });
};

window.verFacturaCompra = function(id) { const p = purchasesHistory.find(x => String(x.id) === String(id)); if(!p) return; let prods = p.items && p.items.length > 0 ? p.items.map(i => `<div style="display:flex; justify-content:space-between; margin-bottom:5px; font-size:12px;"><span>${i.cantidad}x ${escapeHtml(i.producto)}</span><span>${sysConfig.currency}${(i.total||0).toFixed(2)}</span></div>`).join("") : `<div style="display:flex; justify-content:space-between; margin-bottom:5px; font-size:12px;"><span>${p.cantidad || '-'}x ${escapeHtml(p.producto) || 'Varios'}</span><span>${sysConfig.currency}${(p.total||0).toFixed(2)}</span></div>`; const estadoAnulada = p.anulada ? `<div style="text-align:center; color:white; background:#d32f2f; font-weight:bold; padding:5px; margin-bottom:10px;">FACTURA ANULADA${p.motivoAnulacion ? ' - ' + escapeHtml(p.motivoAnulacion) : ''}</div>` : ''; const tkCont = document.getElementById("ticketContent"); if(tkCont) { tkCont.innerHTML = `<div id="imprimibleTicket" style="font-family: monospace; background: #fff; border: 1px dashed #ccc; padding: 25px; width: 100%; max-width: 350px;">${estadoAnulada}<h3 style="text-align:center; margin:0;">COMPROBANTE DE COMPRA</h3><div style="text-align:center; color:#555; font-size:12px; margin-bottom:10px;">PROVEEDOR: ${escapeHtml(p.proveedor)}</div><div style="border-top:1px dashed #000; margin:10px 0;"></div><div style="display:flex; justify-content:space-between; margin-bottom:3px;"><span>Factura Nº:</span><span>${escapeHtml(p.factura)}</span></div><div style="display:flex; justify-content:space-between; margin-bottom:3px;"><span>Fecha:</span><span>${p.fecha}</span></div><div style="display:flex; justify-content:space-between; margin-bottom:3px;"><span>Condición:</span><span>${p.tipo.toUpperCase()}</span></div>${p.tipo === 'credito' ? `<div style="display:flex; justify-content:space-between; margin-bottom:3px; color:#d32f2f;"><span>Vence:</span><span>${p.vencimiento || '-'}</span></div>` : ''}<div style="border-top:1px dashed #000; margin:10px 0;"></div>${prods}<div style="border-top:1px dashed #000; margin:10px 0;"></div><div style="display:flex; justify-content:space-between; font-weight:bold; font-size:18px;"><span>TOTAL</span><span>${sysConfig.currency}${(p.total||0).toFixed(2)}</span></div></div>`; } document.getElementById("ticketModal")?.classList.remove("hidden"); };

const mostrarFacturaCompraOriginal = window.verFacturaCompra;
window.verFacturaCompra = function(id) {
    ticketEsVentaNueva = false;
    return mostrarFacturaCompraOriginal(id);
};

let currentPurchaseCart = [];
const purchProductInputEl = document.getElementById("purchProductTemp");
function actualizarSugerenciasProductosCompra() {
    const list = document.getElementById("productDataList");
    if (!list) return;
    const options = new Map();
    const addOption = (value, label) => {
        const normalized = normalizarBusquedaProducto(value);
        if (normalized && !options.has(normalized)) options.set(normalized, `<option value="${escapeHtml(value)}" label="${escapeHtml(label)}"></option>`);
    };
    products.filter(product => !product.deleted).forEach(product => {
        const codes = codigosDeProducto(product);
        addOption(product.name, codes[0] ? `Código: ${codes[0]}` : product.category || 'Producto');
        codes.forEach(code => addOption(code, product.name || 'Producto'));
    });
    list.innerHTML = [...options.values()].join("");
}
function resolverProductoEscritoCompra(value) {
    const available = products.filter(product => !product.deleted);
    let matches = productosConCodigoExacto(available, value);
    if (!matches.length) {
        const normalized = normalizarBusquedaProducto(value);
        matches = available.filter(product => normalizarBusquedaProducto(product.name) === normalized);
    }
    return { product: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}
purchProductInputEl?.addEventListener("input", () => { delete purchProductInputEl.dataset.productId; });
document.getElementById("addNewPurchaseBtn")?.addEventListener("click", () => { delete purchProductInputEl?.dataset.productId; });
document.getElementById("addNewPurchaseBtn")?.addEventListener("click", () => { document.getElementById("purchaseForm")?.reset(); const pi = document.getElementById("purchId"); if(pi) pi.value = ""; currentPurchaseCart = []; renderPurchaseCart(); document.getElementById("purchDaysContainer").style.display = "none"; const sdl = document.getElementById("supplierDataList"); if(sdl) sdl.innerHTML = suppliers.filter(s => s.active !== false).map(s => `<option value="${escapeHtml(s.name)}">`).join(""); actualizarSugerenciasProductosCompra(); document.getElementById("purchaseModal")?.classList.remove("hidden"); });
document.getElementById("btnAddItemToPurch")?.addEventListener("click", () => {
    const prodName = purchProductInputEl.value.trim(); const qty = Number(document.getElementById("purchQtyTemp").value); const cost = parseFloat(document.getElementById("purchCostTemp").value);
    if(!prodName || !Number.isFinite(qty) || !Number.isFinite(cost) || qty <= 0) { showAlert("Ingrese producto, cantidad y costo unitario."); return; }
    if (!Number.isInteger(qty)) { showAlert("La cantidad debe ser un número entero mayor que cero."); return; }
    if (cost < 0) { showAlert("El costo unitario no puede ser negativo."); return; }
    const quickProductId = purchProductInputEl.dataset.productId;
    const quickProduct = quickProductId && products.find(p => String(p.id) === quickProductId && !p.deleted && normalizarBusquedaProducto(p.name) === normalizarBusquedaProducto(prodName));
    const resolved = quickProduct ? { product: quickProduct, ambiguous: false } : resolverProductoEscritoCompra(prodName);
    if (resolved.ambiguous) { showAlert("Más de un producto coincide con ese código. Escribe el nombre para elegirlo sin ambigüedad."); return; }
    const matchedProd = resolved.product;
    if (!matchedProd) { showAlert("El producto no existe. Créelo con el botón de agregar producto antes de incluirlo en la compra."); return; }

    currentPurchaseCart.push({ producto: matchedProd.name, productId: matchedProd.id, cantidad: qty, costo: r2(cost), total: r2(qty * cost) });
    purchProductInputEl.value = ""; delete purchProductInputEl.dataset.productId; document.getElementById("purchQtyTemp").value = "1"; document.getElementById("purchCostTemp").value = ""; renderPurchaseCart();
});
document.getElementById("quickEditProductFromPurchBtn")?.addEventListener("click", () => { const value = document.getElementById("purchProductTemp").value.trim(); if (!value) { showAlert("Escribe el nombre o código del producto en el campo para poder editarlo."); return; } const resolved = resolverProductoEscritoCompra(value); if (resolved.ambiguous) { showAlert("Más de un producto coincide con ese código. Escribe el nombre para elegirlo sin ambigüedad."); return; } if (resolved.product) window.editarProducto(resolved.product.id); else showAlert("Producto no encontrado en la base de datos."); });

function renderPurchaseCart() { const tbody = document.getElementById("purchCartBody"); if(!tbody) return; let totalFactura = 0; if(currentPurchaseCart.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:#999;">Aún no hay productos en la factura.</td></tr>`; } else { tbody.innerHTML = currentPurchaseCart.map((item, idx) => { totalFactura += item.total; return `<tr><td><strong>${escapeHtml(item.producto)}</strong>${!item.productId ? ' <small style="color:#ff9800;">(sin vincular)</small>' : ''}</td><td>${item.cantidad}</td><td>${sysConfig.currency}${item.costo.toFixed(2)}</td><td>${sysConfig.currency}${item.total.toFixed(2)}</td><td><button type="button" onclick="window.removePurchItem(${idx})" style="background:#d32f2f; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;">X</button></td></tr>`; }).join(""); } const pTot = document.getElementById("purchTotalDisplay"); if(pTot) pTot.textContent = `${sysConfig.currency}${totalFactura.toFixed(2)}`; }
window.removePurchItem = function(idx) { currentPurchaseCart.splice(idx, 1); renderPurchaseCart(); };

function resolverProductoDeItemCompra(item) {
    if (item.productId) { const p = products.find(pr => String(pr.id) === String(item.productId)); if (p) return p; }
    return resolverProductoEscritoCompra(item.producto || "").product;
}

document.getElementById("purchaseForm")?.addEventListener("submit", async (e) => { 
    e.preventDefault(); if (blockPendingConnected()) return; if (!isAdmin(['purchasesView', 'historyView'])) { showAlert("No tiene permisos para registrar compras."); return; } if(currentPurchaseCart.length === 0) { showAlert("Agrega al menos un producto a la factura."); return; }
    const pId = document.getElementById("purchId").value; const tipoCompra = document.getElementById("purchType").value; const proveedorNombre = document.getElementById("purchSupplier").value.trim(); const facturaNum = document.getElementById("purchInvoice").value.trim() || "S/F";
    const purchaseItems = currentPurchaseCart.map(item => { const producto = resolverProductoDeItemCompra(item); return producto ? { ...item, productId: producto.id } : null; });
    if (purchaseItems.some(item => !item)) { showAlert("No se puede guardar la compra: cada producto debe estar vinculado a un producto del inventario."); return; }
    const totalFactura = r2(purchaseItems.reduce((sum, item) => sum + item.total, 0));
    let dueDateStr = null; if(tipoCompra === "credito") { const days = Math.max(1, parseInt(document.getElementById("purchDays")?.value) || 30); let d = new Date(); d.setDate(d.getDate() + days); dueDateStr = d.toLocaleDateString(); } 
    const newPurch = { id: pId ? pId : Date.now(), business_id: DEFAULT_BUSINESS_ID, fecha: new Date().toLocaleDateString(), fechaTS: Date.now(), factura: facturaNum, tipo: tipoCompra, proveedor: proveedorNombre, items: purchaseItems, total: totalFactura, vencimiento: dueDateStr, anulada: false }; 
    
    if (pId) { const index = purchasesHistory.findIndex(p => String(p.id) === String(pId)); if(index > -1) purchasesHistory[index] = newPurch; } else {
        purchasesHistory.push(newPurch);
        for (let newItem of newPurch.items) {
            const prodMatch = resolverProductoDeItemCompra(newItem);
            if (!prodMatch) continue;
            const costoNuevo = Number(newItem.costo);
            const costoCambio = !isNaN(costoNuevo) && costoNuevo !== Number(prodMatch.cost || 0);
            if (costoCambio) {
                prodMatch.cost = r2(costoNuevo);
                const mRet = prodMatch.marginRetail ?? 10, mWho = prodMatch.marginWholesale ?? 10;
                prodMatch.retailPrice = r2(costoNuevo * (1 + mRet / 100));
                prodMatch.wholesalePrice = r2(costoNuevo * (1 + mWho / 100));
            }
            await registrarMovimientoKardex(prodMatch.id, 'COMPRA', newItem.cantidad, `Factura ${facturaNum}`);
            if (costoCambio) {
                await localDB.products.put(prodMatch);
                await encolarSincronizacion('UPDATE', 'products', prodMatch);
                await registrarAuditoria('INVENTARIO', 'ACTUALIZAR_COSTO', `Actualizó costo de "${prodMatch.name}" a ${sysConfig.currency}${costoNuevo.toFixed(2)} (Factura ${facturaNum})`);
            }
        }
        if (tipoCompra === "credito") { let suppMatch = suppliers.find(s => (s.name||"").toLowerCase() === proveedorNombre.toLowerCase()); if(suppMatch) { suppMatch.debt = r2((suppMatch.debt || 0) + totalFactura); await localDB.suppliers.put(suppMatch); await encolarSincronizacion('UPDATE', 'suppliers', suppMatch); } else { const newSupp = { id: Date.now(), business_id: DEFAULT_BUSINESS_ID, name: proveedorNombre, contact: "-", phone: "-", debt: totalFactura, address: "", ruc: "", active: true }; suppliers.push(newSupp); await localDB.suppliers.put(newSupp); await encolarSincronizacion('INSERT', 'suppliers', newSupp); } }
        await registrarAuditoria('COMPRAS', 'NUEVA_COMPRA', `Registró factura de compra ${facturaNum} de "${proveedorNombre}"`);
    } 
    await localDB.purchases.put(newPurch); await encolarSincronizacion(pId ? 'UPDATE' : 'INSERT', 'purchases', newPurch); document.getElementById("purchaseModal")?.classList.add("hidden"); actualizarTablaCompras(); actualizarTablaInventario(); actualizarCatalogo(); renderDashboard(); showAlert(`Factura guardada correctamente.`); 
});

window.cancelarCompraForm = function() { showConfirm("¿Estás seguro de cancelar esta factura de compra?", () => { document.getElementById("purchaseModal").classList.add("hidden"); currentPurchaseCart = []; }); };

function actualizarTablaCompras() {
    const tbody = document.getElementById("purchasesTableBody");
    if (!tbody) return;
    if (purchasesHistory.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center">Sin registros.</td></tr>`;
        return;
    }
    tbody.innerHTML = [...purchasesHistory].reverse().map(purchase => {
        const itemCount = purchase.items ? purchase.items.length : 1;
        const pending = obtenerSaldoFactura("proveedor", purchase);
        const paymentStatus = purchase.tipo === "credito"
            ? pending > 0 ? `CRÉDITO · Pendiente ${sysConfig.currency}${pending.toFixed(2)}<br>Vence: ${purchase.vencimiento || "-"}` : "PAGADA"
            : "CONTADO";
        const statusColor = purchase.tipo === "credito" && pending > 0 ? "#856404" : "#155724";
        let statusHtml = `<span style="font-size:11px; font-weight:bold; color:${statusColor};">${paymentStatus}</span>`;
        if (purchase.anulada) statusHtml += `<br><span style="font-size:11px; font-weight:bold; color:#d32f2f;">ANULADA</span>`;
        const totalFormat = purchase.anulada ? `<del>${sysConfig.currency}${r2(purchase.total).toFixed(2)}</del>` : `${sysConfig.currency}${r2(purchase.total).toFixed(2)}`;
        const actionButtons = purchase.anulada
            ? `<button class="btn btn-sm btn-primary" onclick="window.verFacturaCompra('${purchase.id}')">Ver Factura</button>`
            : `<button class="btn btn-sm btn-primary" onclick="window.verFacturaCompra('${purchase.id}')">Ver Factura</button> <button class="btn btn-sm btn-danger" onclick="window.eliminarCompra('${purchase.id}')">Anular</button>`;
        const rowStyle = purchase.anulada ? `style="background-color:#fdf5f5; color:#888;"` : "";
        return `<tr ${rowStyle}><td>${escapeHtml(purchase.fecha)}</td><td><strong>${escapeHtml(purchase.factura)}</strong></td><td>${escapeHtml(purchase.proveedor)}</td><td>${itemCount} prod(s).</td><td style="color:#d32f2f; font-weight:bold;">${totalFormat}</td><td>${statusHtml}</td><td>${actionButtons}</td></tr>`;
    }).join("");
}

window.eliminarCompra = function(id) {
    if (blockPendingConnected()) return;
    if (!isAdmin(['purchasesView', 'historyView'])) { showAlert("No tiene permisos para anular compras."); return; }
    const compra = purchasesHistory.find(p => String(p.id) === String(id)); if (!compra || compra.anulada) return;
    showAnularRegistro("Anular Factura de Compra", `Factura ${compra.factura} — Proveedor: ${compra.proveedor} — Total: ${sysConfig.currency}${(compra.total||0).toFixed(2)}.`, async (motivo) => {
        if (obtenerTotalAbonadoFactura("proveedor", compra.id) > 0) { showAlert("Anule primero los pagos de esta factura antes de anular la compra."); return; }
        const faltantes = [];
        (compra.items || []).forEach(item => {
            const prod = resolverProductoDeItemCompra(item);
            if (prod && (prod.stock || 0) < item.cantidad) faltantes.push(`${prod.name} (stock ${prod.stock || 0}, factura ${item.cantidad})`);
        });
        if (faltantes.length) {
            showAlert("No se puede anular: ya se vendió parte de esta mercancía.\n" + faltantes.join("\n"));
            return;
        }
        if (compra.items) { for (let item of compra.items) { const prodMatch = resolverProductoDeItemCompra(item); if (prodMatch) { await registrarMovimientoKardex(prodMatch.id, 'ANULACION_COMPRA', -item.cantidad, `Anulación Factura ${compra.factura}: ${motivo}`); } } }
        if (compra.tipo === 'credito') { const suppMatch = suppliers.find(s => (s.name||"").toLowerCase() === (compra.proveedor||"").toLowerCase()); if (suppMatch) { suppMatch.debt = r2(Math.max(0, (suppMatch.debt || 0) - compra.total)); await localDB.suppliers.put(suppMatch); await encolarSincronizacion('UPDATE', 'suppliers', suppMatch); } }
        compra.anulada = true; compra.motivoAnulacion = motivo; compra.fechaAnulacion = new Date().toLocaleString(); compra.usuarioAnulacion = currentUser.displayName;
        await localDB.purchases.put(compra); await encolarSincronizacion('UPDATE', 'purchases', compra);
        await registrarAuditoria('COMPRAS', 'ANULACION', `Anuló Factura de Compra ${compra.factura}. Motivo: ${motivo}`);
        actualizarTablaCompras(); actualizarTablaInventario(); actualizarTablaCuentasPorPagar(); renderDashboard(); showAlert("Factura de compra anulada.");
    });
};

function actualizarTablaCuentasPorPagar() { const tb = document.getElementById("payablesTableBody"); if(!tb) return; const deudores = suppliers.filter(s => (s.debt||0) > 0); if(deudores.length === 0) { tb.innerHTML = `<tr><td colspan="6" class="text-center">No hay cuentas por pagar pendientes.</td></tr>`; } else { tb.innerHTML = deudores.map(s => { const facturasCredito = purchasesHistory.filter(p => p.proveedor === s.name && p.tipo === "credito" && !p.anulada && obtenerSaldoFactura("proveedor", p) > 0).sort((a,b) => new Date(a.vencimiento) - new Date(b.vencimiento)); const proxVencimiento = facturasCredito.length > 0 ? facturasCredito[0].vencimiento : 'Ver facturas'; return `<tr><td>${s.id}</td><td><strong>${escapeHtml(s.name)}</strong></td><td>${escapeHtml(s.phone) || '-'}</td><td style="color:#d32f2f; font-weight:bold;">${proxVencimiento}</td><td style="color:#d32f2f; font-weight:bold; font-size:1.1em;">${sysConfig.currency}${(s.debt||0).toFixed(2)}</td><td><button class="btn btn-sm btn-secondary" onclick="window.verEstadoCuentaProveedor('${s.id}')">Ver Facturas</button></td></tr>`; }).join(""); } }
window.abrirAbonoProveedor = function(id) { const s = suppliers.find(x => String(x.id) === String(id)); if(!s) return; document.getElementById("payableSupplierId").value = s.id; document.getElementById("payableSupplierName").textContent = s.name; document.getElementById("payableDebt").textContent = `${sysConfig.currency}${(s.debt||0).toFixed(2)}`; const pa = document.getElementById("payableAmount"); if(pa) pa.value = ""; document.getElementById("payablePaymentModal")?.classList.remove("hidden"); };
window.abrirAbonoFacturaProveedor = function(id) {
    const purchase = purchasesHistory.find(item => String(item.id) === String(id));
    if (!purchase || purchase.anulada || purchase.tipo !== "credito") return;
    const supplier = suppliers.find(item => (item.name || "").toLowerCase() === (purchase.proveedor || "").toLowerCase());
    if (!supplier) { showAlert("No se encontró el proveedor de esta factura."); return; }
    const pending = obtenerSaldoFactura("proveedor", purchase);
    document.getElementById("payInvoiceId").value = purchase.id;
    document.getElementById("payInvoiceNumero").textContent = purchase.factura || String(purchase.id);
    document.getElementById("payInvoiceProveedor").textContent = supplier.name;
    document.getElementById("payInvoiceTotal").textContent = `${sysConfig.currency}${r2(purchase.total).toFixed(2)}`;
    document.getElementById("payInvoicePaid").textContent = `${sysConfig.currency}${obtenerTotalAbonadoFactura("proveedor", purchase.id).toFixed(2)}`;
    document.getElementById("payInvoiceSaldo").textContent = `${sysConfig.currency}${pending.toFixed(2)}`;
    const amountInput = document.getElementById("payInvoiceAmount");
    if (amountInput) { amountInput.value = ""; amountInput.max = String(Math.min(pending, r2(supplier.debt || 0))); amountInput.disabled = pending <= 0 || r2(supplier.debt || 0) <= 0; }
    const submitButton = document.querySelector("#paymentInvoiceForm button[type='submit']");
    if (submitButton) submitButton.disabled = pending <= 0 || r2(supplier.debt || 0) <= 0;
    document.getElementById("paymentInvoiceModal")?.classList.remove("hidden");
};

document.getElementById("paymentInvoiceForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const purchaseId = document.getElementById("payInvoiceId").value;
    const purchase = purchasesHistory.find(item => String(item.id) === String(purchaseId));
    const supplier = purchase && suppliers.find(item => (item.name || "").toLowerCase() === (purchase.proveedor || "").toLowerCase());
    const amount = r2(parseFloat(document.getElementById("payInvoiceAmount").value));
    const metodoPago = document.getElementById("payInvoiceMethod")?.value || "efectivo";
    if (!purchase || purchase.anulada || !supplier) { showAlert("La factura o el proveedor ya no están disponibles."); return; }
    const pending = obtenerSaldoFactura("proveedor", purchase);
    if (!Number.isFinite(amount) || amount <= 0) { showAlert("Ingrese un monto de abono válido, mayor que cero."); return; }
    if (amount > pending || amount > r2(supplier.debt || 0)) { showAlert("El pago no puede ser mayor al saldo pendiente de la factura ni a la deuda del proveedor."); return; }
    if (metodoPago === "efectivo" && !cajaActual) { showAlert(MSG_SIN_CAJA); return; }

    const fechaTS = Date.now();
    const newAbono = { id: fechaTS, business_id: DEFAULT_BUSINESS_ID, tipo: "proveedor", referenciaId: supplier.id, facturaId: purchase.id, monto: amount, metodoPago, estado: "pendiente", fecha: new Date(fechaTS).toLocaleDateString(), fechaTS, usuario: currentUser.displayName, anulado: false };
    supplier.debt = r2((supplier.debt || 0) - amount);
    await localDB.suppliers.put(supplier);
    await encolarSincronizacion("UPDATE", "suppliers", supplier);
    abonosHistory.push(newAbono);
    await localDB.abonos.put(newAbono);
    await encolarSincronizacion("INSERT", "abonos", newAbono);
    if (metodoPago === "efectivo" && registrarMovimientoAbonoEnCaja("salida", amount, `Pago Factura ${purchase.factura}: ${supplier.name}`, newAbono)) {
        await localDB.cajaSessions.put(cajaActual);
        await encolarSincronizacion("UPDATE", "cajaSessions", cajaActual);
        renderCajaView();
    }
    await registrarAuditoria("PROVEEDORES", "PAGO_FACTURA", `Pagó ${sysConfig.currency}${amount.toFixed(2)} a la factura ${purchase.factura} (${metodoPago}) de "${supplier.name}"`);
    document.getElementById("paymentInvoiceModal")?.classList.add("hidden");
    actualizarTablaCuentasPorPagar();
    actualizarTablaProveedores();
    renderDashboard();
    if (document.getElementById("statementModalTitle")?.textContent.includes(supplier.name)) window.verEstadoCuentaProveedor(supplier.id);
    showAlert("Pago de factura registrado correctamente.");
});

document.getElementById("payablePaymentForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("payableSupplierId").value;
    const amount = r2(parseFloat(document.getElementById("payableAmount").value));
    const supplier = suppliers.find(item => String(item.id) === String(id));
    const metodoPago = document.getElementById("payableMethod")?.value || "efectivo";
    if (!supplier) return;
    if (!Number.isFinite(amount) || amount <= 0) { showAlert("Ingrese un monto de abono válido, mayor que cero."); return; }
    if (amount > r2(supplier.debt || 0)) { showAlert("El abono no puede ser mayor a la deuda."); return; }
    if (metodoPago === "efectivo" && !cajaActual) { showAlert(MSG_SIN_CAJA); return; }
    const fechaTS = Date.now();
    supplier.debt = r2((supplier.debt || 0) - amount);
    await localDB.suppliers.put(supplier);
    await encolarSincronizacion("UPDATE", "suppliers", supplier);
    const newAbono = { id: fechaTS, business_id: DEFAULT_BUSINESS_ID, tipo: "proveedor", referenciaId: supplier.id, monto: amount, metodoPago, fecha: new Date(fechaTS).toLocaleDateString(), fechaTS, usuario: currentUser.displayName, anulado: false };
    abonosHistory.push(newAbono);
    await localDB.abonos.put(newAbono);
    await encolarSincronizacion("INSERT", "abonos", newAbono);
    await registrarAuditoria("PROVEEDORES", "ABONO", `Registró abono de ${sysConfig.currency}${amount.toFixed(2)} al proveedor "${supplier.name}" (${metodoPago})`);
    if (metodoPago === "efectivo" && registrarMovimientoAbonoEnCaja("salida", amount, `Pago a proveedor: ${supplier.name}`, newAbono)) {
        await localDB.cajaSessions.put(cajaActual);
        await encolarSincronizacion("UPDATE", "cajaSessions", cajaActual);
        renderCajaView();
    }
    document.getElementById("payablePaymentModal")?.classList.add("hidden");
    actualizarTablaCuentasPorPagar(); renderDashboard();
    showAlert("Abono registrado.");
});

async function initCaja() { const todasCajas = await localDB.cajaSessions.where({ business_id: DEFAULT_BUSINESS_ID }).toArray(); cajaHistorial = todasCajas.sort((a, b) => b.fechaAperturaTS - a.fechaAperturaTS); cajaActual = todasCajas.find(s => s.estado === "abierta") || null; }
function calcularResumenCaja(session) {
    if (connectedMode) return { ventasContado: session.connectedSales || 0, entradas: 0, salidas: r2(session.movimientos.filter(m => m.tipo === "salida").reduce((sum, m) => sum + m.monto, 0)), esperado: session.connectedExpected };
    const desde = session.fechaAperturaTS;
    const hasta = session.fechaCierreTS || Date.now();
    const ventasContado = salesHistory.filter(venta => {
        const ts = venta.fechaTS || venta.id;
        return (venta.cajaSessionId ? String(venta.cajaSessionId) === String(session.id) : ts >= desde && ts <= hasta) && venta.metodo === "Contado" && obtenerMedioPagoVenta(venta) === "cash" && !venta.anulada;
    }).reduce((sum, venta) => sum + venta.total, 0);
    const entradas = session.movimientos.filter(mov => mov.tipo === "entrada" && !mov.anulado).reduce((sum, mov) => sum + mov.monto, 0);
    const salidas = session.movimientos.filter(mov => mov.tipo === "salida" && !mov.anulado).reduce((sum, mov) => sum + mov.monto, 0);
    const esperado = session.efectivoInicial + ventasContado + entradas - salidas;
    return { ventasContado: r2(ventasContado), entradas: r2(entradas), salidas: r2(salidas), esperado: r2(esperado) };
}
async function abrirCaja(efectivoInicial) {
    if (connectedMode) return window.PosSales.openCash(); if (cajaActual) { showAlert("Ya existe una caja abierta."); return; } if (isNaN(efectivoInicial) || efectivoInicial < 0) { showAlert("Ingrese un monto inicial válido."); return; } const nueva = { business_id: DEFAULT_BUSINESS_ID, estado: "abierta", usuarioApertura: currentUser.displayName, fechaAperturaTS: Date.now(), fechaApertura: new Date().toLocaleString(), efectivoInicial: efectivoInicial, movimientos: [], fechaCierreTS: null, fechaCierre: null, efectivoReal: null, efectivoEsperado: null, diferencia: null, usuarioCierre: null }; const id = await localDB.cajaSessions.add(nueva); nueva.id = id; cajaActual = nueva; cajaHistorial.unshift(nueva); await encolarSincronizacion("INSERT", "cajaSessions", nueva); await registrarAuditoria('CAJA', 'APERTURA', `Abrió caja con ${sysConfig.currency}${efectivoInicial.toFixed(2)}`); renderCajaView(); }
async function registrarMovimientoCaja(tipo, monto, concepto) {
    if (blockPendingConnected()) return; monto = r2(monto); if (!cajaActual) { showAlert("No hay una caja abierta."); return; } if (isNaN(monto) || monto <= 0) { showAlert("Ingrese un monto válido."); return; } if (!concepto || !concepto.trim()) { showAlert("Ingrese un concepto."); return; } cajaActual.movimientos.push({ id: Date.now() + Math.random(), cajaSessionId: cajaActual.id, tipo, monto, concepto: concepto.trim(), fechaTS: Date.now(), fecha: new Date().toLocaleString(), usuario: currentUser.displayName, estado: "pendiente", anulado: false }); await localDB.cajaSessions.put(cajaActual); await encolarSincronizacion("UPDATE", "cajaSessions", cajaActual); renderCajaView(); }
window.anularMovimientoCaja = async function(indexOriginal, sessionId) {
    if (blockPendingConnected()) return; if (!isAdmin('cajaView')) { showAlert("No tiene permisos."); return; } const session = sessionId ? cajaHistorial.find(item => String(item.id) === String(sessionId)) : cajaActual; const mov = session?.movimientos[indexOriginal]; if (!mov || mov.anulado) return; showAnularRegistro("Anular Movimiento de Caja", `${mov.tipo.toUpperCase()}: ${mov.concepto} (${sysConfig.currency}${mov.monto.toFixed(2)})`, async (motivo) => { mov.anulado = true; mov.motivoAnulacion = motivo; mov.usuarioAnulacion = currentUser.displayName; mov.fechaAnulacion = new Date().toLocaleString(); if (session.estado === "cerrada" && !session.resumenCierre) { const summary = calcularResumenCaja(session); session.efectivoEsperado = summary.esperado; session.diferencia = r2((session.efectivoReal || 0) - summary.esperado); } await localDB.cajaSessions.put(session); await encolarSincronizacion("UPDATE", "cajaSessions", session); renderCajaView(); showAlert("Movimiento anulado."); }); };
window.confirmarMovimientoCaja = async function(sessionId, index) {
    if (blockPendingConnected()) return; if (!isAdmin('cajaView')) { showAlert("No tiene permisos para confirmar movimientos."); return; } const session = cajaHistorial.find(item => String(item.id) === String(sessionId)); const mov = session?.movimientos[index]; if (mov?.saleId) return window.PosLocalFlow.confirmSale(mov.saleId); if (!mov || mov.anulado || mov.estado !== "pendiente") return; mov.estado = "confirmado"; mov.usuarioConfirmacion = currentUser.displayName; mov.fechaConfirmacion = new Date().toLocaleString(); await localDB.cajaSessions.put(session); await encolarSincronizacion("UPDATE", "cajaSessions", session); await registrarAuditoria("CAJA", "CONFIRMAR_MOVIMIENTO", `Confirmó ${mov.tipo} de ${sysConfig.currency}${r2(mov.monto).toFixed(2)}: ${mov.concepto}`); renderCajaView(); };
window.confirmarVentaCaja = async function(id) {
    if (blockPendingConnected()) return;
    return window.PosLocalFlow.confirmSale(id);
};

window.abrirCorreccionCaja = function(sessionId, index) {
    if (blockPendingConnected()) return; if (!isAdmin('cajaView')) { showAlert("Solo el administrador puede corregir movimientos."); return; } const session = cajaHistorial.find(item => String(item.id) === String(sessionId)); const mov = session?.movimientos[index]; if (!mov || mov.tipo !== "entrada" || mov.anulado) return; document.getElementById("cashCorrectionSessionId").value = session.id; document.getElementById("cashCorrectionMovementIndex").value = index; document.getElementById("cashCorrectionOldAmount").textContent = `${sysConfig.currency}${r2(mov.monto).toFixed(2)}`; document.getElementById("cashCorrectionNewAmount").value = r2(mov.monto).toFixed(2); document.getElementById("cashCorrectionReason").value = ""; document.getElementById("cashCorrectionModal")?.classList.remove("hidden"); };
document.getElementById("confirmCashCorrectionBtn")?.addEventListener("click", async () => {
    if (!isAdmin('cajaView')) { showAlert("Solo el administrador puede corregir movimientos."); return; }
    const sessionId = document.getElementById("cashCorrectionSessionId").value;
    const index = Number(document.getElementById("cashCorrectionMovementIndex").value);
    const newAmount = r2(parseFloat(document.getElementById("cashCorrectionNewAmount").value));
    const reason = document.getElementById("cashCorrectionReason").value.trim();
    const session = cajaHistorial.find(item => String(item.id) === String(sessionId));
    const mov = session?.movimientos[index];
    if (!mov || mov.tipo !== "entrada" || mov.anulado) return;
    if (!Number.isFinite(newAmount) || newAmount <= 0) { showAlert("Ingrese un nuevo monto válido, mayor que cero."); return; }
    if (!reason) { showAlert("Indique el motivo de la corrección."); return; }

    const previousAmount = r2(mov.monto);
    const fechaTS = Date.now();
    if (mov.montoOriginal === undefined) mov.montoOriginal = previousAmount;
    if (!Array.isArray(mov.correcciones)) mov.correcciones = [];
    const correction = { montoAnterior: previousAmount, montoNuevo: newAmount, diferencia: r2(newAmount - previousAmount), usuario: currentUser.displayName, fecha: new Date(fechaTS).toLocaleString(), fechaTS, motivo: reason, estado: "confirmado" };
    mov.correcciones.push(correction);
    mov.monto = newAmount;
    mov.estadoCorreccion = correction.estado;
    if (session.estado === "cerrada" && !session.resumenCierre) {
        const summary = calcularResumenCaja(session);
        session.efectivoEsperado = summary.esperado;
        session.diferencia = r2((session.efectivoReal || 0) - summary.esperado);
    }
    await localDB.cajaSessions.put(session);
    await encolarSincronizacion("UPDATE", "cajaSessions", session);
    await registrarAuditoria("CAJA", "CORRECCION_MOVIMIENTO", `Corrigió entrada de ${sysConfig.currency}${previousAmount.toFixed(2)} a ${sysConfig.currency}${newAmount.toFixed(2)} (diferencia ${sysConfig.currency}${correction.diferencia.toFixed(2)}). Motivo: ${reason}`);
    document.getElementById("cashCorrectionModal")?.classList.add("hidden");
    renderCajaView();
    showAlert("Corrección registrada; el valor original quedó en el historial.");
});

function detalleResumenLocal(session) {
    if (session.resumenCierre) return session.resumenCierre;
    const belongs = venta => venta.cajaSessionId ? String(venta.cajaSessionId) === String(session.id) : (venta.fechaTS || venta.id) >= session.fechaAperturaTS && (venta.fechaTS || venta.id) <= (session.fechaCierreTS || Date.now());
    const sales = salesHistory.filter(v => belongs(v) && !v.anulada);
    const sum = rows => r2(rows.reduce((n, v) => n + Number(v.monto ?? v.total ?? 0), 0));
    const movements = (session.movimientos || []).filter(m => !m.anulado && m.estado !== 'void' && (!m.medioPago || m.medioPago === 'CASH'));
    const out = movements.filter(m => m.tipo === 'salida');
    const expenses = out.filter(m => (m.concepto || '').startsWith('Gasto:'));
    const purchases = out.filter(m => m.referenciaCompraId);
    const collections = movements.filter(m => m.tipo === 'entrada' && m.referenciaAbonoId);
    return { cashSales: sum(sales.filter(v => v.metodo === 'Contado' && obtenerMedioPagoVenta(v) === 'cash')), creditSales: sum(sales.filter(v => v.metodo === 'Crédito')), cardSales: sum(sales.filter(v => obtenerMedioPagoVenta(v) === 'card')), transferSales: sum(sales.filter(v => obtenerMedioPagoVenta(v) === 'transfer')), expenses: sum(expenses), purchases: sum(purchases), withdrawals: sum(out.filter(m => !expenses.includes(m) && !purchases.includes(m))), cashReturns: 0, cashCollections: sum(collections), otherCash: sum(movements.filter(m => m.tipo === 'entrada' && !collections.includes(m))) };
}
const cashCloseMoney = value => 'C$ ' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function pintarResumenCierre(target, data, details = false) {
    const root = document.getElementById(target); root.replaceChildren();
    const add = (label, value) => { const row = document.createElement('div'); row.className = 'cash-close-row'; const name = document.createElement('span'); name.textContent = label; const amount = document.createElement('strong'); amount.textContent = value; row.append(name, amount); root.append(row); };
    add('Fecha y hora de apertura', data.openedAt); add(details ? 'Fecha y hora de cierre' : 'Fecha y hora de cierre (prevista)', data.closedAt); add('Gestor que cierra', data.closedBy);
    const summary = data.summary;
    for (const [label, key, sign] of [['Efectivo inicial','openingAmount','+'],['Ventas de contado en efectivo','cashSales','+'],['Ventas de crédito','creditSales',''],['Ventas por transferencia','transferSales',''],['Ventas por tarjeta','cardSales',''],['Abonos en efectivo','cashCollections','+'],['Otras entradas en efectivo','otherCash','+'],['Gastos en efectivo','expenses','−'],['Salidas manuales / pagos en efectivo','withdrawals','−'],['Compras en efectivo','purchases','−'],['Devoluciones en efectivo','cashReturns','−']]) add(label, (sign ? '(' + sign + ') ' : '') + cashCloseMoney(key === 'openingAmount' ? data.openingAmount : summary[key]));
    add('Efectivo final esperado', cashCloseMoney(data.expectedAmount));
    if (details) { add('Efectivo real contado', cashCloseMoney(data.countedAmount)); add('Diferencia', cashCloseMoney(data.difference)); }
    const note = document.createElement('p'); note.className = 'cash-close-note'; note.textContent = 'Crédito, tarjeta y transferencia son informativos y no suman al efectivo físico. Compras muestra únicamente salidas de efectivo registradas en Caja; compras conectadas pendiente.'; root.append(note);
}
function datosCierreLocal(session) { return { summary: detalleResumenLocal(session), openingAmount: session.efectivoInicial, expectedAmount: session.efectivoEsperado ?? calcularResumenCaja(session).esperado, countedAmount: session.efectivoReal, difference: session.diferencia, openedAt: session.fechaApertura, closedAt: session.fechaCierre || new Date().toLocaleString(), closedBy: session.usuarioCierre || currentUser.displayName }; }
window.PosCashSummary = { open(data) { pintarResumenCierre('cajaCierreResumen', data); document.getElementById('cajaEsperadoDisplay').textContent = cashCloseMoney(data.expectedAmount); document.getElementById('cajaEfectivoRealInput').value = ''; document.getElementById('cajaEfectivoRealInput').dataset.expected = data.expectedAmount; actualizarDiferenciaCierre(); document.getElementById('cierreCajaModal').classList.remove('hidden'); document.getElementById('cierreCajaModal').querySelector('[data-initial-focus]').focus(); document.getElementById('cierreCajaModal').querySelector('.modal-card').scrollTop = 0; } };
function actualizarDiferenciaCierre() {
    const input = document.getElementById('cajaEfectivoRealInput'); const valid = /^\d+(?:\.\d{1,2})?$/.test(input.value) && Number.isFinite(Number(input.value));
    document.getElementById('confirmCierreCajaBtn').disabled = !valid;
    const difference = r2(Number(input.value) - Number(input.dataset.expected)); const status = document.getElementById('cajaCierreDiferencia'); status.textContent = valid ? 'Diferencia: ' + (difference > 0 ? '+' : '') + cashCloseMoney(difference) + (difference < 0 ? ' · Faltante' : difference > 0 ? ' · Sobrante' : ' · Sin diferencia') : 'Ingrese el efectivo real contado.';
}
document.getElementById('cajaEfectivoRealInput').addEventListener('input', actualizarDiferenciaCierre);
document.getElementById('cajaHistorialBody').addEventListener('click', event => { const button = event.target.closest('[data-cash-detail]'); if (!button) return; const session = cajaHistorial.find(s => String(s.id) === button.dataset.cashDetail); if (!session) return; pintarResumenCierre('cajaDetalleResumen', connectedMode ? session.connectedCloseData : datosCierreLocal(session), true); document.getElementById('detalleCierreCajaModal').classList.remove('hidden'); });

async function cerrarCaja(efectivoReal) {
    if (connectedMode) return window.PosSales.closeCash(); if (!cajaActual) return; efectivoReal = r2(efectivoReal); const resumen = calcularResumenCaja(cajaActual); const diferencia = r2(efectivoReal - resumen.esperado); cajaActual.resumenCierre = detalleResumenLocal(cajaActual); cajaActual.estado = "cerrada"; cajaActual.fechaCierreTS = Date.now(); cajaActual.fechaCierre = new Date().toLocaleString(); cajaActual.efectivoReal = efectivoReal; cajaActual.efectivoEsperado = resumen.esperado; cajaActual.diferencia = diferencia; cajaActual.usuarioCierre = currentUser.displayName; await localDB.cajaSessions.put(cajaActual); await encolarSincronizacion("UPDATE", "cajaSessions", cajaActual); cajaActual = null; await initCaja(); renderCajaView(); showAlert(`Caja cerrada exitosamente.`); }
document.getElementById("abrirCajaBtn")?.addEventListener("click", () => { if (connectedMode) { window.PosSales.openCash(); return; } const inputEl = document.getElementById("cajaEfectivoInicialInput"); const inicial = parseFloat(inputEl?.value); if (isNaN(inicial) || inicial < 0) { showAlert("⚠️ Ingrese el monto de efectivo inicial con el que abre la caja."); inputEl?.focus(); return; } abrirCaja(inicial); if (inputEl) inputEl.value = ""; });
document.getElementById("registrarEntradaBtn")?.addEventListener("click", () => { const monto = parseFloat(document.getElementById("cajaMovimientoMonto")?.value); const concepto = document.getElementById("cajaMovimientoConcepto")?.value; registrarMovimientoCaja("entrada", monto, concepto); document.getElementById("cajaMovimientoMonto").value = ""; document.getElementById("cajaMovimientoConcepto").value = ""; });
document.getElementById("registrarSalidaBtn")?.addEventListener("click", () => { const monto = parseFloat(document.getElementById("cajaMovimientoMonto")?.value); const concepto = document.getElementById("cajaMovimientoConcepto")?.value; registrarMovimientoCaja("salida", monto, concepto); document.getElementById("cajaMovimientoMonto").value = ""; document.getElementById("cajaMovimientoConcepto").value = ""; });
document.getElementById("cerrarCajaBtn")?.addEventListener("click", () => {
    if (connectedMode) { window.PosSales.closeDialog(); return; }
    if (!cajaActual) { showAlert("No hay ninguna caja abierta en este momento."); return; }

    window.PosCashSummary.open(datosCierreLocal(cajaActual));
});

document.getElementById("confirmCierreCajaBtn")?.addEventListener("click", () => {
    if (connectedMode) { window.PosSales.closeCash(); return; }
    if (!cajaActual) return;

    const inputEl = document.getElementById("cajaEfectivoRealInput");
    const real = parseFloat(inputEl?.value);

    if (!Number.isFinite(real) || real < 0 || !/^\d+(?:\.\d{1,2})?$/.test(inputEl.value)) {
        showAlert("Ingrese el monto real de efectivo contado.");
        inputEl?.focus();
        return;
    }

    cerrarCaja(real);
    document.getElementById("cierreCajaModal")?.classList.add("hidden");

    if (inputEl) inputEl.value = "";
});
function renderCajaViewBase() { const boxAbrir = document.getElementById("cajaAbrirBox"); const boxAbierta = document.getElementById("cajaAbiertaBox"); if (!boxAbrir || !boxAbierta) return; if (!cajaActual) { boxAbrir.classList.remove("hidden"); boxAbierta.classList.add("hidden"); const ultimaCaja = cajaHistorial.find(s => s.estado === "cerrada"); const hintEl = document.getElementById("cajaEfectivoInicialHint"); if (hintEl) hintEl.textContent = ultimaCaja ? `Referencia: el cierre anterior esperaba ${sysConfig.currency}${(ultimaCaja.efectivoEsperado || 0).toFixed(2)}. Escriba el monto real que recibe.` : "Escriba el monto real de efectivo que recibe para iniciar el turno."; } else { boxAbrir.classList.add("hidden"); boxAbierta.classList.remove("hidden"); const resumen = calcularResumenCaja(cajaActual); const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; }; set("cajaUsuarioApertura", cajaActual.usuarioApertura); set("cajaFechaApertura", cajaActual.fechaApertura); set("cajaResumenInicial", `${sysConfig.currency}${cajaActual.efectivoInicial.toFixed(2)}`); set("cajaResumenVentas", `${sysConfig.currency}${resumen.ventasContado.toFixed(2)}`); set("cajaResumenEntradas", `${sysConfig.currency}${resumen.entradas.toFixed(2)}`); set("cajaResumenSalidas", `${sysConfig.currency}${resumen.salidas.toFixed(2)}`); set("cajaResumenEsperado", `${sysConfig.currency}${resumen.esperado.toFixed(2)}`); const movBody = document.getElementById("cajaMovimientosBody"); if (movBody) { if (cajaActual.movimientos.length === 0) { movBody.innerHTML = `<tr><td colspan="7" class="text-center">Sin movimientos registrados.</td></tr>`; } else { movBody.innerHTML = cajaActual.movimientos.map(m => { const icon = m.medioPago === "CASH" ? "Efectivo" : m.medioPago === "CARD" ? "Tarjeta" : m.medioPago === "TRANSFER" ? "Transferencia" : m.tipo === "entrada" ? "🟢 Entrada" : "🔴 Salida"; const valFmt = m.anulado ? `<del>${sysConfig.currency}${(m.monto||0).toFixed(2)}</del>` : `${sysConfig.currency}${(m.monto||0).toFixed(2)}`; return `<tr><td>${m.fecha}</td><td>${icon}</td><td>${escapeHtml(m.concepto)}</td><td>${valFmt}</td><td>${escapeHtml(m.usuario)}</td><td>${m.estado === "pendiente" ? "Pendiente de confirmación" : m.estado === "confirmado" ? "Confirmado" : m.estado === "void" ? "Anulado" : m.estado || "Registrado"}</td><td></td></tr>`; }).reverse().join(""); } } } const histBody = document.getElementById("cajaHistorialBody"); if (histBody) { const cerradas = cajaHistorial.filter(s => s.estado === "cerrada"); histBody.innerHTML = cerradas.length === 0 ? `<tr><td colspan="8" class="text-center">Sin cierres registrados.</td></tr>` : cerradas.map(s => { const difColor = s.diferencia === 0 ? "#28a745" : "#d32f2f"; return `<tr><td>${s.fechaApertura}</td><td>${s.fechaCierre}</td><td>${escapeHtml(s.usuarioCierre)}</td><td>${cashCloseMoney(s.efectivoInicial)}</td><td>${cashCloseMoney(s.efectivoEsperado)}</td><td>${cashCloseMoney(s.efectivoReal)}</td><td style="color:${difColor}; font-weight:bold;">${cashCloseMoney(s.diferencia)}</td><td><button type="button" class="btn btn-sm btn-secondary" data-cash-detail="${escapeHtml(String(s.id))}">Detalles</button></td></tr>`; }).join(""); } }

window.confirmarAbonoCaja = async function(id) {
    if (blockPendingConnected()) return; if (!isAdmin('cajaView')) { showAlert("No tiene permisos para confirmar pagos."); return; } const abono = abonosHistory.find(item => String(item.id) === String(id)); if (!abono || abono.anulado || abono.estado !== "pendiente") return; abono.estado = "confirmado"; abono.usuarioConfirmacion = currentUser.displayName; abono.fechaConfirmacion = new Date().toLocaleString(); await localDB.abonos.put(abono); await encolarSincronizacion("UPDATE", "abonos", abono); for (const session of cajaHistorial) { let changed = false; (session.movimientos || []).forEach(mov => { if (String(mov.referenciaAbonoId) === String(abono.id) && mov.estado === "pendiente") { mov.estado = "confirmado"; mov.usuarioConfirmacion = currentUser.displayName; mov.fechaConfirmacion = abono.fechaConfirmacion; changed = true; } }); if (changed) { await localDB.cajaSessions.put(session); await encolarSincronizacion("UPDATE", "cajaSessions", session); } } await registrarAuditoria("CAJA", "CONFIRMAR_ABONO", `Confirmó ${abono.tipo === "cliente" ? "cobro" : "pago"} de ${sysConfig.currency}${r2(abono.monto).toFixed(2)} (${abono.metodoPago || "medio no registrado"})`); renderCajaView(); };

function renderCajaCentral() {
    const sessionId = cajaActual?.id;
    const inCurrentSession = record => {
        if (!cajaActual || !record) return false;
        if (record.cajaSessionId !== undefined && record.cajaSessionId !== null) return String(record.cajaSessionId) === String(sessionId);
        const timestamp = Number(record.fechaTS || record.createdAt || 0);
        return timestamp >= Number(cajaActual.fechaAperturaTS || 0);
    };
    const validSales = cajaActual ? salesHistory.filter(sale => !sale.anulada && inCurrentSession(sale)) : [];
    const validClientPayments = cajaActual ? abonosHistory.filter(abono => abono.tipo === "cliente" && !abono.anulado && inCurrentSession(abono)) : [];
    const scopedSales = cajaActual ? validSales : salesHistory.filter(sale => !sale.anulada);
    const scopedAbonos = cajaActual ? abonosHistory.filter(abono => !abono.anulado && inCurrentSession(abono)) : abonosHistory.filter(abono => !abono.anulado);
    const activeSummary = cajaActual ? calcularResumenCaja(cajaActual) : null;
    const set = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
    const money = value => `${sysConfig.currency}${r2(value).toFixed(2)}`;
    set("cajaCentralVentas", money(validSales.reduce((sum, sale) => sum + (Number(sale.total) || 0), 0)));
    set("cajaCentralCobros", money(validClientPayments.reduce((sum, abono) => sum + (Number(abono.monto) || 0), 0)));
    set("cajaCentralEsperado", money(activeSummary?.esperado || 0));
    set("cajaCentralDiferencia", money(activeSummary?.diferencia || 0));

    const userTotals = new Map();
    validSales.forEach(sale => {
        const name = sale.vendedor || "Desconocido";
        if (!userTotals.has(name)) userTotals.set(name, { count: 0, total: 0, cash: 0, card: 0, transfer: 0, credit: 0, collections: 0 });
        const totals = userTotals.get(name);
        totals.count++;
        totals.total += Number(sale.total) || 0;
        const methodKey = obtenerMedioPagoVenta(sale);
        if (methodKey) totals[methodKey] += Number(sale.total) || 0;
    });
    validClientPayments.forEach(abono => {
        const name = abono.usuario || "Desconocido";
        if (!userTotals.has(name)) userTotals.set(name, { count: 0, total: 0, cash: 0, card: 0, transfer: 0, credit: 0, collections: 0 });
        userTotals.get(name).collections += Number(abono.monto) || 0;
    });
    const userBody = document.getElementById("cajaVentasUsuarioBody");
    if (userBody) {
        const rows = [...userTotals.entries()].sort((a, b) => b[1].total - a[1].total);
        userBody.innerHTML = rows.length ? rows.map(([name, totals]) => `<tr><td><strong>${escapeHtml(name)}</strong></td><td>${totals.count}</td><td>${money(totals.cash)}</td><td>${money(totals.card)}</td><td>${money(totals.transfer)}</td><td>${money(totals.credit)}</td><td>${money(totals.collections)}</td><td><strong>${money(totals.total)}</strong></td></tr>`).join("") : `<tr><td colspan="8" class="text-center">Sin operaciones registradas.</td></tr>`;
    }

    const scopeLabel = cajaActual ? "sesión actual" : "historial general";
    set("cajaOperacionesTitulo", `Operaciones para revisión (${scopeLabel})`);
    set("cajaMovimientosTitulo", `Movimientos de efectivo (${scopeLabel})`);
    const accurateScopeLabel = cajaActual ? "sesión actual" : "historial general";
    set("cajaOperacionesTitulo", `Operaciones para revisión (${accurateScopeLabel})`);
    set("cajaMovimientosTitulo", `Movimientos de efectivo (${accurateScopeLabel})`);
    const displayScopeLabel = cajaActual ? "sesi\u00f3n actual" : "historial general";
    set("cajaOperacionesTitulo", `Operaciones para revisi\u00f3n (${displayScopeLabel})`);
    set("cajaMovimientosTitulo", `Movimientos de efectivo (${displayScopeLabel})`);
    const visibleOperationTitle = [...document.querySelectorAll("#cajaCentralBox h3")].find(element => element !== document.getElementById("cajaOperacionesTitulo") && element.textContent.trim().startsWith("Operaciones"));
    if (visibleOperationTitle) visibleOperationTitle.textContent = `Operaciones para revisi\u00f3n (${displayScopeLabel})`;
    if (visibleOperationTitle) visibleOperationTitle.textContent = `Operaciones para revisión (${accurateScopeLabel})`;
    if (visibleOperationTitle) visibleOperationTitle.textContent = `Operaciones para revisi\u00f3n (${displayScopeLabel})`;
    const operations = [
        ...validSales.filter(sale => sale.metodo !== "Crédito").map(sale => ({ type: "Venta", reference: `Factura #${sale.numero}`, date: sale.fecha, ts: sale.fechaTS || sale.id, user: sale.vendedor, method: mediosPagoVenta[obtenerMedioPagoVenta(sale)] || sale.metodo, amount: sale.total, status: sale.estadoCaja || "registrada", id: sale.id, kind: "sale" })),
        ...scopedSales.filter(sale => obtenerMedioPagoVenta(sale) === "credit" || !validSales.includes(sale)).map(sale => ({ type: "Venta", reference: `Factura #${sale.numero}`, date: sale.fecha, ts: sale.fechaTS || sale.id, user: sale.vendedor, method: mediosPagoVenta[obtenerMedioPagoVenta(sale)] || sale.metodo, amount: sale.total, status: sale.estadoCaja || "registrada", id: sale.id, kind: "sale" })),
        ...scopedAbonos.map(abono => {
            const isClientPayment = abono.tipo === "cliente";
            const invoice = isClientPayment
                ? salesHistory.find(sale => String(sale.id) === String(abono.facturaId))
                : purchasesHistory.find(purchase => String(purchase.id) === String(abono.facturaId));
            const account = isClientPayment
                ? clients.find(client => String(client.id) === String(abono.referenciaId))
                : suppliers.find(supplier => String(supplier.id) === String(abono.referenciaId));
            return { type: isClientPayment ? "Cobro" : "Pago a proveedor", reference: invoice ? `Factura ${isClientPayment ? `#${invoice.numero}` : invoice.factura}` : account?.name || "Sin referencia", date: new Date(abono.fechaTS || abono.id).toLocaleString(), ts: abono.fechaTS || abono.id, user: abono.usuario, method: abono.metodoPago || "No indicado", amount: abono.monto, status: abono.estado || "registrado", id: abono.id, kind: "abono" };
        })
    ].sort((a, b) => Number(b.ts) - Number(a.ts));
    const operationBody = document.getElementById("cajaOperacionesBody");
    if (operationBody) operationBody.innerHTML = operations.length ? operations.map(operation => {
        const pending = operation.status === "pendiente";
        const action = pending && isAdmin('cajaView') ? `<button class="btn btn-sm btn-success" onclick="window.${operation.kind === "sale" ? "confirmarVentaCaja" : "confirmarAbonoCaja"}('${escapeHtml(operation.id)}')">Confirmar</button>` : "-";
        const status = pending ? "Pendiente" : operation.status === "confirmado" ? "Confirmado" : "Registrado";
        return `<tr><td>${escapeHtml(operation.date)}</td><td>${operation.type}<br><small>${escapeHtml(operation.reference)}</small></td><td>${escapeHtml(operation.user)}</td><td>${escapeHtml(operation.method)}</td><td>${money(operation.amount)}</td><td>${status}</td><td>${action}</td></tr>`;
    }).join("") : `<tr><td colspan="7" class="text-center">Sin operaciones por revisar.</td></tr>`;

    const movementBody = document.getElementById("cajaMovimientosBody");
    if (!movementBody) return;
    const movements = cajaActual
        ? (cajaActual.movimientos || []).map((movement, index) => ({ session: cajaActual, movement, index }))
        : cajaHistorial.flatMap(session => (session.movimientos || []).map((movement, index) => ({ session, movement, index })));
    movements.sort((a, b) => (b.movement.fechaTS || 0) - (a.movement.fechaTS || 0));
    movementBody.innerHTML = movements.length ? movements.map(({ session, movement, index }) => {
        const status = movement.anulado ? "Anulado" : movement.estado === "pendiente" ? "Pendiente" : movement.estado === "confirmado" ? "Confirmado" : "Registrado";
        const value = movement.anulado ? `<del>${money(movement.monto)}</del>` : money(movement.monto);
        const correctionDetails = (movement.correcciones || []).map(correction => `<small>Original: ${money(movement.montoOriginal)}; nuevo: ${money(correction.montoNuevo)}; diferencia: ${money(correction.diferencia)}; ${escapeHtml(correction.motivo)}; ${escapeHtml(correction.usuario)} · ${escapeHtml(correction.fecha)} · ${escapeHtml(correction.estado)}</small>`).join("<br>");
        const confirmButton = !movement.anulado && movement.estado === "pendiente" && isAdmin('cajaView') ? `<button class="btn btn-sm btn-success" onclick="window.confirmarMovimientoCaja('${session.id}', ${index})">Confirmar</button>` : "";
        const correctButton = !movement.saleId && !movement.anulado && movement.tipo === "entrada" && isAdmin('cajaView') ? `<button class="btn btn-sm btn-secondary" onclick="window.abrirCorreccionCaja('${session.id}', ${index})">Corregir</button>` : "";
        const cancelButton = !movement.saleId && !movement.anulado && isAdmin('cajaView') ? `<button class="btn btn-sm btn-danger" onclick="window.anularMovimientoCaja(${index}, '${session.id}')">Anular</button>` : "";
        return `<tr style="${movement.anulado ? "background-color:#fdf5f5;color:#888;" : ""}"><td>${escapeHtml(movement.fecha)}</td><td>${movement.tipo === "venta" ? mediosPagoVenta[movement.medioPago] || "Venta" : movement.tipo === "entrada" ? "Entrada" : "Salida"}</td><td>${escapeHtml(movement.concepto)}${correctionDetails ? `<br>${correctionDetails}` : ""}</td><td style="font-weight:bold;">${value}${movement.montoOriginal !== undefined ? `<br><small>Original: ${money(movement.montoOriginal)}</small>` : ""}</td><td>${escapeHtml(movement.usuario)}</td><td>${status}${movement.estadoCorreccion ? `<br>Corrección ${escapeHtml(movement.estadoCorreccion)}` : ""}</td><td>${confirmButton} ${correctButton} ${cancelButton}</td></tr>`;
    }).join("") : `<tr><td colspan="7" class="text-center">Sin movimientos registrados.</td></tr>`;
}

function renderCajaView() { if (connectedMode) { window.PosSales?.renderCash(); return; } renderCajaViewBase(); renderCajaCentral(); window.PosLocalFlow?.render(); }

function renderGastosSelect() { const sel = document.getElementById("gastoCategoria"); if (sel && sel.options.length === 0) sel.innerHTML = GASTOS_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join(""); }
window.registrarGastoSubmit = async function() {
    if (blockPendingConnected()) return;
    const categoria = document.getElementById("gastoCategoria").value;
    const metodo = document.getElementById("gastoMetodo").value;
    const descripcion = document.getElementById("gastoDescripcion").value.trim();
    const comprobante = document.getElementById("gastoComprobante").value.trim() || "S/F";
    const monto = r2(parseFloat(document.getElementById("gastoMonto").value));
    if (!descripcion) { showAlert("Ingrese una descripción válida."); return; }
    if (isNaN(monto) || monto <= 0) { showAlert("Ingrese un monto válido."); return; }
    if (metodo === "caja" && !cajaActual) { showAlert("No hay caja abierta."); return; }
    const nuevoGasto = { id: Date.now(), business_id: DEFAULT_BUSINESS_ID, categoria, metodo, comprobante, monto, descripcion, fecha: new Date().toLocaleString(), fechaTS: Date.now(), usuario: currentUser ? currentUser.displayName : "Sistema", sessionId: cajaActual ? cajaActual.id : null, anulado: false };
    gastosHistory.push(nuevoGasto);
    await localDB.gastos.put(nuevoGasto);
    await encolarSincronizacion("INSERT", "gastos", nuevoGasto);
    if (metodo === "caja") {
        cajaActual.movimientos.push({ tipo: "salida", monto, cajaSessionId: cajaActual.id, concepto: `Gasto: ${categoria} - ${descripcion}`, fechaTS: Date.now(), fecha: new Date().toLocaleString(), usuario: currentUser ? currentUser.displayName : "Sistema" });
        await localDB.cajaSessions.put(cajaActual);
        await encolarSincronizacion("UPDATE", "cajaSessions", cajaActual);
        renderCajaView();
    }
    document.getElementById("formRegistrarGasto")?.reset();
    renderGastosView();
    actualizarTablaHistorial();
    renderDashboard();
    showAlert("Gasto registrado.");
};
window.eliminarGasto = function(id) {
    if (blockPendingConnected()) return;
    if (!isAdmin('gastosView')) { showAlert("No tiene permisos."); return; }
    const gasto = gastosHistory.find(g => String(g.id) === String(id));
    if (!gasto || gasto.anulado) return;
    showAnularRegistro("Anular Gasto", `${gasto.categoria} — ${gasto.descripcion} — Monto: ${sysConfig.currency}${(gasto.monto||0).toFixed(2)}.`, async (motivo) => {
        if (gasto.metodo === "caja" && gasto.sessionId !== null && gasto.sessionId !== undefined) {
            const session = cajaHistorial.find(item => String(item.id) === String(gasto.sessionId));
            if (session) {
                session.movimientos.push({ tipo: "entrada", monto: gasto.monto, cajaSessionId: session.id, concepto: `Anulación Gasto: ${gasto.descripcion} (${motivo})`, fechaTS: Date.now(), fecha: new Date().toLocaleString(), usuario: currentUser ? currentUser.displayName : "Sistema" });
                if (session.estado === "cerrada" && !session.resumenCierre) {
                    const summary = calcularResumenCaja(session);
                    session.efectivoEsperado = summary.esperado;
                    session.diferencia = r2((session.efectivoReal || 0) - summary.esperado);
                }
                await localDB.cajaSessions.put(session);
                await encolarSincronizacion("UPDATE", "cajaSessions", session);
                renderCajaView();
            }
        }
        gasto.anulado = true;
        gasto.motivoAnulacion = motivo;
        gasto.fechaAnulacion = new Date().toLocaleString();
        gasto.usuarioAnulacion = currentUser.displayName;
        await localDB.gastos.put(gasto);
        await encolarSincronizacion("UPDATE", "gastos", gasto);
        renderGastosView();
        actualizarTablaHistorial();
        renderDashboard();
        showAlert("Gasto anulado.");
    });
};
function renderGastosView() { renderGastosSelect(); const tbody = document.getElementById("gastosTableBody"); if (tbody) { if (gastosHistory.length === 0) { tbody.innerHTML = `<tr><td colspan="7" class="text-center">Sin gastos registrados.</td></tr>`; } else { tbody.innerHTML = [...gastosHistory].reverse().map(g => { const metodoHtml = g.metodo === 'caja' ? '💵 Caja' : (g.metodo === 'banco' ? '💳 Banco' : '⏳ Pendiente'); const anuladoTag = g.anulado ? ' <span style="color:#d32f2f; font-weight:bold; font-size:11px;">❌ ANULADO</span>' : ''; const totalFormat = g.anulado ? `<del>${sysConfig.currency}${r2(g.monto).toFixed(2)}</del>` : `${sysConfig.currency}${r2(g.monto).toFixed(2)}`; const actionBtn = g.anulado ? '-' : `<button class="btn btn-sm btn-danger" onclick="window.eliminarGasto('${g.id}')">Anular</button>`; const trStyle = g.anulado ? 'style="background-color:#fdf5f5; color:#888;"' : ''; return `<tr ${trStyle}><td>${escapeHtml(g.fecha)}</td><td><strong>${escapeHtml(g.categoria)}</strong></td><td>${escapeHtml(g.descripcion)}${anuladoTag}</td><td>${metodoHtml}<br><small style="color:#666;">Ref: ${escapeHtml(g.comprobante)}</small></td><td style="color:#d32f2f; font-weight:bold; font-size:1.1em;">${totalFormat}</td><td>${escapeHtml(g.usuario)}</td><td>${actionBtn}</td></tr>`; }).join(""); } } const totalHoy = gastosHistory.filter(g => !g.anulado && esHoyTS(g.fechaTS)).reduce((sum, g) => sum + g.monto, 0); const totalGeneral = gastosHistory.filter(g => !g.anulado).reduce((sum, g) => sum + g.monto, 0); if (document.getElementById("gastosResumenHoy")) document.getElementById("gastosResumenHoy").textContent = `${sysConfig.currency}${r2(totalHoy).toFixed(2)}`; if (document.getElementById("gastosResumenTotal")) document.getElementById("gastosResumenTotal").textContent = `${sysConfig.currency}${r2(totalGeneral).toFixed(2)}`; }

document.querySelectorAll(".rep-subtab").forEach(btn => { btn.addEventListener("click", (e) => { e.stopPropagation(); document.querySelectorAll(".rep-subtab").forEach(b => b.classList.remove("active")); document.querySelectorAll(".rep-subview").forEach(s => s.classList.add("hidden")); btn.classList.add("active"); document.getElementById(btn.dataset.target)?.classList.remove("hidden"); }); });
function initReportesFiltros() {
    const desdeInput = document.getElementById("reporteDesdeInput"), hastaInput = document.getElementById("reporteHastaInput");
    if (!desdeInput || !hastaInput) return;
    const hoy = new Date();
    if (!desdeInput.value) desdeInput.value = fechaLocalISO(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
    if (!reporteHastaManual) hastaInput.value = fechaLocalISO(hoy);
    aplicarFiltroReporte();
}
function setRangoFechasReporte(desdeDate, hastaDate) {
    const desdeInput = document.getElementById("reporteDesdeInput"), hastaInput = document.getElementById("reporteHastaInput");
    if (desdeInput) desdeInput.value = fechaLocalISO(desdeDate);
    if (hastaInput) hastaInput.value = fechaLocalISO(hastaDate);
    reporteHastaManual = false;
    aplicarFiltroReporte();
}
document.getElementById("reporteHastaInput")?.addEventListener("change", () => { reporteHastaManual = true; });
function aplicarFiltroReporte() { const desdeVal = document.getElementById("reporteDesdeInput")?.value; const hastaVal = document.getElementById("reporteHastaInput")?.value; reporteDesdeTS = desdeVal ? new Date(desdeVal + "T00:00:00").getTime() : 0; reporteHastaTS = hastaVal ? new Date(hastaVal + "T23:59:59").getTime() : Date.now(); const label = document.getElementById("reporteRangoLabel"); if (label) label.textContent = `Mostrando datos desde ${desdeVal || 'el inicio'} hasta ${hastaVal || 'hoy'}.`; renderReportes(); }
document.getElementById("aplicarFiltroReporteBtn")?.addEventListener("click", aplicarFiltroReporte);
document.getElementById("filtroHoyBtn")?.addEventListener("click", () => { const hoy = new Date(); setRangoFechasReporte(hoy, hoy); });
document.getElementById("filtroSemanaBtn")?.addEventListener("click", () => { const hoy = new Date(); const inicio = new Date(hoy); inicio.setDate(hoy.getDate() - hoy.getDay()); setRangoFechasReporte(inicio, hoy); });
document.getElementById("filtroMesBtn")?.addEventListener("click", () => { const hoy = new Date(); const inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1); setRangoFechasReporte(inicio, hoy); });
document.getElementById("filtroTodoBtn")?.addEventListener("click", () => { const inicio = new Date(2000, 0, 1); const hoy = new Date(); setRangoFechasReporte(inicio, hoy); });
function renderReportes() {
    if (reporteDesdeTS === null) return;
    const ventasFiltradas = salesHistory.filter(s => (s.fechaTS || s.id) >= reporteDesdeTS && (s.fechaTS || s.id) <= reporteHastaTS); const ventasValidas = ventasFiltradas.filter(v => !v.anulada); const comprasFiltradas = purchasesHistory.filter(p => (!p.fechaTS || (p.fechaTS >= reporteDesdeTS && p.fechaTS <= reporteHastaTS)) && !p.anulada); const gastosFiltrados = gastosHistory.filter(g => g.fechaTS >= reporteDesdeTS && g.fechaTS <= reporteHastaTS && !g.anulado); const cajasFiltradas = cajaHistorial.filter(c => c.estado === "cerrada" && c.fechaCierreTS >= reporteDesdeTS && c.fechaCierreTS <= reporteHastaTS);
    const totalVentas = ventasValidas.reduce((s, v) => s + v.total, 0); const totalCompras = comprasFiltradas.reduce((s, p) => s + p.total, 0); const totalGastos = gastosFiltrados.reduce((s, g) => s + g.monto, 0);
    
    let costoVentas = 0; ventasValidas.forEach(v => { if (v.items) v.items.forEach(i => { costoVentas += obtenerCostoHistoricoItem(i) * i.cantidad; }); });
    const utilidad = totalVentas - costoVentas - totalGastos; const totalCxC = clients.reduce((s, c) => s + (c.debt||0), 0); const totalCxP = suppliers.reduce((s, sup) => s + (sup.debt || 0), 0);
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("repVentas", `${sysConfig.currency}${totalVentas.toFixed(2)}`); set("repCompras", `${sysConfig.currency}${totalCompras.toFixed(2)}`); set("repGastos", `${sysConfig.currency}${totalGastos.toFixed(2)}`); set("repUtilidad", `${sysConfig.currency}${utilidad.toFixed(2)}`); set("repCxC", `${sysConfig.currency}${totalCxC.toFixed(2)}`); set("repCxP", `${sysConfig.currency}${totalCxP.toFixed(2)}`);

    const porMetodo = {}; ventasValidas.forEach(venta => { const metodo = mediosPagoVenta[obtenerMedioPagoVenta(venta)] || venta.metodo; if (!porMetodo[metodo]) porMetodo[metodo] = { count: 0, total: 0 }; porMetodo[metodo].count++; porMetodo[metodo].total += venta.total; }); const metodoBody = document.getElementById("repVentasMetodoBody"); if (metodoBody) { const entries = Object.entries(porMetodo); metodoBody.innerHTML = entries.length === 0 ? `<tr><td colspan="3" class="text-center">Sin ventas.</td></tr>` : entries.map(([metodo, d]) => `<tr><td>${escapeHtml(metodo)}</td><td>${d.count}</td><td>${sysConfig.currency}${d.total.toFixed(2)}</td></tr>`).join(""); }
    const contadorProd = {}; ventasValidas.forEach(v => { if (v.items) v.items.forEach(i => { if (!contadorProd[i.name]) contadorProd[i.name] = { cantidad: 0, total: 0 }; const precio = v.tarifa === "Menudeo" ? (i.retailPrice || i.retail || 0) : (i.wholesalePrice || i.wholesale || 0); contadorProd[i.name].cantidad += i.cantidad; contadorProd[i.name].total += precio * i.cantidad; }); }); const topBody = document.getElementById("repTopProductosBody"); if (topBody) { const sorted = Object.entries(contadorProd).sort((a, b) => b[1].cantidad - a[1].cantidad).slice(0, 15); topBody.innerHTML = sorted.length === 0 ? `<tr><td colspan="3" class="text-center">Sin datos.</td></tr>` : sorted.map(([name, d]) => `<tr><td>${escapeHtml(name)}</td><td>${d.cantidad}</td><td>${sysConfig.currency}${d.total.toFixed(2)}</td></tr>`).join(""); }
    const porVendedor = {};
    ventasValidas.forEach(venta => {
        if (!porVendedor[venta.vendedor]) porVendedor[venta.vendedor] = { count: 0, contado: 0, tarjeta: 0, transferencia: 0, credito: 0, total: 0 };
        const resumen = porVendedor[venta.vendedor];
        resumen.count++;
        const medio = obtenerMedioPagoVenta(venta);
        if (medio === "cash") resumen.contado += venta.total;
        else if (medio === "card") resumen.tarjeta += venta.total;
        else if (medio === "transfer") resumen.transferencia += venta.total;
        else if (medio === "credit") resumen.credito += venta.total;
        resumen.total += venta.total;
    });
    const vendBody = document.getElementById("repVendedoresBody");
    if (vendBody) {
        const entries = Object.entries(porVendedor).sort((a, b) => b[1].total - a[1].total);
        vendBody.innerHTML = entries.length === 0 ? `<tr><td colspan="7" class="text-center">Sin ventas.</td></tr>` : entries.map(([nombre, d]) => `<tr><td><strong>${escapeHtml(nombre)}</strong></td><td>${d.count}</td><td>${sysConfig.currency}${d.contado.toFixed(2)}</td><td>${sysConfig.currency}${d.tarjeta.toFixed(2)}</td><td>${sysConfig.currency}${d.transferencia.toFixed(2)}</td><td>${sysConfig.currency}${d.credito.toFixed(2)}</td><td style="font-weight:bold;">${sysConfig.currency}${d.total.toFixed(2)}</td></tr>`).join("");
    }
    const compBody = document.getElementById("repComprasBody"); if (compBody) { compBody.innerHTML = comprasFiltradas.length === 0 ? `<tr><td colspan="5" class="text-center">Sin compras.</td></tr>` : [...comprasFiltradas].reverse().map(c => `<tr><td>${c.fecha}</td><td>${escapeHtml(c.factura)}</td><td>${escapeHtml(c.proveedor)}</td><td>${c.tipo === 'credito' ? 'Crédito' : 'Contado'}</td><td style="font-weight:bold;">${sysConfig.currency}${(c.total||0).toFixed(2)}</td></tr>`).join(""); }
    
    const invBody = document.getElementById("repInventarioBody"); 
    if (invBody) { 
        const validProds = products.filter(p => !p.deleted);
        invBody.innerHTML = validProds.length === 0 ? `<tr><td colspan="5" class="text-center">Sin productos.</td></tr>` : validProds.map(p => { 
            const valor = (p.cost || 0) * (p.stock || 0); 
            const minLim = p.minStock !== undefined ? p.minStock : (sysConfig.minStock || 5); 
            const estado = p.active === false ? '<span style="color:#666; font-weight:bold;">Inactivo</span>' : ((p.stock || 0) <= 0 ? '<span style="color:#d32f2f; font-weight:bold;">Agotado</span>' : ((p.stock || 0) <= minLim ? '<span style="color:#ff9800; font-weight:bold;">Bajo Stock</span>' : '<span style="color:#28a745;">Normal</span>')); 
            return `<tr><td>${escapeHtml(p.name)}</td><td>${p.stock||0}</td><td>${sysConfig.currency}${(p.cost || 0).toFixed(2)}</td><td>${sysConfig.currency}${valor.toFixed(2)}</td><td>${estado}</td></tr>`; 
        }).join(""); 
    }
    
    const cajaBody = document.getElementById("repCajaBody"); if (cajaBody) { cajaBody.innerHTML = cajasFiltradas.length === 0 ? `<tr><td colspan="6" class="text-center">Sin cierres.</td></tr>` : cajasFiltradas.map(c => { const difColor = c.diferencia === 0 ? '#28a745' : '#d32f2f'; return `<tr><td>${c.fechaApertura}</td><td>${c.fechaCierre}</td><td>${escapeHtml(c.usuarioCierre)}</td><td>${sysConfig.currency}${(c.efectivoEsperado||0).toFixed(2)}</td><td>${sysConfig.currency}${(c.efectivoReal||0).toFixed(2)}</td><td style="color:${difColor}; font-weight:bold;">${sysConfig.currency}${(c.diferencia||0).toFixed(2)}</td></tr>`; }).join(""); }
    const porCategoria = {}; gastosFiltrados.forEach(g => { if (!porCategoria[g.categoria]) porCategoria[g.categoria] = { count: 0, total: 0 }; porCategoria[g.categoria].count++; porCategoria[g.categoria].total += g.monto; }); const gastCatBody = document.getElementById("repGastosCategoriaBody"); if (gastCatBody) { const entries = Object.entries(porCategoria).sort((a, b) => b[1].total - a[1].total); gastCatBody.innerHTML = entries.length === 0 ? `<tr><td colspan="3" class="text-center">Sin gastos.</td></tr>` : entries.map(([cat, d]) => `<tr><td>${escapeHtml(cat)}</td><td>${d.count}</td><td>${sysConfig.currency}${d.total.toFixed(2)}</td></tr>`).join(""); }
    const cxcBody = document.getElementById("repCxCBody"); if (cxcBody) { const conDeuda = clients.filter(c => (c.debt||0) > 0); cxcBody.innerHTML = conDeuda.length === 0 ? `<tr><td colspan="4" class="text-center">Sin cuentas por cobrar.</td></tr>` : conDeuda.map(c => `<tr><td><strong>${escapeHtml(c.name)}</strong></td><td>${sysConfig.currency}${(c.creditLimit||0).toFixed(2)}</td><td style="color:#d32f2f; font-weight:bold;">${sysConfig.currency}${(c.debt||0).toFixed(2)}</td><td>${(c.debt||0) > (c.creditLimit||0) ? '<span style="color:#d32f2f;">Excedido</span>' : 'Normal'}</td></tr>`).join(""); }
    const cxpBody = document.getElementById("repCxPBody"); if (cxpBody) { const conDeuda = suppliers.filter(s => (s.debt||0) > 0); cxpBody.innerHTML = conDeuda.length === 0 ? `<tr><td colspan="2" class="text-center">Sin cuentas por pagar.</td></tr>` : conDeuda.map(s => `<tr><td><strong>${escapeHtml(s.name)}</strong></td><td style="color:#d32f2f; font-weight:bold;">${sysConfig.currency}${(s.debt||0).toFixed(2)}</td></tr>`).join(""); }
}

window.imprimirTicket = function() {
    const elementoTicket = document.getElementById("imprimibleTicket"); if (!elementoTicket) return; const contenido = elementoTicket.outerHTML; const ventana = window.open('', '_blank', 'width=400,height=600');
    ventana.document.write(`<html><head><title>Ticket de Venta</title><style>body { margin: 0; padding: 0; font-family: monospace; color: #000; width: 58mm; background: #fff; } #imprimibleTicket { width: 100%; max-width: 58mm; padding: 0 !important; margin: 0 !important; border: none !important; } @media print { @page { margin: 0; } body { margin: 0; padding: 0; } }</style></head><body onload="setTimeout(() => { window.print(); window.close(); }, 250);">${contenido}</body></html>`); ventana.document.close();
};

window.exportarTablaCSV = function(containerId, nombreArchivo) {
    const subview = document.getElementById(containerId); const tabla = subview ? subview.querySelector('table') : document.querySelector(`#${containerId}`);
    if (!tabla) { showAlert("No hay datos para exportar en esta vista."); return; }
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; const rows = tabla.querySelectorAll("tr");
    rows.forEach(row => { const cols = row.querySelectorAll("th, td"); const rowData = Array.from(cols).map(col => `"${col.innerText.replace(/"/g, '""').replace(/\n/g, ' ')}"`); csvContent += rowData.join(",") + "\r\n"; });
    const encodedUri = encodeURI(csvContent); const link = document.createElement("a"); link.setAttribute("href", encodedUri); link.setAttribute("download", `${nombreArchivo}_${new Date().toLocaleDateString().replace(/\//g, '-')}.csv`); document.body.appendChild(link); link.click(); document.body.removeChild(link);
};

window.exportarExcelReporte = function(containerId, nombreArchivo) {
    if (typeof XLSX === 'undefined') { showAlert("La librería Excel (XLSX) no está cargada."); return; }
    const subview = document.getElementById(containerId);
    const tablas = subview ? subview.querySelectorAll('table') : [];
    if (!tablas.length) { showAlert("No hay datos para exportar en esta vista."); return; }
    const wb = XLSX.utils.book_new();
    tablas.forEach((tabla, index) => XLSX.utils.book_append_sheet(wb, XLSX.utils.table_to_sheet(tabla), `Hoja${index + 1}`));
    XLSX.writeFile(wb, `${nombreArchivo}_${new Date().toLocaleDateString().replace(/\//g, '-')}.xlsx`);
};

// FUNCIÓN DE EXPORTACIÓN A EXCEL DEL DASHBOARD FALTANTE (BUG 3)
window.generarExcelDashboard = function() {
    if (typeof XLSX === 'undefined') { showAlert("La librería Excel (XLSX) no está cargada."); return; }
    
    let wb = XLSX.utils.book_new();
    let ws_data = [
        ["Métrica", "Valor"],
        ["Ventas Hoy", document.getElementById("dashVentasHoy")?.textContent || "0"],
        ["Ventas Mes", document.getElementById("dashVentasMes")?.textContent || "0"],
        ["Ganancia Estimada", document.getElementById("dashGanancia")?.textContent || "0"],
        ["Productos Vendidos", document.getElementById("dashProdsVendidos")?.textContent || "0"],
        ["Bajo Stock", document.getElementById("dashBajoStock")?.textContent || "0"],
        ["Crédito Pendiente (CxC)", document.getElementById("dashCxC")?.textContent || "0"],
        ["Cuentas por Pagar (CxP)", document.getElementById("dashCxP")?.textContent || "0"],
        ["Gastos Totales", document.getElementById("dashGastos")?.textContent || "0"]
    ];
    
    let ws = XLSX.utils.aoa_to_sheet(ws_data);
    XLSX.utils.book_append_sheet(wb, ws, "Resumen Dashboard");
    XLSX.writeFile(wb, `Dashboard_${new Date().toLocaleDateString().replace(/\//g, '-')}.xlsx`);
};
// Puente de estado del POS: no concede permisos en la API.
window.PosRuntime = Object.freeze({
    salesInput() { return { businessId: DEFAULT_BUSINESS_ID, userId: currentUser?.id, role: currentUser?.role, items: cart.map(item => ({ productId: String(item.id), quantity: String(item.cantidad) })), priceType: buyerType === 'retail' ? 'RETAIL' : 'WHOLESALE', paymentMethod: paymentMethod.toUpperCase(), clientId: paymentMethod === 'credit' ? (document.getElementById('creditClientSelect')?.value || null) : null, discountPercent: document.querySelector('input[name="descApplies"][value="si"]')?.checked ? document.getElementById('descuentoPct').value : '0', detail: document.getElementById('saleDetailInput').value.trim() }; },
    setSales(values) { if (!connectedMode || values.some(value => value.businessId !== DEFAULT_BUSINESS_ID)) throw new Error('Negocio incorrecto'); salesHistory = values; actualizarTablaHistorial(); },
    publishSale(value) { if (!connectedMode || value.businessId !== DEFAULT_BUSINESS_ID) throw new Error('Negocio incorrecto'); const index = salesHistory.findIndex(sale => sale.id === value.id); if (index < 0) salesHistory.push(value); else salesHistory[index] = value; actualizarTablaHistorial(); },
    setCash(values) { if (!connectedMode || values.some(value => value.businessId !== DEFAULT_BUSINESS_ID)) throw new Error('Negocio incorrecto'); cajaHistorial = values; cajaActual = values.find(value => value.estado === 'abierta') || null; },
    setUser(user) { currentUser = user ? { ...user, displayName: user.fullName } : null; },
    setProducts(values) {
        if (!connectedMode || values.some(value => value.businessId !== DEFAULT_BUSINESS_ID)) throw new Error('Negocio incorrecto');
        products = values.map(value => ({ ...value, business_id: value.businessId }));
        actualizarTablaInventario(); actualizarCatalogo();
    },
    openProductEditor: showProductEditor,
    productImage: () => tempImageBase64,
    setProductImage: image => { tempImageBase64 = image; },
    prepareConnectedBusiness(businessId, apiBaseUrl) {
        if (!connectedMode) throw new Error('Modalidad incorrecta');
        DEFAULT_BUSINESS_ID = businessId;
        const scope = encodeURIComponent(apiBaseUrl) + '_' + businessId;
        localDB = createPosDatabase('POS_ConnectedDB_' + scope);
        configStorageKey = 'posConnectedConfig_' + scope;
        sysConfig = readSystemConfig(configStorageKey);
        // Moneda conectada de esta fase; no interpretar simbolos locales como conversiones.
        sysConfig.currency = 'C$';
    },
    clearCart() { cart = []; resetearDescuentoVenta(); actualizarCarrito(); }
});
