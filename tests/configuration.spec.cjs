const { test, expect } = require("@playwright/test");
const { Buffer } = require("node:buffer");
const { monitorRequests } = require("./browser-diagnostics.cjs");

const browserErrors = new WeakMap();
const restrictedViews = [
  ["navInventoryBtn", "inventoryView"],
  ["navPurchasesBtn", "purchasesView"],
  ["navPayablesBtn", "payablesView"],
  ["navClientsBtn", "clientsView"],
  ["navSuppliersBtn", "suppliersView"],
  ["navHistoryBtn", "historyView"],
  ["navCajaBtn", "cajaView"],
  ["navGastosBtn", "gastosView"],
  ["navReportesBtn", "reportesView"],
  ["navDashboardBtn", "dashboardView"],
  ["navConfigBtn", "configView"]
];

test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  monitorRequests(page, errors);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

async function iniciarSesion(page, username, password) {
  await page.goto("/");
  await page.locator("#loginUsername").fill(username);
  await page.locator("#loginPassword").fill(password);
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
}

async function cerrarAviso(page) {
  await expect(page.locator("#customAlertModal")).toBeVisible();
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#customAlertModal")).toBeHidden();
}

async function abrirConfiguracion(page) {
  await page.locator("#navConfigBtn").click();
  await expect(page.locator("#configView")).toBeVisible();
}

