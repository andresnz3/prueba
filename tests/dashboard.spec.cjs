const fs = require("node:fs/promises");
const zlib = require("node:zlib");
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

async function iniciarSesion(page, username = "andres", password = "4321") {
  await page.goto("/");
  await page.locator("#loginUsername").fill(username);
  await page.locator("#loginPassword").fill(password);
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
}

async function abrirDashboard(page) {
  await page.locator("#navDashboardBtn").click();
  await expect(page.locator("#dashboardView")).toBeVisible();
}

async function cerrarAlerta(page) {
  await expect(page.locator("#customAlertModal")).toBeVisible();
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#customAlertModal")).toBeHidden();
}

async function crearProducto(page, barcode, name, stock, minStock) {
  await page.locator("#navInventoryBtn").click();
  await page.locator("#addNewProductBtn").click();
  await page.locator("#prodBarcode").fill(barcode);
  await page.locator("#prodName").fill(name);
  await page.locator("#prodCost").fill("10.25");
  await page.locator("#prodRetail").fill("15.25");
  await page.locator("#prodWholesale").fill("13.25");
  await page.locator("#prodStock").fill(String(stock));
  await page.locator("#prodMinStock").fill(String(minStock));
  await page.locator("#productForm button[type='submit']").click();
  await expect(page.locator("#productModal")).toBeHidden();
  await cerrarAlerta(page);
}

async function crearCliente(page, name) {
  await page.locator("#navClientsBtn").click();
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientName").fill(name);
  await page.locator("#clientLimit").fill("500");
  await page.locator("#clientDebt").fill("0");
  await page.locator("#clientForm button[type='submit']").click();
  const row = page.locator("#clientsTableBody tr").filter({ hasText: name });
  await expect(row).toBeVisible();
  return (await row.locator("td").first().innerText()).split("\n")[0];
}

async function crearProveedor(page, name) {
  await page.locator("#navSuppliersBtn").click();
  await page.locator("#addNewSupplierBtn").click();
  await page.locator("#suppName").fill(name);
  await page.locator("#suppContact").fill("Contacto Dashboard");
  await page.locator("#suppPhone").fill("88880002");
  await page.locator("#supplierForm button[type='submit']").click();
  await cerrarAlerta(page);
}

async function abrirCaja(page) {
  await page.locator("#navCajaBtn").click();
  await page.locator("#cajaEfectivoInicialInput").fill("100");
  await page.locator("#abrirCajaBtn").click();
  await expect(page.locator("#cajaAbiertaBox")).toBeVisible();
}

async function registrarCompraCredito(page, supplier, product) {
  await page.locator("#navPurchasesBtn").click();
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchSupplier").fill(supplier);
  await page.locator("#purchInvoice").fill("DASH-CREDIT-001");
  await page.locator("#purchType").selectOption("credito");
  await page.locator("#purchProductTemp").fill(product);
  await page.locator("#purchQtyTemp").fill("1");
  await page.locator("#purchCostTemp").fill("10.25");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();
  await expect(page.locator("#purchaseModal")).toBeHidden();
  await cerrarAlerta(page);
}

async function registrarVenta(page, barcode, method, clientId) {
  await page.locator("#navSalesBtn").click();
  await page.locator(`input[name="paymentMethod"][value="${method}"]`).check();
  if (method === "credit") {
    await page.locator("#creditClientSelect").selectOption(clientId);
  }
  await page.locator("#barcodeInput").fill(barcode);
  await page.locator("#addBarcodeBtn").click();
  await expect(page.locator("#cartItems")).not.toContainText("Carrito vacío");
  await page.locator("#processSaleBtn").click();
  if (method === "cash") {
    await expect(page.locator("#cashModal")).toBeVisible();
    await page.locator("#cashReceivedInput").fill("20");
    await page.locator("#confirmCashBtn").click();
  }
  await expect(page.locator("#ticketModal")).toBeVisible();
  await expect(page.locator("#ticketContent")).toContainText("C$15.25");
  await page.locator("#newSaleBtn").click();
  await expect(page.locator("#ticketModal")).toBeHidden();
}

