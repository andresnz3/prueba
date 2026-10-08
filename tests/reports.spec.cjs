/* global salesHistory, clients, suppliers, purchasesHistory, actualizarTablaClientes, actualizarTablaCuentasPorPagar */
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

async function instalarStubXlsx(page) {
  await page.addInitScript(() => {
    const excelColumn = index => { let value = index + 1, result = ""; while (value) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; };
    window.XLSX = {
      utils: {
        aoa_to_sheet(rows) {
          const sheet = { "!data": rows };
          rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => { sheet[`${excelColumn(columnIndex)}${rowIndex + 1}`] = { v: value, t: typeof value === "number" ? "n" : "s" }; }));
          return sheet;
        },
        book_new() { return { SheetNames: [], Sheets: {} }; },
        book_append_sheet(book, sheet, name) { book.SheetNames.push(name); book.Sheets[name] = sheet; }
      },
      writeFile(book, filename) {
        window.__excelExport = { book, filename };
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([JSON.stringify({ book, filename })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        link.download = filename; document.body.append(link); link.click(); link.remove();
      }
    };
  });
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
  await expect(page.locator('button[onclick*="ventas"]')).toBeVisible();
  await expect(page.locator('button[onclick*="vendedores"]')).toBeVisible();
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
  await page.locator('button[onclick*="ventas"]').click();
  const salesDownload = await salesDownloadPromise;
  expect(salesDownload.suggestedFilename()).toMatch(/^ventas_.*\.xlsx$/);
  const salesWorkbook = await extractWorkbookText(salesDownload);
  expect(salesWorkbook).toContain("Tarjeta");
  expect(salesWorkbook).toContain("Producto exportado");
  expect(salesWorkbook).toContain("<v>15</v>");

  const sellersDownloadPromise = page.waitForEvent("download");
  await page.locator('button[onclick*="vendedores"]').click();
  const sellersDownload = await sellersDownloadPromise;
  expect(sellersDownload.suggestedFilename()).toMatch(/^vendedores_.*\.xlsx$/);
  const sellersWorkbook = await extractWorkbookText(sellersDownload);
  expect(sellersWorkbook).toContain("andres");
  expect(sellersWorkbook).toContain("Tarjeta");
  expect(sellersWorkbook).toContain("<v>15</v>");
});

