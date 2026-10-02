const { test, expect } = require("@playwright/test");
const { monitorRequests } = require("./browser-diagnostics.cjs");

const browserErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  monitorRequests(page, errors);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

async function iniciarSesion(page) {
  await page.goto("/");
  await page.locator("#loginUsername").fill("andres");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
}

async function abrirHistorial(page) {
  await page.locator("#navHistoryBtn").click();
  await expect(page.locator("#historyView")).toBeVisible();
}

async function crearProductoDesdeUI(page, barcode, name, stock = "10") {
  await page.locator("#navInventoryBtn").click();
  await page.locator("#addNewProductBtn").click();
  await page.locator("#prodBarcode").fill(barcode);
  await page.locator("#prodName").fill(name);
  await page.locator("#prodCost").fill("10");
  await page.locator("#prodRetail").fill("15");
  await page.locator("#prodWholesale").fill("13");
  await page.locator("#prodStock").fill(stock);
  await page.locator("#prodMinStock").fill("1");
  await page.locator("#productForm button[type='submit']").click();
  await expect(page.locator("#productModal")).toBeHidden();
  await expect(page.locator("#customAlertModal")).toBeVisible();
  await page.locator("#customAlertModal .close-modal-btn").click();
}

async function agregarVenta(page, barcode, metodoPago) {
  await page.locator("#navSalesBtn").click();
  await page.locator("#barcodeInput").fill(barcode);
  await page.locator("#addBarcodeBtn").click();
  await expect(page.locator("#cartItems")).not.toContainText("Carrito vacío");
  await page.locator(`input[name="paymentMethod"][value="${metodoPago}"]`).check();
  await page.locator("#processSaleBtn").click();
}

test("Historial carga las ventas vacías, resúmenes y auditoría de sesión", async ({ page }) => {
  await iniciarSesion(page);
  await abrirHistorial(page);

  await expect(page.locator("#historyTableBody")).toContainText("No hay ventas registradas.");
  await expect(page.locator("#historyTableBody tr")).toHaveCount(1);
  await expect(page.locator("#auditTableBody")).toContainText("andres");
  await expect(page.locator("#auditTableBody")).toContainText("SESION");
  await expect(page.locator("#auditTableBody")).toContainText("LOGIN");
  await expect(page.locator("#summaryTodaySales")).toHaveText("C$0.00");
  await expect(page.locator("#summaryTotalSales")).toHaveText("C$0.00");
  await expect(page.locator("#summaryCashSales")).toHaveText("C$0.00");
  await expect(page.locator("#summaryCardSales")).toHaveText("C$0.00");
  await expect(page.locator("#summaryTransferSales")).toHaveText("C$0.00");
  await expect(page.locator("#summaryCreditSales")).toHaveText("C$0.00");
  await expect(page.locator("#summaryTotalExpenses")).toHaveText("C$0.00");
  await expect(page.locator("#lowStockList")).toBeVisible();
  await expect(page.locator("#topSellingList")).toBeVisible();
});