async function leerEntradaZip(fileBuffer, nombreObjetivo) {
  let endOffset = -1;
  for (let offset = fileBuffer.length - 22; offset >= Math.max(0, fileBuffer.length - 65557); offset -= 1) {
    if (fileBuffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("El XLSX descargado no tiene directorio ZIP.");

  const entryCount = fileBuffer.readUInt16LE(endOffset + 10);
  let directoryOffset = fileBuffer.readUInt32LE(endOffset + 16);
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (fileBuffer.readUInt32LE(directoryOffset) !== 0x02014b50) {
      throw new Error("El XLSX descargado tiene un directorio ZIP inválido.");
    }
    const method = fileBuffer.readUInt16LE(directoryOffset + 10);
    const compressedSize = fileBuffer.readUInt32LE(directoryOffset + 20);
    const nameLength = fileBuffer.readUInt16LE(directoryOffset + 28);
    const extraLength = fileBuffer.readUInt16LE(directoryOffset + 30);
    const commentLength = fileBuffer.readUInt16LE(directoryOffset + 32);
    const name = fileBuffer.toString("utf8", directoryOffset + 46, directoryOffset + 46 + nameLength);
    const localOffset = fileBuffer.readUInt32LE(directoryOffset + 42);
    if (name === nombreObjetivo) {
      const localNameLength = fileBuffer.readUInt16LE(localOffset + 26);
      const localExtraLength = fileBuffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = fileBuffer.subarray(dataOffset, dataOffset + compressedSize);
      if (method === 0) return compressed.toString("utf8");
      if (method === 8) return zlib.inflateRawSync(compressed).toString("utf8");
      throw new Error(`Método de compresión XLSX no soportado: ${method}`);
    }
    directoryOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`No se encontró una entrada XLSX: ${nombreObjetivo}`);
}

async function contenidoExportado(download) {
  const workbook = await fs.readFile(await download.path());
  const sheet = await leerEntradaZip(workbook, "xl/worksheets/sheet1.xml");
  let sharedStrings = "";
  try {
    sharedStrings = await leerEntradaZip(workbook, "xl/sharedStrings.xml");
  } catch (error) {
    if (!error.message.startsWith("No se encontró una entrada XLSX:")) throw error;
  }
  return `${sheet}\n${sharedStrings}`;
}

test("Dashboard de gestor carga sus indicadores y resumen vacíos", async ({ page }) => {
  await iniciarSesion(page);
  await abrirDashboard(page);

  for (const [id, value] of [
    ["dashGananciaVentas", "C$0.00"],
    ["dashGananciaCosto", "C$0.00"],
    ["dashGananciaBruta", "C$0.00"],
    ["dashGananciaGastos", "C$0.00"],
    ["dashGananciaEstimada", "C$0.00"],
    ["dashVentasHoy", "C$0.00"],
    ["dashVentasMes", "C$0.00"],
    ["dashGanancia", "C$0.00"],
    ["dashProdsVendidos", "0 uds."],
    ["dashBajoStock", "0"],
    ["dashCxC", "C$0.00"],
    ["dashCxP", "C$0.00"],
    ["dashGastos", "C$0.00"]
  ]) {
    await expect(page.locator(`#${id}`)).toHaveText(value);
  }
  await expect(page.locator("#dashVendedoresBody tr")).toHaveCount(1);
  await expect(page.locator("#dashVendedoresBody")).toContainText("Sin registros.");
  await expect(page.locator("#dashboardView input, #dashboardView select")).toHaveCount(0);
  await expect(page.locator('#dashboardView button[onclick="window.generarExcelDashboard()"]')).toBeVisible();
});

test("Dashboard refleja ventas, crédito, abonos, compras, gastos, stock y anulaciones", async ({ page }) => {
  await iniciarSesion(page);
  const barcode = "DASH-OPS-001";
  const product = "Producto Dashboard";
  const client = "Cliente Dashboard";
  const supplier = "Proveedor Dashboard";

  await crearProducto(page, barcode, product, 1, 1);
  await abrirDashboard(page);
  await expect(page.locator("#dashBajoStock")).toHaveText("1");

  const clientId = await crearCliente(page, client);
  await crearProveedor(page, supplier);
  await abrirCaja(page);
  await registrarCompraCredito(page, supplier, product);

  await abrirDashboard(page);
  await expect(page.locator("#dashCxP")).toHaveText("C$10.25");
  await expect(page.locator("#dashBajoStock")).toHaveText("0");

  await registrarVenta(page, barcode, "cash");
  await abrirDashboard(page);
  await expect(page.locator("#dashVentasHoy")).toHaveText("C$15.25");
  await expect(page.locator("#dashVentasMes")).toHaveText("C$15.25");
  await expect(page.locator("#dashGananciaVentas")).toHaveText("C$15.25");
  await expect(page.locator("#dashGananciaCosto")).toHaveText("C$10.25");
  await expect(page.locator("#dashGananciaBruta")).toHaveText("C$5.00");
  await expect(page.locator("#dashGananciaEstimada")).toHaveText("C$5.00");
  await expect(page.locator("#dashProdsVendidos")).toHaveText("1 uds.");
  await expect(page.locator("#dashBajoStock")).toHaveText("1");

  await registrarVenta(page, barcode, "credit", clientId);
  await page.locator("#navInventoryBtn").click();
  const depletedProduct = page.locator("#inventoryTableBody tr").filter({ hasText: barcode });
  await expect(depletedProduct).toContainText("0 (Agotado)");
  await abrirDashboard(page);
  await expect(page.locator("#dashVentasHoy")).toHaveText("C$30.50");
  await expect(page.locator("#dashVentasMes")).toHaveText("C$30.50");
  await expect(page.locator("#dashGananciaVentas")).toHaveText("C$30.50");
  await expect(page.locator("#dashGananciaCosto")).toHaveText("C$20.50");
  await expect(page.locator("#dashGananciaBruta")).toHaveText("C$10.00");
  await expect(page.locator("#dashGanancia")).toHaveText("C$10.00");
  await expect(page.locator("#dashProdsVendidos")).toHaveText("2 uds.");
  await expect(page.locator("#dashBajoStock")).toHaveText("1");
  await expect(page.locator("#dashCxC")).toHaveText("C$15.25");

  await page.locator("#navClientsBtn").click();
  const clientRow = page.locator("#clientsTableBody tr").filter({ hasText: client });
  await clientRow.getByRole("button", { name: "Historial" }).click();
  const creditInvoice = page.locator("#statementTableBody tr").filter({ hasText: "Factura de crédito" });
  await creditInvoice.getByRole("button", { name: "Abonar" }).click();
  await page.locator("#paySaleAmount").fill("5.25");
  await page.locator("#paySaleMethod").selectOption("tarjeta");
  await page.locator("#paymentSaleForm button[type='submit']").click();
  await cerrarAlerta(page);
  await page.locator("#statementModal .close-modal-btn").click();

  await page.locator("#navPayablesBtn").click();
  const payable = page.locator("#payablesTableBody tr").filter({ hasText: supplier });
  await payable.getByRole("button", { name: "Ver Facturas" }).click();
  const creditPurchase = page.locator("#statementTableBody tr").filter({ hasText: "DASH-CREDIT-001" });
  await creditPurchase.getByRole("button", { name: "Abonar" }).click();
  await page.locator("#payInvoiceAmount").fill("5.25");
  await page.locator("#payInvoiceMethod").selectOption("transferencia");
  await page.locator("#paymentInvoiceForm button[type='submit']").click();
  await cerrarAlerta(page);
  await page.locator("#statementModal .close-modal-btn").click();

  await page.locator("#navGastosBtn").click();
  await page.locator("#gastoCategoria").selectOption("Servicios Básicos");
  await page.locator("#gastoMetodo").selectOption("banco");
  await page.locator("#gastoDescripcion").fill("Gasto Dashboard válido");
  await page.locator("#gastoMonto").fill("2.35");
  await page.locator("#formRegistrarGasto button[type='submit']").click();
  await cerrarAlerta(page);
  await page.locator("#gastoCategoria").selectOption("Transporte");
  await page.locator("#gastoMetodo").selectOption("banco");
  await page.locator("#gastoDescripcion").fill("Gasto Dashboard anulado");
  await page.locator("#gastoMonto").fill("3.15");
  await page.locator("#formRegistrarGasto button[type='submit']").click();
  await cerrarAlerta(page);
  const voidExpense = page.locator("#gastosTableBody tr").filter({ hasText: "Gasto Dashboard anulado" });
  await voidExpense.getByRole("button", { name: "Anular" }).click();
  await page.locator("#anularRegistroMotivo").fill("Registro de prueba inválido");
  await page.locator("#anularRegistroForm button[type='submit']").click();
  await cerrarAlerta(page);

  await abrirDashboard(page);
  await expect(page.locator("#dashCxC")).toHaveText("C$10.00");
  await expect(page.locator("#dashCxP")).toHaveText("C$5.00");
  await expect(page.locator("#dashGastos")).toHaveText("C$2.35");
  await expect(page.locator("#dashGananciaGastos")).toHaveText("C$2.35");
  await expect(page.locator("#dashGananciaEstimada")).toHaveText("C$7.65");

  await page.locator("#navHistoryBtn").click();
  const cashSale = page.locator("#historyTableBody tr").filter({ hasText: "EFECTIVO" });
  await cashSale.getByRole("button", { name: "Anular" }).click();
  await page.locator("#anularVentaMotivo").fill("Venta repetida");
  await page.locator("#anularVentaForm button[type='submit']").click();
  await cerrarAlerta(page);

  await abrirDashboard(page);
  await expect(page.locator("#dashVentasHoy")).toHaveText("C$15.25");
  await expect(page.locator("#dashVentasMes")).toHaveText("C$15.25");
  await expect(page.locator("#dashGananciaVentas")).toHaveText("C$15.25");
  await expect(page.locator("#dashGananciaCosto")).toHaveText("C$10.25");
  await expect(page.locator("#dashGananciaBruta")).toHaveText("C$5.00");
  await expect(page.locator("#dashGananciaGastos")).toHaveText("C$2.35");
  await expect(page.locator("#dashGananciaEstimada")).toHaveText("C$2.65");
  await expect(page.locator("#dashGanancia")).toHaveText("C$2.65");
  await expect(page.locator("#dashProdsVendidos")).toHaveText("1 uds.");
  await expect(page.locator("#dashBajoStock")).toHaveText("1");
  await expect(page.locator("#dashCxC")).toHaveText("C$10.00");
  await expect(page.locator("#dashCxP")).toHaveText("C$5.00");
  await expect(page.locator("#dashGastos")).toHaveText("C$2.35");
  const sellerRow = page.locator("#dashVendedoresBody tr").filter({ hasText: "andres" });
  await expect(sellerRow).toHaveCount(1);
  await expect(sellerRow).toContainText("1");
  await expect(sellerRow).toContainText("C$15.25");
  await expect(page.locator("#dashVendedoresBody")).not.toContainText("Venta repetida");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('#dashboardView button[onclick="window.generarExcelDashboard()"]').click()
  ]);
  expect(download.suggestedFilename()).toMatch(/^dashboard_.*\.xlsx$/);
  const exported = await contenidoExportado(download);
  for (const value of [
    "Ventas Hoy",
    "15.25",
    "Ventas Mes",
    "Ganancia Estimada",
    "2.65",
    "1 uds.",
    "Bajo Stock",
    "Crédito Pendiente (CxC)",
    "10",
    "Cuentas por Pagar (CxP)",
    "5",
    "Gastos Totales",
    "2.35"
  ]) {
    expect(exported).toContain(value);
  }

  await page.locator("#navHistoryBtn").click();
  await page.locator("#navDashboardBtn").click();
  await expect(page.locator("#dashGananciaEstimada")).toHaveText("C$2.65");
  await page.reload();
  await iniciarSesion(page);
  await abrirDashboard(page);
  await expect(page.locator("#dashGananciaVentas")).toHaveText("C$15.25");
  await expect(page.locator("#dashGananciaEstimada")).toHaveText("C$2.65");
  await expect(page.locator("#dashCxC")).toHaveText("C$10.00");
  await expect(page.locator("#dashCxP")).toHaveText("C$5.00");
  await expect(page.locator("#dashGastos")).toHaveText("C$2.35");
  await expect(page.locator("#dashVendedoresBody tr")).toHaveCount(1);
});