test("Ventas exporta solo lo visible y muestra un mensaje cuando no hay ventas", async ({ page }) => {
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript({ path: require.resolve("./dexie-search-shim.js") });
  await instalarStubXlsx(page);
  await iniciarSesion(page);
  await page.evaluate(() => {
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime(), yesterday = today - 86400000;
    const makeSale = (id, timestamp, medioPago, name, total) => ({ id, numero: id, fechaTS: timestamp, fecha: new Date(timestamp).toLocaleString(), metodo: "Contado", medioPago, total, anulada: false, vendedor: "Prueba", tarifa: "Menudeo", items: [{ name, cantidad: 1, retailPrice: total, wholesalePrice: total, cost: 5 }] });
    salesHistory.splice(0, salesHistory.length, makeSale(7101, today, "card", "Producto de hoy", 15), makeSale(7102, today, "transfer", "Producto transferencia", 20), makeSale(7103, yesterday, "cash", "Producto antiguo", 40));
  });
  await page.locator("#navReportesBtn").click();
  await expect(page.locator("#reportesView")).toBeVisible();
  await expect(page.locator('button[onclick*="exportarExcelReporte"][onclick*="ventas"]')).toHaveText("Exportar Excel de Ventas");
  await expect(page.locator('button[onclick*="exportarExcelReporte"][onclick*="vendedores"]')).toHaveText("Exportar Excel de Vendedores");
  await expect(page.locator("#repVentasBox .data-table-export").first()).toHaveText(/^Exportar Excel de Ventas por /);
  await expect(page.locator("#repVentasBox .data-table-export").nth(1)).toHaveText(/^Exportar Excel de Productos /);
  await expect(page.locator("#repVendedoresBox .data-table-export")).toHaveText(/^Exportar Excel de Ventas por vendedor$/);
  const reportTableLabels = await page.locator("#reportesView button.data-table-export").allTextContents();
  expect(reportTableLabels).toHaveLength(9);
  expect(reportTableLabels.every(label => label.startsWith("Exportar Excel de "))).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const topExportBounds = await page.locator("#reportesView button.report-export-button").evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth };
  }));
  expect(topExportBounds.every(rect => rect.left >= 0 && rect.right <= rect.viewport)).toBe(true);
  await page.locator("#filtroHoyBtn").click();
  await expect(page.locator("#repVentas")).toHaveText("C$35.00");
  await page.locator("#repVentasBox table .data-table-column-filter").first().fill("Tarjeta");
  await expect(page.locator("#repVentasMetodoBody tr:visible:not(.data-table-no-results)")).toHaveCount(1);

  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('button[onclick*="exportarExcelReporte"][onclick*="ventas"]').click()
  ]);
  expect(download.suggestedFilename()).toMatch(/^ventas_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const exported = JSON.parse(await fs.readFile(await download.path(), "utf8"));
  expect(exported.book.SheetNames).toHaveLength(2);
  expect(new Set(exported.book.SheetNames).size).toBe(2);
  const methodSheet = Object.values(exported.book.Sheets).find(sheet => sheet["!data"][0][0] === "Método");
  expect(methodSheet["!data"].slice(1, -1)).toEqual([["Tarjeta", 1, 15]]);
  const productsSheet = Object.values(exported.book.Sheets).find(sheet => sheet["!data"][0][0] === "Producto");
  expect(productsSheet["!data"].some(row => row.includes("Producto antiguo"))).toBe(false);
  expect(downloads).toBe(1);

  const twoDaysAgo = await page.evaluate(() => { const date = new Date(); date.setDate(date.getDate() - 2); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; });
  await page.locator("#reporteDesdeInput").fill(twoDaysAgo);
  await page.locator("#reporteHastaInput").fill(twoDaysAgo);
  await page.locator("#aplicarFiltroReporteBtn").click();
  await expect(page.locator("#repVentas")).toHaveText("C$0.00");
  await page.locator('button[onclick*="exportarExcelReporte"][onclick*="ventas"]').click();
  await expect(page.locator("#customAlertModal")).toBeVisible();
  await expect(page.locator("#customAlertMessage")).toContainText("No hay ventas visibles para exportar");
  expect(downloads).toBe(1);
});