test("Historial muestra ventas, detalles, auditoría y anulaciones sin duplicar registros", async ({ page }) => {
  await iniciarSesion(page);
  await crearProductoDesdeUI(page, "HISTORY-SALE-001", "Producto de Historial", "8");

  await agregarVenta(page, "HISTORY-SALE-001", "card");
  await expect(page.locator("#ticketModal")).toBeVisible();
  await expect(page.locator("#ticketContent")).toContainText("Producto de Historial");
  await expect(page.locator("#ticketContent")).toContainText("C$15.00");
  await page.locator("#newSaleBtn").click();

  await abrirHistorial(page);
  const saleRow = page.locator("#historyTableBody tr").first();
  await expect(saleRow).toContainText("andres");
  await expect(saleRow).toContainText("TARJETA");
  await expect(saleRow).toContainText("C$15.00");
  await expect(page.locator("#summaryTodaySales")).toHaveText("C$15.00");
  await expect(page.locator("#summaryTotalSales")).toHaveText("C$15.00");
  await expect(page.locator("#summaryCardSales")).toHaveText("C$15.00");
  await expect(page.locator("#summaryCashSales")).toHaveText("C$0.00");

  const today = await page.evaluate(() => new Date().toLocaleDateString());
  await expect(saleRow).toContainText(today);
  const saleAuditRow = page.locator("#auditTableBody tr").filter({
    hasText: "NUEVA_VENTA"
  });
  await expect(saleAuditRow).toHaveCount(1);
  await expect(saleAuditRow).toContainText("VENTAS");
  await expect(saleAuditRow).toContainText("andres");
  await expect(saleAuditRow).toContainText("Producto de Historial x 1");
  await expect(saleAuditRow).toContainText("Factura: #1");
  await expect(saleAuditRow).toContainText("C$15.00");

  await saleRow.getByRole("button", { name: "Ver Factura" }).click();
  await expect(page.locator("#ticketModal")).toBeVisible();
  await expect(page.locator("#ticketContent")).toContainText("COPIA DE FACTURA");
  await expect(page.locator("#ticketContent")).toContainText("Producto de Historial");
  await page.locator("#newSaleBtn").click();

  await page.reload();
  await iniciarSesion(page);
  await abrirHistorial(page);
  await expect(page.locator("#historyTableBody tr")).toHaveCount(1);
  await expect(page.locator("#auditTableBody tr").filter({ hasText: "NUEVA_VENTA" })).toHaveCount(1);

  await page.locator("#historyTableBody tr").first().getByRole("button", { name: "Anular" }).click();
  await expect(page.locator("#anularVentaModal")).toBeVisible();
  await page.locator("#anularVentaModal .close-modal-btn").click();
  await expect(page.locator("#customConfirmModal")).toBeVisible();
  await page.locator("#customConfirmModal .close-modal-btn").click();
  await expect(page.locator("#customConfirmModal")).toBeHidden();
  await expect(page.locator("#anularVentaModal")).toBeVisible();

  await page.locator("#anularVentaMotivo").fill("Operación duplicada");
  await page.locator("#anularVentaForm button[type='submit']").click();
  await expect(page.locator("#anularVentaModal")).toBeHidden();
  await expect(page.locator("#customAlertMessage")).toContainText("anulada exitosamente");
  await page.locator("#customAlertModal .close-modal-btn").click();

  const voidedSale = page.locator("#historyTableBody tr").first();
  await expect(voidedSale).toContainText("ANULADA");
  await expect(voidedSale).toContainText("C$15.00");
  await expect(page.locator("#summaryTodaySales")).toHaveText("C$0.00");
  await expect(page.locator("#summaryTotalSales")).toHaveText("C$0.00");
  await expect(page.locator("#summaryCardSales")).toHaveText("C$0.00");
  const voidAuditRow = page.locator("#auditTableBody tr").filter({
    hasText: "ANULACION"
  });
  await expect(voidAuditRow).toHaveCount(1);
  await expect(voidAuditRow).toContainText("Operación duplicada");

  await page.locator("#navInventoryBtn").click();
  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "HISTORY-SALE-001"
  });
  await expect(productRow.locator("td").nth(3)).toContainText("8");
});