test("Dashboard agrega muchos movimientos sin duplicarlos y refleja stock cero", async ({ page }) => {
  await iniciarSesion(page);
  await abrirCaja(page);
  const barcode = "DASH-MANY-001";
  await crearProducto(page, barcode, "Producto movimientos Dashboard", 10, 1);

  for (let sale = 0; sale < 10; sale += 1) {
    await registrarVenta(page, barcode, "card");
  }

  await page.locator("#navInventoryBtn").click();
  const productRow = page.locator("#inventoryTableBody tr").filter({ hasText: barcode });
  await expect(productRow).toContainText("0 (Agotado)");

  await abrirDashboard(page);
  await expect(page.locator("#dashVentasHoy")).toHaveText("C$152.50");
  await expect(page.locator("#dashVentasMes")).toHaveText("C$152.50");
  await expect(page.locator("#dashGananciaVentas")).toHaveText("C$152.50");
  await expect(page.locator("#dashGananciaCosto")).toHaveText("C$102.50");
  await expect(page.locator("#dashGananciaBruta")).toHaveText("C$50.00");
  await expect(page.locator("#dashGananciaEstimada")).toHaveText("C$50.00");
  await expect(page.locator("#dashProdsVendidos")).toHaveText("10 uds.");
  await expect(page.locator("#dashBajoStock")).toHaveText("1");
  const sellerRow = page.locator("#dashVendedoresBody tr").filter({ hasText: "andres" });
  await expect(sellerRow).toHaveCount(1);
  await expect(sellerRow).toContainText("10");
  await expect(sellerRow).toContainText("C$152.50");

  await page.reload();
  await iniciarSesion(page);
  await abrirDashboard(page);
  await expect(page.locator("#dashVentasHoy")).toHaveText("C$152.50");
  await expect(page.locator("#dashProdsVendidos")).toHaveText("10 uds.");
  await expect(page.locator("#dashVendedoresBody tr")).toHaveCount(1);
});

