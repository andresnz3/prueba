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

async function abrirReportes(page) {
  await page.locator("#navReportesBtn").click();
  await expect(page.locator("#reportesView")).toBeVisible();
}

async function cerrarAlerta(page) {
  await expect(page.locator("#customAlertModal")).toBeVisible();
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#customAlertModal")).toBeHidden();
}

async function crearProducto(page, barcode, name, stock = "10") {
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
  await page.locator("#suppContact").fill("Contacto Reportes");
  await page.locator("#suppPhone").fill("88880001");
  await page.locator("#supplierForm button[type='submit']").click();
  await cerrarAlerta(page);
}

async function abrirCaja(page, amount) {
  await page.locator("#navCajaBtn").click();
  await page.locator("#cajaEfectivoInicialInput").fill(String(amount));
  await page.locator("#abrirCajaBtn").click();
  await expect(page.locator("#cajaAbiertaBox")).toBeVisible();
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
    await page.locator("#cashReceivedInput").fill("100");
    await page.locator("#confirmCashBtn").click();
  }
  await expect(page.locator("#ticketModal")).toBeVisible();
  await page.locator("#newSaleBtn").click();
}

async function registrarCompra(page, supplier, invoice, type, quantity, product) {
  await page.locator("#navPurchasesBtn").click();
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchSupplier").fill(supplier);
  await page.locator("#purchInvoice").fill(invoice);
  await page.locator("#purchType").selectOption(type);
  await page.locator("#purchProductTemp").fill(product);
  await page.locator("#purchQtyTemp").fill(String(quantity));
  await page.locator("#purchCostTemp").fill("10");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();
  await expect(page.locator("#purchaseModal")).toBeHidden();
  await cerrarAlerta(page);
}