test("los resúmenes incluyen compras y gastos y sobreviven a una recarga", async ({ page }) => {
  await iniciarSesion(page);
  await crearProductoDesdeUI(page, "HISTORY-PURCHASE-001", "Producto para compra");

  await page.locator("#navPurchasesBtn").click();
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchSupplier").fill("Proveedor Historial");
  await page.locator("#purchInvoice").fill("HIST-FACT-001");
  await page.locator("#purchType").selectOption("contado");
  await page.locator("#purchProductTemp").fill("Producto para compra");
  await page.locator("#purchQtyTemp").fill("2");
  await page.locator("#purchCostTemp").fill("10");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();
  await expect(page.locator("#customAlertMessage")).toContainText("Factura guardada correctamente");
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.locator("#navGastosBtn").click();
  await page.locator("#gastoCategoria").selectOption("Servicios Básicos");
  await page.locator("#gastoMetodo").selectOption("banco");
  await page.locator("#gastoDescripcion").fill("Gasto para resumen de Historial");
  await page.locator("#gastoComprobante").fill("HIST-GASTO-001");
  await page.locator("#gastoMonto").fill("7");
  await page.locator("#formRegistrarGasto button[type='submit']").click();
  await expect(page.locator("#gastosTableBody")).toContainText("Gasto para resumen de Historial");
  await page.locator("#customAlertModal .close-modal-btn").click();

  await abrirHistorial(page);
  await expect(page.locator("#summaryTotalExpenses")).toHaveText("C$27.00");
  const purchaseAudit = page.locator("#auditTableBody tr").filter({
    hasText: "NUEVA_COMPRA"
  });
  await expect(purchaseAudit).toHaveCount(1);
  await expect(purchaseAudit).toContainText("HIST-FACT-001");
  await expect(purchaseAudit).toContainText("Proveedor Historial");

  await page.reload();
  await iniciarSesion(page);
  await abrirHistorial(page);
  await expect(page.locator("#summaryTotalExpenses")).toHaveText("C$27.00");
  await expect(page.locator("#auditTableBody tr").filter({ hasText: "NUEVA_COMPRA" })).toHaveCount(1);
});

test("Historial muestra la auditoría de movimientos de Caja y abonos de crédito", async ({ page }) => {
  await iniciarSesion(page);

  await page.locator("#navCajaBtn").click();
  await page.locator("#cajaEfectivoInicialInput").fill("100");
  await page.locator("#abrirCajaBtn").click();
  await expect(page.locator("#cajaAbiertaBox")).toBeVisible();
  await page.locator("#cajaMovimientoConcepto").fill("Entrada controlada desde Caja");
  await page.locator("#cajaMovimientoMonto").fill("5");
  await page.locator("#registrarEntradaBtn").click();
  const cashMovement = page.locator("#cajaMovimientosBody tr").filter({
    hasText: "Entrada controlada desde Caja"
  });
  await expect(cashMovement).toContainText("C$5.00");
  await cashMovement.getByRole("button", { name: "Confirmar" }).click();

  await crearProductoDesdeUI(page, "HISTORY-CREDIT-001", "Producto para abono");
  await page.locator("#navClientsBtn").click();
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientName").fill("Cliente Historial Crédito");
  await page.locator("#clientLimit").fill("500");
  await page.locator("#clientDebt").fill("0");
  await page.locator("#clientForm button[type='submit']").click();
  const clientRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente Historial Crédito"
  });
  const clientId = (await clientRow.locator("td").first().innerText()).split("\n")[0];

  await page.locator("#navSalesBtn").click();
  await page.locator('input[name="paymentMethod"][value="credit"]').check();
  await page.locator("#creditClientSelect").selectOption(clientId);
  await page.locator("#barcodeInput").fill("HISTORY-CREDIT-001");
  await page.locator("#addBarcodeBtn").click();
  await page.locator("#processSaleBtn").click();
  await expect(page.locator("#ticketModal")).toBeVisible();
  await page.locator("#newSaleBtn").click();

  await page.locator("#navClientsBtn").click();
  await clientRow.getByRole("button", { name: "Historial" }).click();
  await expect(page.locator("#statementModal")).toBeVisible();
  await page.locator("#statementTableBody").getByRole("button", { name: "Abonar" }).click();
  await page.locator("#paySaleAmount").fill("5");
  await page.locator("#paySaleMethod").selectOption("tarjeta");
  await page.locator("#paymentSaleForm button[type='submit']").click();
  await expect(page.locator("#paymentSaleModal")).toBeHidden();
  await page.locator("#customAlertModal .close-modal-btn").click();
  await page.locator("#statementModal .close-modal-btn").click();

  await abrirHistorial(page);
  await expect(page.locator("#summaryCreditSales")).toHaveText("C$15.00");
  const cashAudit = page.locator("#auditTableBody tr").filter({
    hasText: "APERTURA"
  });
  await expect(cashAudit).toHaveCount(1);
  await expect(cashAudit).toContainText("andres");
  await expect(cashAudit).toContainText("C$100.00");

  const movementAudit = page.locator("#auditTableBody tr").filter({
    hasText: "CONFIRMAR_MOVIMIENTO"
  });
  await expect(movementAudit).toHaveCount(1);
  await expect(movementAudit).toContainText("andres");
  await expect(movementAudit).toContainText("C$5.00");
  await expect(movementAudit).toContainText("Entrada controlada desde Caja");

  const paymentAudit = page.locator("#auditTableBody tr").filter({
    hasText: "ABONO_FACTURA"
  });
  await expect(paymentAudit).toHaveCount(1);
  await expect(paymentAudit).toContainText("CLIENTES");
  await expect(paymentAudit).toContainText("andres");
  await expect(paymentAudit).toContainText("C$5.00");
  await expect(paymentAudit).toContainText("Cliente Historial Crédito");
  const today = await page.evaluate(() => new Date().toLocaleDateString());
  await expect(paymentAudit).toContainText(today);
});