test("vendedor requiere autorización para Dashboard y la pierde al salir", async ({ page }) => {
  await iniciarSesion(page, "vendedor1", "1234");
  await page.locator("#navDashboardBtn").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await expect(page.locator("#dashboardView")).toBeHidden();

  const gestorPassword = page.locator("#gestorPassword");
  await expect(gestorPassword).toBeFocused();
  await gestorPassword.fill("incorrecta");
  await expect(gestorPassword).toHaveValue("incorrecta");
  await page.locator("#authForm button[type='submit']").click();
  await expect(page.locator("#authError")).toBeVisible();
  await expect(page.locator("#dashboardView")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("posLoginFailState"))).toBeNull();

  await page.locator("#authModal .close-modal-btn").click();
  await expect(page.locator("#authModal")).toBeHidden();
  await expect(page.locator("#salesView")).toBeVisible();
  await page.locator("#navDashboardBtn").click();
  await page.locator("#gestorPassword").fill("4321");
  await page.locator("#authForm button[type='submit']").click();
  await expect(page.locator("#dashboardView")).toBeVisible();
  await expect(page.locator("#roleBadge")).toHaveText("Usuario");

  await page.locator("#navSalesBtn").click();
  await expect(page.locator("#salesView")).toBeVisible();
  await page.locator("#navDashboardBtn").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await expect(page.locator("#dashboardView")).toBeHidden();
});