test("Inventario, clientes, CxC, proveedores, CxP y compras generan Excel", async ({ page }) => {
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript({ path: require.resolve("./dexie-search-shim.js") });
  await instalarStubXlsx(page);
  await iniciarSesion(page);

  const exports = [
    { nav: "#navInventoryBtn", view: "#inventoryView", button: "#inventoryView .data-table-export", file: "inventario" },
    { nav: "#navClientsBtn", view: "#clientsView", button: "#clientsView .data-table-export", file: "clientes", nth: 0 },
    { nav: "#navClientsBtn", view: "#clientsView", button: "#clientsView .data-table-export", file: "cuentas_por_cobrar", nth: 1, reveal: "#connectedReceivablesPanel" },
    { nav: "#navSuppliersBtn", view: "#suppliersView", button: "#suppliersView .data-table-export", file: "proveedores" },
    { nav: "#navPayablesBtn", view: "#payablesView", button: "#payablesView .data-table-export", file: "cuentas_por_pagar" },
    { nav: "#navPurchasesBtn", view: "#purchasesView", button: "#purchasesView .data-table-export", file: "compras" }
  ];

  for (const item of exports) {
    await page.locator(item.nav).click();
    await expect(page.locator(item.view)).toBeVisible();
    if (item.reveal) await page.locator(item.reveal).evaluate(element => element.classList.remove("hidden"));
    const button = page.locator(item.button).nth(item.nth || 0);
    await expect(button).toHaveText("Exportar Excel");
    const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^${item.file}_\\d{4}-\\d{2}-\\d{2}\\.xlsx$`));
    const file = JSON.parse(await fs.readFile(await download.path(), "utf8"));
    expect(file.book.SheetNames).toHaveLength(1);
    expect(Object.values(file.book.Sheets)[0]["!data"][0].length).toBeGreaterThan(0);
  }
});

test("Clientes y CxP ocultan IDs internos en tabla y Excel, y conservan acciones", async ({ page }) => {
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript({ path: require.resolve("./dexie-search-shim.js") });
  await instalarStubXlsx(page);
  await iniciarSesion(page);
  const technicalClientId = "1791253461494";
  const technicalSupplierId = "1791253461495";
  const technicalPurchaseId = "1791253461496";
  await page.evaluate(({ technicalClientId, technicalSupplierId, technicalPurchaseId }) => {
    clients.push({ id: Number(technicalClientId), name: "Cliente sin ID visible", phone: "555-1100", ruc: "", address: "", creditLimit: 100, debt: 25, active: true });
    suppliers.push({ id: Number(technicalSupplierId), name: "Proveedor sin ID visible", phone: "555-2200", contact: "", ruc: "", address: "", debt: 50, active: true });
    purchasesHistory.push({ id: Number(technicalPurchaseId), factura: "PAYABLE-TECH-001", proveedor: "Proveedor sin ID visible", tipo: "credito", anulada: false, total: 50, vencimiento: "2099-12-31", fecha: "2026-10-01", fechaTS: 1790812800000 });
    actualizarTablaClientes();
    actualizarTablaCuentasPorPagar();
  }, { technicalClientId, technicalSupplierId, technicalPurchaseId });

  await page.locator("#navClientsBtn").click();
  await expect(page.locator("#clientsView thead th").first()).toHaveText("Cliente");
  const clientRow = page.locator("#clientsTableBody tr").filter({ hasText: "Cliente sin ID visible" });
  await expect(clientRow).toBeVisible();
  await expect(clientRow).not.toContainText(technicalClientId);
  const [clientDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#clientsView .data-table-export").first().click()]);
  const clientBook = JSON.parse(await fs.readFile(await clientDownload.path(), "utf8")).book;
  const clientSheet = Object.values(clientBook.Sheets)[0];
  expect(clientSheet["!data"][0]).toContain("Cliente");
  expect(clientSheet["!data"][0]).not.toContain("ID");
  expect(JSON.stringify(clientSheet)).not.toContain(technicalClientId);

  await page.locator("#navPayablesBtn").click();
  await expect(page.locator("#payablesView thead tr:first-child th")).toHaveText(["Proveedor", "Teléfono", "Próx. Vencimiento", "Deuda Actual", "Acciones"]);
  const payableRow = page.locator("#payablesTableBody tr").filter({ hasText: "Proveedor sin ID visible" });
  await expect(payableRow).toBeVisible();
  await expect(payableRow.locator("td")).toHaveCount(5);
  await expect(payableRow).toContainText("C$50.00");
  await expect(payableRow).toContainText("2099-12-31");
  await expect(payableRow).not.toContainText(technicalSupplierId);
  await expect(payableRow).not.toContainText(technicalPurchaseId);
  await page.locator("#payablesView .data-table-column-filter").first().fill("Proveedor sin ID visible");
  await expect(page.locator("#payablesTableBody tr:visible:not(.data-table-no-results)")).toHaveCount(1);
  const [payableDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#payablesView .data-table-export").click()]);
  const payableBook = JSON.parse(await fs.readFile(await payableDownload.path(), "utf8")).book;
  const payableSheet = Object.values(payableBook.Sheets)[0];
  expect(payableSheet["!data"][0]).toEqual(["Proveedor", "Teléfono", "Próx. Vencimiento", "Deuda Actual"]);
  expect(JSON.stringify(payableSheet)).toContain("2099-12-31");
  expect(JSON.stringify(payableSheet)).not.toContain(technicalSupplierId);
  expect(JSON.stringify(payableSheet)).not.toContain(technicalPurchaseId);

  await payableRow.getByRole("button", { name: "Ver Facturas" }).click();
  await expect(page.locator("#statementModalTitle")).toContainText("Proveedor sin ID visible");
  const payableInvoice = page.locator("#statementTableBody tr").filter({ hasText: "PAYABLE-TECH-001" });
  await expect(payableInvoice).toContainText("C$50.00");
  await payableInvoice.getByRole("button", { name: "Abonar" }).click();
  await page.locator("#payInvoiceAmount").fill("20");
  await page.locator("#payInvoiceMethod").selectOption("transferencia");
  await page.locator("#paymentInvoiceForm button[type='submit']").click();
  await expect(page.locator("#customAlertMessage")).toContainText("Pago de factura registrado");
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(payableRow).toContainText("C$30.00");
  await expect(payableRow).not.toContainText(technicalSupplierId);
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