test("Historial identifica al vendedor y exige autorización para acceder con su rol", async ({ page }) => {
  await iniciarSesion(page);
  await crearProductoDesdeUI(page, "HISTORY-SELLER-001", "Producto de vendedor");

  await page.locator("#logoutBtn").click();
  await expect(page.locator("#loginScreen")).toBeVisible();
  await page.locator("#loginUsername").fill("vendedor1");
  await page.locator("#loginPassword").fill("1234");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();

  await agregarVenta(page, "HISTORY-SELLER-001", "card");
  await expect(page.locator("#ticketModal")).toBeVisible();
  await page.locator("#newSaleBtn").click();

  await page.locator("#navHistoryBtn").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await page.locator("#gestorPassword").fill("4321");
  await page.locator("#authForm button[type='submit']").click();
  await expect(page.locator("#historyView")).toBeVisible();

  const saleRow = page.locator("#historyTableBody tr").first();
  await expect(saleRow).toContainText("vendedor1");
  await expect(saleRow).toContainText("C$15.00");
  const sellerSaleAudit = page.locator("#auditTableBody tr").filter({
    hasText: "NUEVA_VENTA"
  });
  await expect(sellerSaleAudit).toHaveCount(1);
  await expect(sellerSaleAudit).toContainText("vendedor1");
  const historyAuthAudit = page.locator("#auditTableBody tr").filter({
    hasText: "DESBLOQUEO_GESTOR"
  });
  await expect(historyAuthAudit).toHaveCount(1);
  await expect(historyAuthAudit).toContainText("vendedor1");
});

test("Historial conserva todos los registros generados desde la interfaz sin duplicados", async ({ page }) => {
  await iniciarSesion(page);
  await crearProductoDesdeUI(page, "HISTORY-MANY-001", "Producto de muchas ventas", "12");

  for (let index = 0; index < 12; index += 1) {
    await agregarVenta(page, "HISTORY-MANY-001", "transfer");
    await expect(page.locator("#ticketModal")).toBeVisible();
    await page.locator("#newSaleBtn").click();
  }

  await abrirHistorial(page);
  await expect(page.locator("#historyTableBody tr")).toHaveCount(12);
  await expect(page.locator("#auditTableBody tr").filter({ hasText: "NUEVA_VENTA" })).toHaveCount(12);
  await expect(page.locator("#summaryTotalSales")).toHaveText("C$180.00");
  await expect(page.locator("#summaryTransferSales")).toHaveText("C$180.00");

  await page.reload();
  await iniciarSesion(page);
  await abrirHistorial(page);
  await expect(page.locator("#historyTableBody tr")).toHaveCount(12);
  await expect(page.locator("#auditTableBody tr").filter({ hasText: "NUEVA_VENTA" })).toHaveCount(12);
});