test("solo permite iniciar sesión con usuarios registrados y valida todos los campos", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#loginScreen")).toBeVisible();

  await page.locator("#loginForm button[type='submit']").click();
  expect(await page.locator("#loginUsername").evaluate(input => input.checkValidity())).toBe(false);
  expect(await page.locator("#loginPassword").evaluate(input => input.checkValidity())).toBe(false);
  await expect(page.locator("#app")).toBeHidden();

  const invalidCredentials = [
    ["desconocido", "4321"],
    ["andres", "incorrecta"],
    ["   ", "4321"],
    ["andres", " 4321 "]
  ];
  for (const [username, password] of invalidCredentials) {
    await page.locator("#loginUsername").fill(username);
    await page.locator("#loginPassword").fill(password);
    await page.locator("#loginForm button[type='submit']").click();
    await expect(page.locator("#loginScreen")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
    await expect(page.locator("#loginError")).toBeVisible();
  }

  const registeredUsers = [
    ["andres", "4321", "Administrador"],
    ["gestor", "4321", "Administrador"],
    ["vendedor1", "1234", "Usuario"]
  ];
  for (const [username, password, role] of registeredUsers) {
    await page.locator("#loginUsername").fill(` ${username} `);
    await page.locator("#loginPassword").fill(password);
    await page.locator("#loginForm button[type='submit']").click();
    await expect(page.locator("#loginScreen")).toBeHidden();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#sellerName")).toHaveText(username);
    await expect(page.locator("#roleBadge")).toHaveText(role);
    await page.locator("#logoutBtn").click();
    await expect(page.locator("#loginScreen")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
    await expect(page.locator("#loginUsername")).toHaveValue("");
    await expect(page.locator("#loginPassword")).toHaveValue("");
  }

  await page.reload();
  await expect(page.locator("#loginScreen")).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();
});

test("administrador puede navegar directamente a todas las vistas", async ({ page }) => {
  await iniciarSesion(page, "andres", "4321");
  await expect(page.locator("#roleBadge")).toHaveText("Administrador");

  for (const [buttonId, viewId] of restrictedViews) {
    await page.locator(`#${buttonId}`).click();
    await expect(page.locator(`#${viewId}`)).toBeVisible();
    await expect(page.locator("#authModal")).toBeHidden();
  }
});

test("usuario solo abre Venta sin autorización y debe reautorizar cada módulo restringido", async ({ page }) => {
  await iniciarSesion(page, "vendedor1", "1234");
  await expect(page.locator("#roleBadge")).toHaveText("Usuario");
  await expect(page.locator("#salesView")).toBeVisible();

  for (const [buttonId, viewId] of restrictedViews) {
    await page.locator(`#${buttonId}`).click();
    await expect(page.locator("#authModal")).toBeVisible();
    await expect(page.locator(`#${viewId}`)).toBeHidden();
    expect(await page.locator("#gestorPassword").evaluate(input => input.checkValidity())).toBe(false);
    await page.locator("#authForm button[type='submit']").click();
    await expect(page.locator("#authModal")).toBeVisible();
    await expect(page.locator(`#${viewId}`)).toBeHidden();

    if (buttonId === "navConfigBtn") {
      await page.locator("#gestorPassword").fill("no-es-clave");
      await page.locator("#authForm button[type='submit']").click();
      await expect(page.locator("#authError")).toBeVisible();
      await expect(page.locator("#configView")).toBeHidden();
    }

    await page.locator("#authModal .close-modal-btn").click();
    await expect(page.locator("#authModal")).toBeHidden();
    await expect(page.locator("#salesView")).toBeVisible();
    await page.locator(`#${buttonId}`).click();
    await expect(page.locator("#authModal")).toBeVisible();
    await page.locator("#gestorPassword").fill("4321");
    await page.locator("#authForm button[type='submit']").click();
    await expect(page.locator("#authModal")).toBeHidden();
    await expect(page.locator(`#${viewId}`)).toBeVisible();
    await expect(page.locator("#roleBadge")).toHaveText("Usuario");

    await page.locator("#navSalesBtn").click();
    await expect(page.locator("#salesView")).toBeVisible();
    await page.locator(`#${buttonId}`).click();
    await expect(page.locator("#authModal")).toBeVisible();
    await expect(page.locator(`#${viewId}`)).toBeHidden();
    await page.locator("#authModal .close-modal-btn").click();
  }
});

test("las acciones de sesión y configuración se atribuyen al usuario activo", async ({ page }) => {
  await iniciarSesion(page, "gestor", "4321");
  await expect(page.locator("#sellerName")).toHaveText("gestor");
  await page.locator("#logoutBtn").click();
  await expect(page.locator("#loginScreen")).toBeVisible();

  await iniciarSesion(page, "vendedor1", "1234");
  await expect(page.locator("#sellerName")).toHaveText("vendedor1");
  await page.locator("#navConfigBtn").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await page.locator("#gestorPassword").fill("4321");
  await page.locator("#authForm button[type='submit']").click();
  await expect(page.locator("#configView")).toBeVisible();
  await expect(page.locator("#roleBadge")).toHaveText("Usuario");

  await page.locator("#confName").fill("Negocio atribuido al vendedor");
  await page.locator("#saveConfigBtn").click();
  await cerrarAviso(page);
  await page.locator("#navHistoryBtn").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await page.locator("#gestorPassword").fill("4321");
  await page.locator("#authForm button[type='submit']").click();
  await expect(page.locator("#historyView")).toBeVisible();

  const auditRows = page.locator("#auditTableBody tr");
  const gestorLogin = auditRows.filter({ hasText: "Inicio de sesión (gestor)" });
  await expect(gestorLogin).toHaveCount(1);
  await expect(gestorLogin).toContainText("gestor");
  const logout = auditRows.filter({ hasText: "Cierre de sesión" });
  await expect(logout).toHaveCount(1);
  await expect(logout).toContainText("gestor");
  const sellerLogin = auditRows.filter({ hasText: "Inicio de sesión (vendedor)" });
  await expect(sellerLogin).toHaveCount(1);
  await expect(sellerLogin).toContainText("vendedor1");
  const unlocked = auditRows.filter({ hasText: "DESBLOQUEO_GESTOR" });
  await expect(unlocked).toHaveCount(2);
  for (const rowText of await unlocked.allTextContents()) {
    expect(rowText).toContain("vendedor1");
  }
  const configUpdate = auditRows.filter({ hasText: "ACTUALIZACION" });
  await expect(configUpdate).toHaveCount(1);
  await expect(configUpdate).toContainText("CONFIGURACION");
  await expect(configUpdate).toContainText("vendedor1");
  const today = await page.evaluate(() => new Date().toLocaleDateString());
  await expect(configUpdate).toContainText(today);
});

test("Configuración guarda todos los campos, logo y efectos visibles tras recarga", async ({ page }) => {
  await iniciarSesion(page, "andres", "4321");
  await abrirConfiguracion(page);

  await page.locator("#confName").fill("Tienda de Prueba");
  await page.locator("#confRuc").fill("RUC-CONFIG-001");
  await page.locator("#confAddress").fill("Avenida Central");
  await page.locator("#confPhone").fill("88887777");
  await page.locator("#confCurrency").fill("€");
  await page.locator("#confHeader").fill("Sucursal Norte");
  await page.locator("#confFooter").fill("Vuelva pronto");
  await page.locator("#confMinStock").fill("7");
  await page.locator("#confLogoInput").setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=", "base64")
  });
  await expect(page.locator("#confLogoPreview")).toBeVisible();
  await expect(page.locator("#confLogoPreview")).toHaveAttribute("src", /^data:image\/png;base64,/);

  await page.locator("#saveConfigBtn").click();
  await cerrarAviso(page);
  await expect(page.locator("#brandNameDisplay")).toHaveText("Tienda de Prueba");

  await page.locator("#navInventoryBtn").click();
  await page.locator("#addNewProductBtn").click();
  await expect(page.locator("#prodMinStock")).toHaveValue("7");
  await page.locator("#prodBarcode").fill("CONFIG-LOW-001");
  await page.locator("#prodName").fill("Producto bajo stock global");
  await page.locator("#prodCost").fill("10");
  await page.locator("#prodRetail").fill("15");
  await page.locator("#prodWholesale").fill("13");
  await page.locator("#prodStock").fill("5");
  await expect(page.locator("#prodMinStock")).toHaveValue("7");
  await page.locator("#productForm button[type='submit']").click();
  await expect(page.locator("#productModal")).toBeHidden();
  await cerrarAviso(page);
  const productRow = page.locator("#inventoryTableBody tr").filter({ hasText: "CONFIG-LOW-001" });
  await expect(productRow).toContainText("Bajo");

  await page.locator("#navSalesBtn").click();
  await page.locator('input[name="paymentMethod"][value="card"]').check();
  await page.locator("#barcodeInput").fill("CONFIG-LOW-001");
  await page.locator("#addBarcodeBtn").click();
  await page.locator("#processSaleBtn").click();
  await expect(page.locator("#ticketModal")).toBeVisible();
  await expect(page.locator("#ticketContent")).toContainText("Tienda de Prueba");
  await expect(page.locator("#ticketContent")).toContainText("RUC: RUC-CONFIG-001");
  await expect(page.locator("#ticketContent")).toContainText("Dir: Avenida Central");
  await expect(page.locator("#ticketContent")).toContainText("Tel: 88887777");
  await expect(page.locator("#ticketContent")).toContainText("Sucursal Norte");
  await expect(page.locator("#ticketContent")).toContainText("Vuelva pronto");
  await expect(page.locator("#ticketContent")).toContainText("€15.00");
  await expect(page.locator("#ticketContent img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await page.locator("#newSaleBtn").click();

  await page.reload();
  await expect(page.locator("#loginScreen")).toBeVisible();
  await iniciarSesion(page, "andres", "4321");
  await expect(page.locator("#brandNameDisplay")).toHaveText("Tienda de Prueba");
  await abrirConfiguracion(page);
  await expect(page.locator("#confName")).toHaveValue("Tienda de Prueba");
  await expect(page.locator("#confRuc")).toHaveValue("RUC-CONFIG-001");
  await expect(page.locator("#confAddress")).toHaveValue("Avenida Central");
  await expect(page.locator("#confPhone")).toHaveValue("88887777");
  await expect(page.locator("#confCurrency")).toHaveValue("€");
  await expect(page.locator("#confHeader")).toHaveValue("Sucursal Norte");
  await expect(page.locator("#confFooter")).toHaveValue("Vuelva pronto");
  await expect(page.locator("#confMinStock")).toHaveValue("7");
  await expect(page.locator("#confLogoPreview")).toBeVisible();
  await page.locator("#navHistoryBtn").click();
  const configAudit = page.locator("#auditTableBody tr").filter({ hasText: "ACTUALIZACION" });
  await expect(configAudit).toHaveCount(1);
  await expect(configAudit).toContainText("CONFIGURACION");
  await expect(configAudit).toContainText("andres");
});

test("Configuración descarta cambios no guardados y normaliza campos vacíos", async ({ page }) => {
  await iniciarSesion(page, "andres", "4321");
  await abrirConfiguracion(page);

  await page.locator("#confName").fill("Cambio pendiente");
  await page.locator("#confCurrency").fill("$");
  await page.locator("#navSalesBtn").click();
  await abrirConfiguracion(page);
  await expect(page.locator("#confName")).toHaveValue("POS DISTRIBUIDORA");
  await expect(page.locator("#confCurrency")).toHaveValue("C$");

  await page.locator("#confName").fill("   ");
  await page.locator("#confCurrency").fill("  ");
  await page.locator("#confRuc").fill("   ");
  await page.locator("#confAddress").fill("   ");
  await page.locator("#confPhone").fill("   ");
  await page.locator("#confHeader").fill("   ");
  await page.locator("#confFooter").fill("   ");
  await page.locator("#confMinStock").fill("");
  await page.locator("#saveConfigBtn").click();
  await cerrarAviso(page);
  await expect(page.locator("#brandNameDisplay")).toHaveText("POS DISTRIBUIDORA");

  await page.reload();
  await iniciarSesion(page, "andres", "4321");
  await abrirConfiguracion(page);
  await expect(page.locator("#confName")).toHaveValue("POS DISTRIBUIDORA");
  await expect(page.locator("#confCurrency")).toHaveValue("C$");
  await expect(page.locator("#confRuc")).toHaveValue("");
  await expect(page.locator("#confAddress")).toHaveValue("");
  await expect(page.locator("#confPhone")).toHaveValue("");
  await expect(page.locator("#confHeader")).toHaveValue("");
  await expect(page.locator("#confFooter")).toHaveValue("");
  await expect(page.locator("#confMinStock")).toHaveValue("5");
});

test("Configuración no guarda un mínimo de stock fraccionario inválido", async ({ page }) => {
  await iniciarSesion(page, "andres", "4321");
  await abrirConfiguracion(page);

  await page.locator("#confName").fill("Nombre anterior");
  await page.locator("#saveConfigBtn").click();
  await cerrarAviso(page);

  await page.locator("#confName").fill("Nombre fraccionario rechazado");
  await page.locator("#confMinStock").fill("1.5");
  expect(await page.locator("#confMinStock").evaluate(input => input.checkValidity())).toBe(false);
  await page.locator("#saveConfigBtn").click();
  await expect(page.locator("#configView")).toBeVisible();
  await expect(page.locator("#customAlertModal")).toBeHidden();

  await page.locator("#navSalesBtn").click();
  await abrirConfiguracion(page);
  await expect(page.locator("#confName")).toHaveValue("Nombre anterior");
  await expect(page.locator("#confMinStock")).toHaveValue("5");
});