async function readZipEntry(fileBuffer, targetName) {
  let endOffset = -1;
  for (let offset = fileBuffer.length - 22; offset >= Math.max(0, fileBuffer.length - 65557); offset -= 1) {
    if (fileBuffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("Downloaded XLSX file has no ZIP directory.");

  const entryCount = fileBuffer.readUInt16LE(endOffset + 10);
  let directoryOffset = fileBuffer.readUInt32LE(endOffset + 16);
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (fileBuffer.readUInt32LE(directoryOffset) !== 0x02014b50) {
      throw new Error("Downloaded XLSX file has an invalid ZIP directory.");
    }
    const method = fileBuffer.readUInt16LE(directoryOffset + 10);
    const compressedSize = fileBuffer.readUInt32LE(directoryOffset + 20);
    const nameLength = fileBuffer.readUInt16LE(directoryOffset + 28);
    const extraLength = fileBuffer.readUInt16LE(directoryOffset + 30);
    const commentLength = fileBuffer.readUInt16LE(directoryOffset + 32);
    const name = fileBuffer.toString("utf8", directoryOffset + 46, directoryOffset + 46 + nameLength);
    const localOffset = fileBuffer.readUInt32LE(directoryOffset + 42);
    if (name === targetName) {
      const localNameLength = fileBuffer.readUInt16LE(localOffset + 26);
      const localExtraLength = fileBuffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = fileBuffer.subarray(dataOffset, dataOffset + compressedSize);
      if (method === 0) return compressed.toString("utf8");
      if (method === 8) return zlib.inflateRawSync(compressed).toString("utf8");
      throw new Error(`Unsupported XLSX ZIP compression method: ${method}`);
    }
    directoryOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`XLSX entry was not found: ${targetName}`);
}

async function extractWorkbookText(download) {
  const file = await download.path();
  const workbook = await fs.readFile(file);
  const sheets = [await readZipEntry(workbook, "xl/worksheets/sheet1.xml")];
  try {
    sheets.push(await readZipEntry(workbook, "xl/worksheets/sheet2.xml"));
  } catch (error) {
    if (!error.message.startsWith("XLSX entry was not found:")) throw error;
  }
  let sharedStrings = "";
  try {
    sharedStrings = await readZipEntry(workbook, "xl/sharedStrings.xml");
  } catch (error) {
    if (!error.message.startsWith("XLSX entry was not found:")) throw error;
  }
  return `${sheets.join("\n")}\n${sharedStrings}`;
}

test("Reportes carga valores cero, estados vacíos, pestañas e inventario", async ({ page }) => {
  await iniciarSesion(page);
  await abrirReportes(page);

  for (const [id, expected] of [
    ["repVentas", "C$0.00"],
    ["repCompras", "C$0.00"],
    ["repGastos", "C$0.00"],
    ["repUtilidad", "C$0.00"],
    ["repCxC", "C$0.00"],
    ["repCxP", "C$0.00"]
  ]) {
    await expect(page.locator(`#${id}`)).toHaveText(expected);
  }
  await expect(page.locator("#repVentasMetodoBody")).toContainText("Sin ventas.");
  await expect(page.locator("#repTopProductosBody")).toContainText("Sin datos.");
  await expect(page.locator("#repComprasBody")).toContainText("Sin compras.");
  await expect(page.locator("#repInventarioBody")).toContainText("Sin productos.");
  await expect(page.locator("#repCajaBody")).toContainText("Sin cierres.");
  await expect(page.locator("#repGastosCategoriaBody")).toContainText("Sin gastos.");
  await expect(page.locator("#repCxCBody")).toContainText("Sin cuentas por cobrar.");
  await expect(page.locator("#repCxPBody")).toContainText("Sin cuentas por pagar.");

  const tabs = [
    ["repVentasBox", "Ventas"],
    ["repVendedoresBox", "Vendedores"],
    ["repComprasBox", "Compras"],
    ["repInventarioBox", "Inventario"],
    ["repCajaBox", "Caja"],
    ["repGastosBox", "Gastos"],
    ["repCxCBox", "Cuentas por Cobrar"],
    ["repCxPBox", "Cuentas por Pagar"]
  ];
  for (const [viewId, name] of tabs) {
    await page.locator(".rep-subtab").getByText(name, { exact: true }).click();
    await expect(page.locator(`#${viewId}`)).toBeVisible();
  }

  await expect(page.locator("#reporteDesdeInput")).toHaveAttribute("type", "date");
  await expect(page.locator("#reporteHastaInput")).toHaveAttribute("type", "date");
  await expect(page.getByRole("button", { name: "Hoy", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Esta Semana" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Este Mes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Todo", exact: true })).toBeVisible();
  await expect(page.locator('button[onclick*="Reporte_Ventas"]')).toBeVisible();
  await expect(page.locator('button[onclick*="Reporte_Vendedores"]')).toBeVisible();
});

test("Reportes calcula todas las métricas de operaciones conocidas y excluye anulaciones", async ({ page }) => {
  await iniciarSesion(page);
  const product = "Producto Reportes";
  await crearProducto(page, "REPORTS-OPS-001", product);
  const clientId = await crearCliente(page, "Cliente Reportes");
  const supplier = "Proveedor Reportes";
  await crearProveedor(page, supplier);
  await abrirCaja(page, "100");

  await registrarCompra(page, supplier, "REP-CASH-001", "contado", 2, product);
  await registrarCompra(page, supplier, "REP-CREDIT-001", "credito", 3, product);
  await registrarCompra(page, supplier, "REP-VOID-001", "contado", 1, product);
  await page.locator("#navPurchasesBtn").click();
  const voidPurchase = page.locator("#purchasesTableBody tr").filter({ hasText: "REP-VOID-001" });
  await voidPurchase.getByRole("button", { name: "Anular" }).click();
  await page.locator("#anularRegistroMotivo").fill("Compra duplicada");
  await page.locator("#anularRegistroForm button[type='submit']").click();
  await cerrarAlerta(page);

  await registrarVenta(page, "REPORTS-OPS-001", "cash");
  await registrarVenta(page, "REPORTS-OPS-001", "card");
  await registrarVenta(page, "REPORTS-OPS-001", "transfer");
  await registrarVenta(page, "REPORTS-OPS-001", "credit", clientId);

  await page.locator("#navHistoryBtn").click();
  const voidSale = page.locator("#historyTableBody tr").filter({ hasText: "#3" });
  await voidSale.getByRole("button", { name: "Anular" }).click();
  await page.locator("#anularVentaMotivo").fill("Venta duplicada");
  await page.locator("#anularVentaForm button[type='submit']").click();
  await cerrarAlerta(page);

  await page.locator("#navClientsBtn").click();
  const clientRow = page.locator("#clientsTableBody tr").filter({ hasText: "Cliente Reportes" });
  await clientRow.getByRole("button", { name: "Historial" }).click();
  const creditInvoice = page.locator("#statementTableBody tr").filter({ hasText: "Factura de crédito" });
  await creditInvoice.getByRole("button", { name: "Abonar" }).click();
  await page.locator("#paySaleAmount").fill("5");
  await page.locator("#paySaleMethod").selectOption("tarjeta");
  await page.locator("#paymentSaleForm button[type='submit']").click();
  await cerrarAlerta(page);
  await page.locator("#statementModal .close-modal-btn").click();

  await page.locator("#navPayablesBtn").click();
  const payable = page.locator("#payablesTableBody tr").filter({ hasText: supplier });
  await payable.getByRole("button", { name: "Ver Facturas" }).click();
  const creditPurchase = page.locator("#statementTableBody tr").filter({ hasText: "REP-CREDIT-001" });
  await creditPurchase.getByRole("button", { name: "Abonar" }).click();
  await page.locator("#payInvoiceAmount").fill("5");
  await page.locator("#payInvoiceMethod").selectOption("transferencia");
  await page.locator("#paymentInvoiceForm button[type='submit']").click();
  await cerrarAlerta(page);
  await page.locator("#statementModal .close-modal-btn").click();

  await page.locator("#navGastosBtn").click();
  await page.locator("#gastoCategoria").selectOption("Servicios Básicos");
  await page.locator("#gastoMetodo").selectOption("caja");
  await page.locator("#gastoDescripcion").fill("Gasto Reportes Efectivo");
  await page.locator("#gastoMonto").fill("2.35");
  await page.locator("#formRegistrarGasto button[type='submit']").click();
  await cerrarAlerta(page);
  await page.locator("#gastoCategoria").selectOption("Transporte");
  await page.locator("#gastoMetodo").selectOption("banco");
  await page.locator("#gastoDescripcion").fill("Gasto Reportes Anulado");
  await page.locator("#gastoMonto").fill("3.15");
  await page.locator("#formRegistrarGasto button[type='submit']").click();
  await cerrarAlerta(page);
  const voidExpense = page.locator("#gastosTableBody tr").filter({ hasText: "Gasto Reportes Anulado" });
  await voidExpense.getByRole("button", { name: "Anular" }).click();
  await page.locator("#anularRegistroMotivo").fill("Gasto no válido");
  await page.locator("#anularRegistroForm button[type='submit']").click();
  await cerrarAlerta(page);

  await page.locator("#navCajaBtn").click();
  await page.locator("#cajaMovimientoConcepto").fill("Entrada Reportes");
  await page.locator("#cajaMovimientoMonto").fill("4.25");
  await page.locator("#registrarEntradaBtn").click();
  await page.locator("#cerrarCajaBtn").click();
  await page.locator("#cajaEfectivoRealInput").fill("116.90");
  await page.locator("#confirmCierreCajaBtn").click();
  await cerrarAlerta(page);

  await abrirReportes(page);
  await expect(page.locator("#repVentas")).toHaveText("C$45.00");
  await expect(page.locator("#repCompras")).toHaveText("C$50.00");
  await expect(page.locator("#repGastos")).toHaveText("C$2.35");
  await expect(page.locator("#repUtilidad")).toHaveText("C$12.65");
  await expect(page.locator("#repCxC")).toHaveText("C$10.00");
  await expect(page.locator("#repCxP")).toHaveText("C$25.00");

  const paymentRows = page.locator("#repVentasMetodoBody tr");
  await expect(paymentRows).toHaveCount(3);
  await expect(paymentRows.filter({ hasText: "Efectivo" })).toContainText("C$15.00");
  await expect(paymentRows.filter({ hasText: "Tarjeta" })).toContainText("C$15.00");
  await expect(paymentRows.filter({ hasText: "Crédito" })).toContainText("C$15.00");
  await expect(page.locator("#repVentasMetodoBody")).not.toContainText("Transferencia");
  await expect(page.locator("#repTopProductosBody tr")).toHaveCount(1);
  await expect(page.locator("#repTopProductosBody")).toContainText(product);
  await expect(page.locator("#repTopProductosBody")).toContainText("3");
  await expect(page.locator("#repTopProductosBody")).toContainText("C$45.00");

  await page.locator('.rep-subtab[data-target="repVendedoresBox"]').click();
  const sellerRow = page.locator("#repVendedoresBody tr").filter({ hasText: "andres" });
  await expect(sellerRow).toContainText("3");
  await expect(sellerRow).toContainText("C$15.00");
  await expect(sellerRow).toContainText("C$45.00");

  await page.locator('.rep-subtab[data-target="repComprasBox"]').click();
  await expect(page.locator("#repComprasBody tr")).toHaveCount(2);
  await expect(page.locator("#repComprasBody")).toContainText("REP-CASH-001");
  await expect(page.locator("#repComprasBody")).toContainText("REP-CREDIT-001");
  await expect(page.locator("#repComprasBody")).not.toContainText("REP-VOID-001");
  await expect(page.locator("#repComprasBody")).toContainText(supplier);
  await expect(page.locator("#repComprasBody")).toContainText("C$20.00");
  await expect(page.locator("#repComprasBody")).toContainText("C$30.00");

  await page.locator('.rep-subtab[data-target="repInventarioBox"]').click();
  const inventoryRow = page.locator("#repInventarioBody tr").filter({ hasText: product });
  await expect(inventoryRow).toContainText("12");
  await expect(inventoryRow).toContainText("C$10.00");
  await expect(inventoryRow).toContainText("C$120.00");

  await page.locator('.rep-subtab[data-target="repCajaBox"]').click();
  await expect(page.locator("#repCajaBody tr")).toHaveCount(1);
  await expect(page.locator("#repCajaBody")).toContainText("andres");
  await expect(page.locator("#repCajaBody")).toContainText("C$116.90");
  await expect(page.locator("#repCajaBody")).toContainText("C$0.00");

  await page.locator('.rep-subtab[data-target="repGastosBox"]').click();
  await expect(page.locator("#repGastosCategoriaBody tr")).toHaveCount(1);
  await expect(page.locator("#repGastosCategoriaBody")).toContainText("Servicios Básicos");
  await expect(page.locator("#repGastosCategoriaBody")).toContainText("1");
  await expect(page.locator("#repGastosCategoriaBody")).toContainText("C$2.35");
  await expect(page.locator("#repGastosCategoriaBody")).not.toContainText("Transporte");

  await page.locator('.rep-subtab[data-target="repCxCBox"]').click();
  await expect(page.locator("#repCxCBody tr")).toHaveCount(1);
  await expect(page.locator("#repCxCBody")).toContainText("Cliente Reportes");
  await expect(page.locator("#repCxCBody")).toContainText("C$10.00");

  await page.locator('.rep-subtab[data-target="repCxPBox"]').click();
  await expect(page.locator("#repCxPBody tr")).toHaveCount(1);
  await expect(page.locator("#repCxPBody")).toContainText(supplier);
  await expect(page.locator("#repCxPBody")).toContainText("C$25.00");

  const yesterday = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  await page.locator("#reporteDesdeInput").fill(yesterday);
  await page.locator("#reporteHastaInput").fill(yesterday);
  await page.locator("#aplicarFiltroReporteBtn").click();
  await expect(page.locator("#repVentas")).toHaveText("C$0.00");
  await expect(page.locator("#repCompras")).toHaveText("C$0.00");
  await expect(page.locator("#repGastos")).toHaveText("C$0.00");
  await expect(page.locator("#repUtilidad")).toHaveText("C$0.00");
  await expect(page.locator("#repCxC")).toHaveText("C$10.00");
  await expect(page.locator("#repCxP")).toHaveText("C$25.00");
  await page.locator('.rep-subtab[data-target="repInventarioBox"]').click();
  await expect(page.locator("#repInventarioBody tr").filter({ hasText: product })).toContainText("12");
  await page.locator('.rep-subtab[data-target="repCajaBox"]').click();
  await expect(page.locator("#repCajaBody")).toContainText("Sin cierres.");

  await page.locator("#filtroTodoBtn").click();
  await expect(page.locator("#repVentas")).toHaveText("C$45.00");

  await page.reload();
  await iniciarSesion(page);
  await abrirReportes(page);
  await expect(page.locator("#repVentas")).toHaveText("C$45.00");
  await expect(page.locator("#repCompras")).toHaveText("C$50.00");
  await expect(page.locator("#repGastos")).toHaveText("C$2.35");
  await expect(page.locator("#repCxC")).toHaveText("C$10.00");
  await expect(page.locator("#repCxP")).toHaveText("C$25.00");
});

test("anular abonos de clientes y proveedores restaura saldos y concilia Caja sin duplicados", async ({ page }) => {
  await iniciarSesion(page);
  const product = "Producto anulación de abonos";
  const client = "Cliente anulación de abonos";
  const supplier = "Proveedor anulación de abonos";
  await crearProducto(page, "REPORTS-VOID-PAY-001", product);
  const clientId = await crearCliente(page, client);
  await crearProveedor(page, supplier);
  await abrirCaja(page, "100");
  await registrarCompra(page, supplier, "REP-VOID-PAY-001", "credito", 1, product);
  await registrarVenta(page, "REPORTS-VOID-PAY-001", "credit", clientId);

  await page.locator("#navClientsBtn").click();
  let clientRow = page.locator("#clientsTableBody tr").filter({ hasText: client });
  await clientRow.getByRole("button", { name: "Historial" }).click();
  let creditInvoice = page.locator("#statementTableBody tr").filter({ hasText: "Factura de crédito" });
  await creditInvoice.getByRole("button", { name: "Abonar" }).click();
  await page.locator("#paySaleAmount").fill("5");
  await page.locator("#paySaleMethod").selectOption("efectivo");
  await page.locator("#paymentSaleForm button[type='submit']").click();
  await cerrarAlerta(page);
  await page.locator("#statementModal .close-modal-btn").click();

  await page.locator("#navPayablesBtn").click();
  let payable = page.locator("#payablesTableBody tr").filter({ hasText: supplier });
  await payable.getByRole("button", { name: "Ver Facturas" }).click();
  let creditPurchase = page.locator("#statementTableBody tr").filter({ hasText: "REP-VOID-PAY-001" });
  await creditPurchase.getByRole("button", { name: "Abonar" }).click();
  await page.locator("#payInvoiceAmount").fill("5");
  await page.locator("#payInvoiceMethod").selectOption("efectivo");
  await page.locator("#paymentInvoiceForm button[type='submit']").click();
  await cerrarAlerta(page);
  await page.locator("#statementModal .close-modal-btn").click();

  await page.locator("#navClientsBtn").click();
  clientRow = page.locator("#clientsTableBody tr").filter({ hasText: client });
  await clientRow.getByRole("button", { name: "Historial" }).click();
  let clientPayment = page.locator("#statementTableBody tr").filter({ hasText: "Pago recibido por efectivo" });
  await expect(clientPayment).toHaveCount(1);
  await clientPayment.getByRole("button", { name: "Anular" }).click();
  await expect(page.locator("#anularRegistroModal")).toBeVisible();
  await expect(page.locator("#anularRegistroTitulo")).toHaveText("Anular Abono");
  await page.locator("#anularRegistroMotivo").fill("Abono duplicado");
  await page.locator("#anularRegistroForm button[type='submit']").click();
  await cerrarAlerta(page);
  await expect(page.locator("#statementModal")).toBeVisible();
  clientPayment = page.locator("#statementTableBody tr").filter({ hasText: "Pago recibido por efectivo" });
  await expect(clientPayment).toContainText("ANULADO");
  await expect(clientPayment.getByRole("button", { name: "Anular" })).toHaveCount(0);
  await expect(page.locator("#statementModalSubtitle")).toContainText("C$15.00");
  await page.locator("#statementModal .close-modal-btn").click();

  await page.locator("#navPayablesBtn").click();
  payable = page.locator("#payablesTableBody tr").filter({ hasText: supplier });
  await payable.getByRole("button", { name: "Ver Facturas" }).click();
  let supplierPayment = page.locator("#statementTableBody tr").filter({ hasText: "Pago a proveedor por efectivo" });
  await expect(supplierPayment).toHaveCount(1);
  await supplierPayment.getByRole("button", { name: "Anular" }).click();
  await expect(page.locator("#anularRegistroModal")).toBeVisible();
  await expect(page.locator("#anularRegistroTitulo")).toHaveText("Anular Pago a Proveedor");
  await page.locator("#anularRegistroMotivo").fill("Pago duplicado");
  await page.locator("#anularRegistroForm button[type='submit']").click();
  await cerrarAlerta(page);
  await expect(page.locator("#statementModal")).toBeVisible();
  supplierPayment = page.locator("#statementTableBody tr").filter({ hasText: "Pago a proveedor por efectivo" });
  await expect(supplierPayment).toContainText("ANULADO");
  await expect(supplierPayment.getByRole("button", { name: "Anular" })).toHaveCount(0);
  await expect(page.locator("#statementModalSubtitle")).toContainText("C$10.00");
  await page.locator("#statementModal .close-modal-btn").click();

  await page.locator("#navCajaBtn").click();
  for (const concept of [
    "Abono Factura #1: Cliente anulación de abonos",
    "Anulación Abono Cliente: Cliente anulación de abonos - Abono duplicado",
    "Pago Factura REP-VOID-PAY-001: Proveedor anulación de abonos",
    "Anulación Pago Proveedor: Proveedor anulación de abonos - Pago duplicado"
  ]) {
    const movement = page.locator("#cajaMovimientosBody tr").filter({ hasText: concept });
    await expect(movement).toHaveCount(1);
  }

  await page.locator("#navHistoryBtn").click();
  await expect(page.locator("#auditTableBody tr").filter({ hasText: "ANULAR_ABONO" })).toHaveCount(1);
  await expect(page.locator("#auditTableBody tr").filter({ hasText: "ANULAR_PAGO" })).toHaveCount(1);
  await expect(page.locator("#auditTableBody tr").filter({ hasText: "Abono duplicado" })).toContainText(client);
  await expect(page.locator("#auditTableBody tr").filter({ hasText: "Pago duplicado" })).toContainText(supplier);

  await abrirReportes(page);
  await expect(page.locator("#repVentas")).toHaveText("C$15.00");
  await expect(page.locator("#repCompras")).toHaveText("C$10.00");
  await expect(page.locator("#repCxC")).toHaveText("C$15.00");
  await expect(page.locator("#repCxP")).toHaveText("C$10.00");
  await page.reload();
  await iniciarSesion(page);
  await page.locator("#navDashboardBtn").click();
  await expect(page.locator("#dashboardView")).toBeVisible();
  await expect(page.locator("#dashCxC")).toHaveText("C$15.00");
  await expect(page.locator("#dashCxP")).toHaveText("C$10.00");
});

test("Reportes aplica día, semana, mes, todo y rangos manuales incluidos los vacíos", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "REPORTS-PERIOD-001", "Producto períodos");
  await abrirCaja(page, "0");
  await registrarVenta(page, "REPORTS-PERIOD-001", "card");
  await abrirReportes(page);

  const expectedDate = async daysAgo => page.evaluate(days => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }, daysAgo);
  const today = await expectedDate(0);
  const yesterday = await expectedDate(1);
  const thisMonth = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
  });
  const weekStart = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - date.getDay());
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });

  await page.locator("#filtroHoyBtn").click();
  await expect(page.locator("#reporteDesdeInput")).toHaveValue(today);
  await expect(page.locator("#reporteHastaInput")).toHaveValue(today);
  await expect(page.locator("#repVentas")).toHaveText("C$15.00");

  await page.locator("#filtroSemanaBtn").click();
  await expect(page.locator("#reporteDesdeInput")).toHaveValue(weekStart);
  await expect(page.locator("#reporteHastaInput")).toHaveValue(today);
  await expect(page.locator("#repVentas")).toHaveText("C$15.00");

  await page.locator("#filtroMesBtn").click();
  await expect(page.locator("#reporteDesdeInput")).toHaveValue(thisMonth);
  await expect(page.locator("#reporteHastaInput")).toHaveValue(today);
  await expect(page.locator("#repVentas")).toHaveText("C$15.00");

  await page.locator("#filtroTodoBtn").click();
  await expect(page.locator("#reporteDesdeInput")).toHaveValue("2000-01-01");
  await expect(page.locator("#reporteHastaInput")).toHaveValue(today);
  await expect(page.locator("#repVentas")).toHaveText("C$15.00");

  await page.locator("#reporteDesdeInput").fill(yesterday);
  await page.locator("#reporteHastaInput").fill(yesterday);
  await page.locator("#aplicarFiltroReporteBtn").click();
  await expect(page.locator("#repVentas")).toHaveText("C$0.00");
  await expect(page.locator("#repVentasMetodoBody")).toContainText("Sin ventas.");
  await expect(page.locator("#repTopProductosBody")).toContainText("Sin datos.");

  await page.locator("#reporteDesdeInput").fill(today);
  await page.locator("#reporteHastaInput").fill(yesterday);
  await page.locator("#aplicarFiltroReporteBtn").click();
  await expect(page.locator("#repVentas")).toHaveText("C$0.00");

  await page.locator("#filtroHoyBtn").click();
  await expect(page.locator("#repVentas")).toHaveText("C$15.00");
  await page.locator("#navSalesBtn").click();
  await abrirReportes(page);
  await expect(page.locator("#repVentas")).toHaveText("C$15.00");
  await expect(page.locator("#reporteDesdeInput")).toHaveValue(today);
  await expect(page.locator("#reporteHastaInput")).toHaveValue(today);
});

