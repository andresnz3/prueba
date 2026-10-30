const { test, expect } = require("@playwright/test");
const { openCash } = require("./cash-fixture.cjs");
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

test("solo el propietario configurado puede iniciar sesión en el modo local", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#loginScreen")).toBeVisible();
  await expect(page.locator("#localOwnerSetupForm")).toBeHidden();
  await expect(page.locator("#loginUsername")).toHaveAttribute("autocomplete", "username");

  const invalidCredentials = [
    ["desconocido", "Prueba-Local-Propietario-2026!"],
    ["andres", "incorrecta"],
    ["andres", "4321"],
    ["gestor", "4321"],
    ["sergio", "4321"],
    ["sergio", "1234"],
    ["vendedor1", "1234"]
  ];
  for (const [username, password] of invalidCredentials) {
    await page.evaluate(() => localStorage.removeItem("posLoginFailState"));
    await page.locator("#loginUsername").fill(username);
    await page.locator("#loginPassword").fill(password);
    await page.locator("#loginForm button[type='submit']").click();
    await expect(page.locator("#loginScreen")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
    await expect(page.locator("#loginError")).toHaveText("Credenciales incorrectas");
  }

  await page.locator("#loginUsername").fill(" andres ");
  await page.locator("#loginPassword").fill("Prueba-Local-Propietario-2026!");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#loginScreen")).toBeHidden();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#sellerName")).toHaveText("andres");
  await expect(page.locator("#roleBadge")).toHaveText("Propietario");
  await page.locator("#logoutBtn").click();
  await expect(page.locator("#loginScreen")).toBeVisible();
  await expect(page.locator("#loginUsername")).toHaveValue("");
  await expect(page.locator("#loginPassword")).toHaveValue("");
});

test("el propietario puede abrir todos los módulos locales sin cuentas de vendedor", async ({ page }) => {
  await iniciarSesion(page, "andres", "Prueba-Local-Propietario-2026!");
  await expect(page.locator("#roleBadge")).toHaveText("Propietario");
  for (const [buttonId, viewId] of restrictedViews) {
    await page.locator(`#${buttonId}`).click();
    await expect(page.locator(`#${viewId}`)).toBeVisible();
    await expect(page.locator("#authModal")).toBeHidden();
  }
});

test("las acciones locales se atribuyen a la cuenta del propietario", async ({ page }) => {
  await iniciarSesion(page, "andres", "Prueba-Local-Propietario-2026!");
  await expect(page.locator("#sellerName")).toHaveText("andres");
  await page.locator("#navConfigBtn").click();
  await page.locator("#confName").fill("Negocio atribuido al propietario");
  await page.locator("#saveConfigBtn").click();
  await cerrarAviso(page);
  await page.locator("#navHistoryBtn").click();
  const auditRows = page.locator("#auditTableBody tr");
  const login = auditRows.filter({ hasText: "Inicio de sesión del propietario" });
  await expect(login).toHaveCount(1);
  await expect(login).toContainText("andres");
  const configUpdate = auditRows.filter({ hasText: "ACTUALIZACION" });
  await expect(configUpdate).toHaveCount(1);
  await expect(configUpdate).toContainText("CONFIGURACION");
  await expect(configUpdate).toContainText("andres");
});
test("Configuración guarda todos los campos, logo y efectos visibles tras recarga", async ({ page }) => {
  await iniciarSesion(page, "andres", "Prueba-Local-Propietario-2026!");
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
  await openCash(page);

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
  await iniciarSesion(page, "andres", "Prueba-Local-Propietario-2026!");
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
  await iniciarSesion(page, "andres", "Prueba-Local-Propietario-2026!");
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
  await iniciarSesion(page, "andres", "Prueba-Local-Propietario-2026!");
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

test("Configuración guarda un mínimo de stock fraccionario válido", async ({ page }) => {
  await iniciarSesion(page, "andres", "Prueba-Local-Propietario-2026!");
  await abrirConfiguracion(page);

  await page.locator("#confName").fill("Nombre anterior");
  await page.locator("#saveConfigBtn").click();
  await cerrarAviso(page);

  await page.locator("#confName").fill("Nombre fraccionario guardado");
  await page.locator("#confMinStock").fill("1.5");
  expect(await page.locator("#confMinStock").evaluate(input => input.checkValidity())).toBe(true);
  await page.locator("#saveConfigBtn").click();
  await expect(page.locator("#customAlertModal")).toBeVisible();
  await cerrarAviso(page);

  await page.locator("#navSalesBtn").click();
  await abrirConfiguracion(page);
  await expect(page.locator("#confName")).toHaveValue("Nombre fraccionario guardado");
  await expect(page.locator("#confMinStock")).toHaveValue("1.5");
});