test("Reportes exporta ambos Excel con los datos actualmente visibles", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "REPORTS-EXPORT-001", "Producto exportado");
  await abrirCaja(page, "0");
  await registrarVenta(page, "REPORTS-EXPORT-001", "card");
  await abrirReportes(page);

  const salesDownloadPromise = page.waitForEvent("download");
  await page.locator('button[onclick*="Reporte_Ventas"]').click();
  const salesDownload = await salesDownloadPromise;
  expect(salesDownload.suggestedFilename()).toMatch(/^Reporte_Ventas_.*\.xlsx$/);
  const salesWorkbook = await extractWorkbookText(salesDownload);
  expect(salesWorkbook).toContain("Tarjeta");
  expect(salesWorkbook).toContain("Producto exportado");
  expect(salesWorkbook).toContain("15.00");

  const sellersDownloadPromise = page.waitForEvent("download");
  await page.locator('button[onclick*="Reporte_Vendedores"]').click();
  const sellersDownload = await sellersDownloadPromise;
  expect(sellersDownload.suggestedFilename()).toMatch(/^Reporte_Vendedores_.*\.xlsx$/);
  const sellersWorkbook = await extractWorkbookText(sellersDownload);
  expect(sellersWorkbook).toContain("andres");
  expect(sellersWorkbook).toContain("Tarjeta");
  expect(sellersWorkbook).toContain("15.00");
});

test("el rol vendedor requiere clave de gestor para acceder a Reportes", async ({ page }) => {
  await iniciarSesion(page, "vendedor1", "1234");
  await page.locator("#navReportesBtn").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await page.locator("#gestorPassword").fill("incorrecta");
  await page.locator("#authForm button[type='submit']").click();
  await expect(page.locator("#authError")).toBeVisible();
  await expect(page.locator("#reportesView")).toBeHidden();

  await page.locator("#gestorPassword").fill("4321");
  await page.locator("#authForm button[type='submit']").click();
  await expect(page.locator("#reportesView")).toBeVisible();
  await expect(page.locator("#repVentas")).toHaveText("C$0.00");
});
