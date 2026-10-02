const { test, expect } = require("@playwright/test");
const { monitorRequests } = require("./browser-diagnostics.cjs");

const frontendErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  frontendErrors.set(page, errors);
  monitorRequests(page, errors);
});

test.afterEach(async ({ page }) => {
  expect(frontendErrors.get(page)).toEqual([]);
});

test("la pantalla de login carga correctamente", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#loginScreen")).toBeVisible();
});

test("login correcto permite entrar al sistema", async ({ page }) => {
  await page.goto("/");

  await page.locator("#loginUsername").fill("andres");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();

  await expect(page.locator("#loginScreen")).toBeHidden();
  await expect(page.locator("#app")).toBeVisible();
});

test("después del login se muestra el módulo de ventas", async ({ page }) => {
  await page.goto("/");

  await page.locator("#loginUsername").fill("andres");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();

  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#salesView")).toBeVisible();
});

test("el módulo de ventas tiene escáner y carrito", async ({ page }) => {
  await page.goto("/");

  await page.locator("#loginUsername").fill("andres");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();

  await expect(page.locator("#salesView")).toBeVisible();
  await expect(page.locator("#barcodeInput")).toBeVisible();
  await expect(page.locator("#searchProductInput")).toBeVisible();
  await expect(page.locator("#cartPanel")).toBeVisible();
  await expect(page.locator("#cartItems")).toBeVisible();
});

async function crearProducto(page, id, barcode, name) {
  await page.evaluate(async ({ id, barcode, name }) => {
    const request = indexedDB.open("POS_OfflineDB");

    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("products", "readwrite");
        const store = transaction.objectStore("products");

        store.put({
          id,
          barcode,
          name,
          category: "Abarrotes",
          business_id: "00000000-0000-0000-0000-000000000000",
          cost: 10,
          retailPrice: 15,
          wholesalePrice: 13,
          stock: 10,
          minStock: 1,
          active: true,
          deleted: false
        });

        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, { id, barcode, name });
}

async function iniciarSesion(page) {
  await page.goto("/");
  await page.locator("#loginUsername").fill("andres");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
}

async function abrirInventario(page) {
  await page.locator("#navInventoryBtn").click();
  await expect(page.locator("#inventoryView")).toBeVisible();
}

async function abrirCompras(page) {
  await page.locator("#navPurchasesBtn").click();
  await expect(page.locator("#purchasesView")).toBeVisible();
}

async function abrirClientes(page) {
  await page.locator("#navClientsBtn").click();
  await expect(page.locator("#clientsView")).toBeVisible();
}

async function abrirProveedores(page) {
  await page.locator("#navSuppliersBtn").click();
  await expect(page.locator("#suppliersView")).toBeVisible();
}

test("un producto se puede agregar al carrito", async ({ page }) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-product-001",
    "TEST001",
    "Producto de prueba"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await expect(
    page.locator("#productGrid .product-card").first()
  ).toBeVisible();

  await page.locator("#productGrid .product-card").first().click();

  await expect(page.locator("#cartItems")).not.toContainText(
    "Carrito vacío"
  );
});

test("un producto se puede agregar mediante código de barras", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-barcode-001",
    "BARCODE001",
    "Producto código de barras"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("BARCODE001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).not.toContainText(
    "Carrito vacío"
  );
});

test("el carrito actualiza cantidad y total correctamente", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-cart-001",
    "CART001",
    "Producto carrito"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("CART001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Producto carrito"
  );

  const quantityButtons = page.locator("#cartItems button");

  await expect(quantityButtons.first()).toBeVisible();
});

test("disminuir cantidad actualiza el carrito correctamente", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-decrease-001",
    "DECREASE001",
    "Producto disminuir"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("DECREASE001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).not.toContainText(
    "Carrito vacío"
  );

  const buttons = page.locator("#cartItems button");
  const buttonCount = await buttons.count();

  expect(buttonCount).toBeGreaterThan(0);

  for (let i = 0; i < buttonCount; i++) {
    const text = (await buttons.nth(i).innerText()).trim();

    if (text === "+" || text.includes("+")) {
      await buttons.nth(i).click();
      break;
    }
  }

  await page.waitForTimeout(200);

  const cartAfterIncrease = await page.locator("#cartItems").innerText();

  for (let i = 0; i < buttonCount; i++) {
    const text = (await buttons.nth(i).innerText()).trim();

    if (text === "-" || text.includes("-")) {
      await buttons.nth(i).click();
      break;
    }
  }

  await page.waitForTimeout(200);

  const cartAfterDecrease = await page.locator("#cartItems").innerText();

  expect(cartAfterDecrease).not.toBe(cartAfterIncrease);
});

test("se puede eliminar un producto del carrito", async ({ page }) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-delete-cart-001",
    "DELETECART001",
    "Producto eliminar"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("DELETECART001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Producto eliminar"
  );

  const buttons = page.locator("#cartItems button");
  const count = await buttons.count();

  expect(count).toBeGreaterThan(0);

  let quitarEncontrado = false;

  for (let i = 0; i < count; i++) {
    const text = (await buttons.nth(i).innerText()).trim();

    if (text.toLowerCase().includes("quitar")) {
      await buttons.nth(i).click();
      quitarEncontrado = true;
      break;
    }
  }

  expect(quitarEncontrado).toBe(true);

  await expect(page.locator("#cartItems")).not.toContainText(
    "Producto eliminar"
  );
});

test("vaciar carrito elimina todos los productos con varios productos", async ({ page }) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-clear-cart-001",
    "CLEARCART001",
    "Producto vaciar carrito"
  );

  await crearProducto(
    page,
    "test-clear-cart-002",
    "CLEARCART002",
    "Segundo producto"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("CLEARCART001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator("#barcodeInput").fill("CLEARCART002");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Producto vaciar carrito"
  );

  await expect(page.locator("#cartItems")).toContainText(
    "Segundo producto"
  );

  await page.locator("#clearCartBtn").click();

  await expect(page.locator("#customConfirmModal")).toBeVisible();

  await page.locator("#customConfirmBtn").click();

  await expect(page.locator("#customConfirmModal")).toBeHidden();

  await expect(page.locator("#cartItems")).toContainText(
    "Carrito vacío"
  );

  await expect(page.locator("#cartItems")).not.toContainText(
    "Producto vaciar carrito"
  );

  await expect(page.locator("#cartItems")).not.toContainText(
    "Segundo producto"
  );
});

test("login incorrecto no permite entrar al sistema", async ({ page }) => {
  await page.goto("/");

  await page.locator("#loginUsername").fill("andres");
  await page.locator("#loginPassword").fill("9999");
  await page.locator("#loginForm button[type='submit']").click();

  await expect(page.locator("#loginScreen")).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();
});

test("el bloqueo de login aplica sus niveles, persiste y se reinicia al iniciar sesión correctamente", async ({ page }) => {
  const loginFailureKey = "posLoginFailState";
  await page.goto("/");
  await page.evaluate(key => localStorage.removeItem(key), loginFailureKey);

  const loginError = page.locator("#loginError");
  const submitInvalidLogin = async () => {
    await page.locator("#loginUsername").fill("andres");
    await page.locator("#loginPassword").fill("incorrecta");
    await page.locator("#loginForm button[type='submit']").click();
  };
  const readState = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), loginFailureKey);
  const expireCurrentLock = async () => {
    await page.evaluate(key => {
      const state = JSON.parse(localStorage.getItem(key));
      state.lockedUntil = Date.now() - 1;
      localStorage.setItem(key, JSON.stringify(state));
    }, loginFailureKey);
  };

  for (let count = 1; count <= 2; count += 1) {
    await submitInvalidLogin();
    await expect(loginError).toHaveText("Credenciales incorrectas");
    const state = await readState();
    expect(state.count).toBe(count);
    expect(state.lockedUntil).toBe(0);
  }

  await submitInvalidLogin();
  await expect(loginError).toContainText("Demasiados intentos");
  await expect(loginError).toContainText(/\d+ segundos/);
  let state = await readState();
  expect(state.count).toBe(3);
  expect(state.lockedUntil - Date.now()).toBeGreaterThan(0);
  expect(state.lockedUntil - Date.now()).toBeLessThanOrEqual(30000);
  expect(Object.keys(state)).not.toContain("password");
  expect(JSON.stringify(state)).not.toContain("incorrecta");

  await page.reload();
  await page.locator("#loginUsername").fill("andres");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#loginScreen")).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();
  await expect(loginError).toContainText("Demasiados intentos");
  state = await readState();
  expect(state.count).toBe(3);

  await expireCurrentLock();
  await submitInvalidLogin();
  await expect(loginError).toContainText(/Demasiados intentos.*\d+ segundos/);
  state = await readState();
  expect(state.count).toBe(4);
  expect(state.lockedUntil - Date.now()).toBeGreaterThan(0);
  expect(state.lockedUntil - Date.now()).toBeLessThanOrEqual(30000);

  await expireCurrentLock();
  await submitInvalidLogin();
  await expect(loginError).toContainText(/Demasiados intentos.*\d+ segundos/);
  state = await readState();
  expect(state.count).toBe(5);
  expect(state.lockedUntil - Date.now()).toBeGreaterThan(0);
  expect(state.lockedUntil - Date.now()).toBeLessThanOrEqual(120000);

  await expireCurrentLock();
  await submitInvalidLogin();
  await expect(loginError).toContainText(/Demasiados intentos.*\d+ segundos/);
  state = await readState();
  expect(state.count).toBe(6);
  expect(state.lockedUntil - Date.now()).toBeGreaterThan(0);
  expect(state.lockedUntil - Date.now()).toBeLessThanOrEqual(120000);

  await expireCurrentLock();
  await page.locator("#loginUsername").fill("andres");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), loginFailureKey)).toBeNull();
});

test("login requiere usuario y contraseña", async ({ page }) => {
  await page.goto("/");

  await page.locator("#loginForm button[type='submit']").click();

  await expect(page.locator("#loginScreen")).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();
});
test("el precio y subtotal del carrito se actualizan con la cantidad", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-price-001",
    "PRICE001",
    "Producto precio"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("PRICE001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Producto precio"
  );

  await expect(page.locator("#cartItems")).toContainText(
    "C$15.00"
  );

  const quantityInput = page.locator("#cartItems input[type='number']").first();

  await quantityInput.fill("2");
  await quantityInput.dispatchEvent("change");

  await expect(page.locator("#cartItems")).toContainText(
    "C$30.00"
  );

  await expect(page.locator("#subtotal")).toContainText(
    "30.00"
  );
});
test("el cambio entre menudeo y mayoreo actualiza el precio", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-wholesale-001",
    "WHOLESALE001",
    "Producto mayoreo"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("WHOLESALE001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText("C$15.00");

const wholesaleOption = page.locator(
  'input[name="buyerType"][value="wholesale"]'
);

await expect(wholesaleOption).toBeVisible();
await wholesaleOption.check();

  await expect(page.locator("#cartItems")).toContainText("C$13.00");
});
test("el descuento actualiza correctamente el total de la venta", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-discount-001",
    "DISCOUNT001",
    "Producto descuento"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("DISCOUNT001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText("C$15.00");
  await expect(page.locator("#total")).toContainText("15.00");

  await page.locator(
    'input[name="descApplies"][value="si"]'
  ).check();

  const discountInput = page.locator("#descuentoPct");

  await expect(discountInput).toBeVisible();

  await discountInput.fill("10");
  await discountInput.dispatchEvent("input");
  await discountInput.dispatchEvent("change");

  await expect(page.locator("#descuentoMonto")).toContainText("1.50");
  await expect(page.locator("#total")).toContainText("13.50");
});
test("no permite agregar al carrito más unidades que el stock disponible", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-stock-limit-001",
    "STOCKLIMIT001",
    "Producto stock limitado"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("STOCKLIMIT001");
  await page.locator("#addBarcodeBtn").click();

  const quantityInput = page.locator(
    "#cartItems input[type='number']"
  ).first();

  await quantityInput.fill("11");
  await quantityInput.dispatchEvent("change");

  await expect(quantityInput).toHaveValue("1");
});
test("disminuir cantidad reduce correctamente la cantidad del producto", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-decrease-001",
    "DECREASE001",
    "Producto disminuir"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("DECREASE001");
  await page.locator("#addBarcodeBtn").click();

  const increaseButton = page.locator(
    "#cartItems button"
  ).filter({ hasText: "+" }).first();

  await increaseButton.click();
  await increaseButton.click();

  const quantityInput = page.locator(
    "#cartItems input[type='number']"
  ).first();

  await expect(quantityInput).toHaveValue("3");

  const decreaseButton = page.locator(
  "#cartItems button"
).filter({ hasText: "-" }).first();
  await decreaseButton.click();

  await expect(quantityInput).toHaveValue("2");
  await expect(page.locator("#cartItems")).toContainText("C$30.00");
});
test("el boton aumentar cantidad respeta el stock disponible", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-plus-stock-001",
    "PLUSSTOCK001",
    "Producto limite plus"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("PLUSSTOCK001");
  await page.locator("#addBarcodeBtn").click();

  const quantityInput = page.locator(
    "#cartItems input[type='number']"
  ).first();

  await expect(quantityInput).toHaveValue("1");

  const increaseButton = page.locator(
    "#cartItems button.qty-btn"
  ).filter({ hasText: "+" }).first();

  for (let i = 0; i < 9; i++) {
    await increaseButton.click();
  }

  await expect(quantityInput).toHaveValue("10");

  await increaseButton.click();

  await expect(quantityInput).toHaveValue("10");
});
test("eliminar un producto quita correctamente el producto del carrito", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-remove-001",
    "REMOVE001",
    "Producto eliminar"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("REMOVE001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Producto eliminar"
  );

  const removeButton = page.locator(
    "#cartItems button"
  ).filter({ hasText: "Quitar" }).first();

  await expect(removeButton).toBeVisible();
  await removeButton.click();

  await expect(page.locator("#cartItems")).not.toContainText(
    "Producto eliminar"
  );

  await expect(page.locator("#subtotal")).toContainText("0.00");
});
test("eliminar el ultimo producto deja el carrito completamente vacio", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-empty-after-remove-001",
    "EMPTYREMOVE001",
    "Producto vaciado"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("EMPTYREMOVE001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Producto vaciado"
  );

  await page.locator("#cartItems button")
    .filter({ hasText: "Quitar" })
    .first()
    .click();

  await expect(page.locator("#cartItems")).toContainText(
    "Carrito vacío"
  );

  await expect(page.locator("#subtotal")).toContainText("0.00");
  await expect(page.locator("#total")).toContainText("0.00");
});
test("eliminar un producto no elimina los demas productos del carrito", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-multi-remove-001",
    "MULTIREMOVE001",
    "Producto uno"
  );

  await crearProducto(
    page,
    "test-multi-remove-002",
    "MULTIREMOVE002",
    "Producto dos"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("MULTIREMOVE001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator("#barcodeInput").fill("MULTIREMOVE002");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText("Producto uno");
  await expect(page.locator("#cartItems")).toContainText("Producto dos");

  const productRows = page.locator(".cart-item-row");

  await expect(productRows).toHaveCount(2);

  await productRows
    .filter({ hasText: "Producto uno" })
    .locator("button")
    .filter({ hasText: "Quitar" })
    .click();

  await expect(page.locator("#cartItems")).not.toContainText(
    "Producto uno"
  );

  await expect(page.locator("#cartItems")).toContainText(
    "Producto dos"
  );

  await expect(page.locator("#subtotal")).toContainText("15.00");
  await expect(page.locator("#total")).toContainText("15.00");
});
test("el total se calcula correctamente con varios productos", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-total-multi-001",
    "TOTALMULTI001",
    "Producto A"
  );

  await crearProducto(
    page,
    "test-total-multi-002",
    "TOTALMULTI002",
    "Producto B"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("TOTALMULTI001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator("#barcodeInput").fill("TOTALMULTI002");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText("Producto A");
  await expect(page.locator("#cartItems")).toContainText("Producto B");

  await expect(page.locator("#subtotal")).toContainText("30.00");
  await expect(page.locator("#total")).toContainText("30.00");
});
test("cambiar cantidad de un producto no afecta a los demas", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-independent-001",
    "INDEPENDENT001",
    "Producto independiente A"
  );

  await crearProducto(
    page,
    "test-independent-002",
    "INDEPENDENT002",
    "Producto independiente B"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("INDEPENDENT001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator("#barcodeInput").fill("INDEPENDENT002");
  await page.locator("#addBarcodeBtn").click();

  const rows = page.locator(".cart-item-row");
  await expect(rows).toHaveCount(2);

  const firstQuantity = rows
    .filter({ hasText: "Producto independiente A" })
    .locator('input[type="number"]');

  const secondQuantity = rows
    .filter({ hasText: "Producto independiente B" })
    .locator('input[type="number"]');

  await firstQuantity.fill("3");
  await firstQuantity.dispatchEvent("change");

  await expect(firstQuantity).toHaveValue("3");
  await expect(secondQuantity).toHaveValue("1");

await expect(page.locator("#subtotal")).toContainText("60.00");
await expect(page.locator("#total")).toContainText("60.00");
});
test("la cantidad manual no puede superar el stock disponible", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-manual-stock-001",
    "MANUALSTOCK001",
    "Producto stock manual"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("MANUALSTOCK001");
  await page.locator("#addBarcodeBtn").click();

  const quantityInput = page.locator(
    "#cartItems input[type='number']"
  ).first();

  await quantityInput.fill("11");
  await quantityInput.dispatchEvent("change");

  await expect(quantityInput).toHaveValue("1");
  await expect(page.locator("#subtotal")).toContainText("15.00");
  await expect(page.locator("#total")).toContainText("15.00");
});
test("permite vender exactamente la cantidad disponible en stock", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-exact-stock-001",
    "EXACTSTOCK001",
    "Producto stock exacto"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("EXACTSTOCK001");
  await page.locator("#addBarcodeBtn").click();

  const quantityInput = page.locator(
    "#cartItems input[type='number']"
  ).first();

  await quantityInput.fill("10");
  await quantityInput.dispatchEvent("change");

  await expect(quantityInput).toHaveValue("10");
  await expect(page.locator("#subtotal")).toContainText("150.00");
  await expect(page.locator("#total")).toContainText("150.00");
});
test("cambiar de mayoreo a menudeo restaura el precio correcto", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-price-switch-001",
    "PRICESWITCH001",
    "Producto cambio precio"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("PRICESWITCH001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText("C$15.00");

  await page.locator(
    'input[name="buyerType"][value="wholesale"]'
  ).check();

  await expect(page.locator("#cartItems")).toContainText("C$13.00");

  await page.locator(
    'input[name="buyerType"][value="retail"]'
  ).check();

  await expect(page.locator("#cartItems")).toContainText("C$15.00");
});
test("cambiar entre menudeo y mayoreo actualiza el subtotal", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-subtotal-price-001",
    "SUBTOTALPRICE001",
    "Producto subtotal precio"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("SUBTOTALPRICE001");
  await page.locator("#addBarcodeBtn").click();

  const quantityInput = page.locator(
    "#cartItems input[type='number']"
  ).first();

  await quantityInput.fill("2");
  await quantityInput.dispatchEvent("change");

  await expect(page.locator("#subtotal")).toContainText("30.00");

  await page.locator(
    'input[name="buyerType"][value="wholesale"]'
  ).check();

  await expect(page.locator("#subtotal")).toContainText("26.00");
  await expect(page.locator("#total")).toContainText("26.00");
});
test("un codigo de barras inexistente no agrega productos al carrito", async ({
  page
}) => {
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("CODIGOQUE NOEXISTE999");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Carrito vacío"
  );

  await expect(page.locator("#subtotal")).toContainText("0.00");
  await expect(page.locator("#total")).toContainText("0.00");
});
test("un codigo de barras vacio no agrega productos", async ({
  page
}) => {
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Carrito vacío"
  );

  await expect(page.locator("#subtotal")).toContainText("0.00");
  await expect(page.locator("#total")).toContainText("0.00");
});
test("limpiar la busqueda vuelve a mostrar los productos", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-clear-search-001",
    "CLEARSEARCH001",
    "Producto busqueda A"
  );

  await crearProducto(
    page,
    "test-clear-search-002",
    "CLEARSEARCH002",
    "Producto busqueda B"
  );

  await page.goto("/");
  await iniciarSesion(page);

  const searchInput = page.locator("#searchProductInput");

  await searchInput.fill("Producto busqueda A");

  await expect(page.locator("#productGrid")).toContainText(
    "Producto busqueda A"
  );

  await expect(page.locator("#productGrid")).not.toContainText(
    "Producto busqueda B"
  );

  await searchInput.fill("");

  await expect(page.locator("#productGrid")).toContainText(
    "Producto busqueda A"
  );

  await expect(page.locator("#productGrid")).toContainText(
    "Producto busqueda B"
  );
});
test("un producto del catalogo se puede agregar al carrito", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-catalog-001",
    "CATALOG001",
    "Producto catalogo"
  );

  await page.goto("/");
  await iniciarSesion(page);

  const productGrid = page.locator("#productGrid");

  await expect(productGrid).toContainText("Producto catalogo");

  const product = productGrid
    .locator("div")
    .filter({ hasText: "Producto catalogo" })
    .first();

  await product.click();

  await expect(page.locator("#cartItems")).toContainText(
    "Producto catalogo"
  );

  await expect(page.locator("#subtotal")).toContainText("15.00");
  await expect(page.locator("#total")).toContainText("15.00");
});
test("agregar dos veces el mismo producto aumenta su cantidad", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-duplicate-cart-001",
    "DUPLICATECART001",
    "Producto repetido"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("DUPLICATECART001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator("#barcodeInput").fill("DUPLICATECART001");
  await page.locator("#addBarcodeBtn").click();

  const rows = page.locator(".cart-item-row");

  await expect(rows).toHaveCount(1);

  const quantityInput = rows.locator(
    'input[type="number"]'
  ).first();

  await expect(quantityInput).toHaveValue("2");

  await expect(page.locator("#subtotal")).toContainText("30.00");
  await expect(page.locator("#total")).toContainText("30.00");
});
test("vaciar carrito elimina todos los productos", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-clear-multi-001",
    "CLEARMULTI001",
    "Producto limpiar A"
  );

  await crearProducto(
    page,
    "test-clear-multi-002",
    "CLEARMULTI002",
    "Producto limpiar B"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("CLEARMULTI001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator("#barcodeInput").fill("CLEARMULTI002");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator(".cart-item-row")).toHaveCount(2);

  await page.locator("#clearCartBtn").click();

  const confirmButton = page.locator("#customConfirmBtn");

  if (await confirmButton.isVisible()) {
    await confirmButton.click();
  }

  await expect(page.locator("#cartItems")).toContainText(
    "Carrito vacío"
  );

  await expect(page.locator("#subtotal")).toContainText("0.00");
  await expect(page.locator("#total")).toContainText("0.00");
});
test("cancelar vaciado conserva los productos del carrito", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-cancel-clear-001",
    "CANCELCLEAR001",
    "Producto cancelar"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("CANCELCLEAR001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#cartItems")).toContainText(
    "Producto cancelar"
  );

  await page.locator("#clearCartBtn").click();

  const cancelButton = page.locator("#customCancelBtn");

  if (await cancelButton.isVisible()) {
    await cancelButton.click();
  }

  await expect(page.locator("#cartItems")).toContainText(
    "Producto cancelar"
  );

  await expect(page.locator("#subtotal")).toContainText("15.00");
  await expect(page.locator("#total")).toContainText("15.00");
});
test("un descuento de cero por ciento no modifica el total", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-zero-discount-001",
    "ZERODISCOUNT001",
    "Producto descuento cero"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("ZERODISCOUNT001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#total")).toContainText("15.00");

  await page.locator(
    'input[name="descApplies"][value="si"]'
  ).check();

  const discountInput = page.locator("#descuentoPct");

  await discountInput.fill("0");
  await discountInput.dispatchEvent("input");
  await discountInput.dispatchEvent("change");

  await expect(page.locator("#descuentoMonto")).toContainText("0.00");
  await expect(page.locator("#total")).toContainText("15.00");
});
test("un descuento del cien por ciento lleva el total a cero", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-full-discount-001",
    "FULLDISCOUNT001",
    "Producto descuento total"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("FULLDISCOUNT001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator(
    'input[name="descApplies"][value="si"]'
  ).check();

  const discountInput = page.locator("#descuentoPct");

  await discountInput.fill("100");
  await discountInput.dispatchEvent("input");
  await discountInput.dispatchEvent("change");

  await expect(page.locator("#descuentoMonto")).toContainText("15.00");
  await expect(page.locator("#total")).toContainText("0.00");
});
test("el descuento no permite un valor mayor al cien por ciento", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-invalid-discount-001",
    "INVALIDDISCOUNT001",
    "Producto descuento invalido"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("INVALIDDISCOUNT001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator(
    'input[name="descApplies"][value="si"]'
  ).check();

  const discountInput = page.locator("#descuentoPct");

  await discountInput.fill("150");
  await discountInput.dispatchEvent("input");
  await discountInput.dispatchEvent("change");

  await expect(discountInput).toHaveAttribute("max", "100");
  await expect(page.locator("#total")).toContainText("0.00");
});
test("el descuento negativo no reduce el total", async ({ page }) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-negative-discount-001",
    "NEGATIVEDISCOUNT001",
    "Producto descuento negativo"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("NEGATIVEDISCOUNT001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator(
    'input[name="descApplies"][value="si"]'
  ).check();

  const discountInput = page.locator("#descuentoPct");

  await discountInput.fill("-20");
  await discountInput.dispatchEvent("input");
  await discountInput.dispatchEvent("change");

  await expect(discountInput).toHaveAttribute("min", "0");
  await expect(page.locator("#total")).toContainText("15.00");
});
test("el descuento decimal calcula correctamente el total", async ({ page }) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-decimal-discount-001",
    "DECIMALDISCOUNT001",
    "Producto descuento decimal"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("DECIMALDISCOUNT001");
  await page.locator("#addBarcodeBtn").click();

  await page.locator(
    'input[name="descApplies"][value="si"]'
  ).check();

  const discountInput = page.locator("#descuentoPct");

  await discountInput.fill("10.5");
  await discountInput.dispatchEvent("input");
  await discountInput.dispatchEvent("change");

  await expect(page.locator("#descuentoMonto")).toContainText("1.58");
  await expect(page.locator("#total")).toContainText("13.42");
});
test("cambiar entre contado y credito mantiene correctamente el total", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-payment-001",
    "PAYMENT001",
    "Producto forma pago"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("PAYMENT001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#total")).toContainText("15.00");

  const credito = page.locator(
    'input[name="paymentMethod"][value="credito"]'
  );

  if (await credito.count()) {
    await credito.check();
    await expect(page.locator("#total")).toContainText("15.00");
  }
});
test("agregar repetidamente respeta el stock disponible", async ({ page }) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-stock-repeat-001",
    "STOCKREPEAT001",
    "Producto stock limitado"
  );

  await page.goto("/");
  await iniciarSesion(page);

  const addButton = page.locator("#addBarcodeBtn");
  const quantityInput = page.locator(
    '.cart-item-row input[type="number"]'
  ).first();

  for (let i = 1; i <= 10; i++) {
    await page.locator("#barcodeInput").fill("STOCKREPEAT001");
    await addButton.click();
    await expect(quantityInput).toHaveValue(String(i));
  }

  await page.locator("#barcodeInput").fill("STOCKREPEAT001");
  await addButton.click();

  await expect(quantityInput).toHaveValue("10");
});
test("quitar el descuento restaura el total original", async ({ page }) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-remove-discount-001",
    "REMOVEDISCOUNT001",
    "Producto quitar descuento"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("REMOVEDISCOUNT001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#total")).toContainText("15.00");

  await page.locator(
    'input[name="descApplies"][value="si"]'
  ).check();

  const discountInput = page.locator("#descuentoPct");

  await discountInput.fill("20");
  await discountInput.dispatchEvent("input");
  await discountInput.dispatchEvent("change");

  await expect(page.locator("#total")).toContainText("12.00");

  await page.locator(
    'input[name="descApplies"][value="no"]'
  ).check();

  await expect(page.locator("#total")).toContainText("15.00");
});
test("cambiar de menudeo a mayoreo con descuento calcula correctamente", async ({
  page
}) => {
  await iniciarSesion(page);

  await crearProducto(
    page,
    "test-wholesale-discount-001",
    "WHOLESALECOUNT001",
    "Producto mayoreo descuento"
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#barcodeInput").fill("WHOLESALECOUNT001");
  await page.locator("#addBarcodeBtn").click();

  await expect(page.locator("#total")).toContainText("15.00");

  await page.locator(
    'input[name="buyerType"][value="wholesale"]'
  ).check();

  await expect(page.locator("#total")).toContainText("13.00");

  await page.locator(
    'input[name="descApplies"][value="si"]'
  ).check();

  const discountInput = page.locator("#descuentoPct");

  await discountInput.fill("10");
  await discountInput.dispatchEvent("input");
  await discountInput.dispatchEvent("change");

  await expect(page.locator("#descuentoMonto")).toContainText("1.30");
  await expect(page.locator("#total")).toContainText("11.70");
});
test("carrito vacío no permite procesar una venta", async ({ page }) => {
  await iniciarSesion(page);

  await expect(page.locator("#cartItems")).toContainText("Carrito vacío");

  await page.locator("#processSaleBtn").click();

  await expect(page.locator("#cartItems")).toContainText("Carrito vacío");
  await expect(page.locator("#total")).toContainText("0.00");
});
test("crear producto lo muestra correctamente en inventario", async ({ page }) => {
  await iniciarSesion(page);

  const productName = "Producto inventario prueba";
  const barcode = "INVENTORY001";

  await crearProducto(
    page,
    "test-inventory-001",
    barcode,
    productName
  );

  await page.goto("/");
  await iniciarSesion(page);

  await page.locator("#navInventoryBtn").click();

  await expect(page.locator("#inventoryView")).toBeVisible();
  await expect(page.locator("#inventoryView")).toContainText(productName);
  await expect(page.locator("#inventoryView")).toContainText(barcode);
});

test("crear producto desde el formulario lo guarda en inventario", async ({ page }) => {
  await iniciarSesion(page);
  await abrirInventario(page);
  await page.locator("#addNewProductBtn").click();

  await page.locator("#prodBarcode").fill("UI-CREATE-001");
  await page.locator("#prodName").fill("Producto creado desde formulario");
  await page.locator("#prodCost").fill("20");
  await page.locator("#prodStock").fill("8");
  await page.locator("#prodMinStock").fill("2");
  await page.locator("#productForm button[type='submit']").click();

  await expect(page.locator("#productModal")).toBeHidden();
  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-CREATE-001"
  });
  await expect(productRow).toContainText("Producto creado desde formulario");
  await expect(productRow).toContainText("8");
});

test("editar producto actualiza sus datos en inventario", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-inventory-edit-001", "UI-EDIT-001", "Producto antes de editar");
  await page.reload();
  await iniciarSesion(page);
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-EDIT-001"
  });
  await productRow.getByRole("button", { name: "Editar" }).click();
  await expect(page.locator("#productModal")).toBeVisible();
  await page.locator("#prodName").fill("Producto editado desde formulario");
  await page.locator("#productForm button[type='submit']").click();

  await expect(page.locator("#productModal")).toBeHidden();
  await expect(productRow).toContainText("Producto editado desde formulario");
  await expect(productRow).toContainText("UI-EDIT-001");
});

test("el formulario de producto exige sus campos obligatorios", async ({ page }) => {
  await iniciarSesion(page);
  await abrirInventario(page);
  await page.locator("#addNewProductBtn").click();
  await page.locator("#productForm button[type='submit']").click();

  const missingRequiredFields = await page.locator("#productForm").evaluate(form =>
    [...form.querySelectorAll("[required]")]
      .filter(field => !field.checkValidity())
      .map(field => field.id)
  );

  expect(missingRequiredFields).toEqual([
    "prodBarcode",
    "prodName",
    "prodCost"
  ]);
  await expect(page.locator("#productModal")).toBeVisible();
});

test("no permite guardar un producto con código de barras duplicado", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-inventory-duplicate-001", "UI-DUPLICATE-001", "Producto existente");
  await page.reload();
  await iniciarSesion(page);
  await abrirInventario(page);
  await page.locator("#addNewProductBtn").click();

  await page.locator("#prodBarcode").fill("UI-DUPLICATE-001");
  await page.locator("#prodName").fill("Producto con código repetido");
  await page.locator("#prodCost").fill("10");
  await page.locator("#productForm button[type='submit']").click();

  await expect(page.locator("#customAlertModal")).toBeVisible();
  await expect(page.locator("#customAlertMessage")).toContainText("UI-DUPLICATE-001");
  await expect(page.locator("#productModal")).toBeVisible();
  await expect(page.locator("#inventoryTableBody tr")).toHaveCount(1);
});

test("editar precios actualiza menudeo y mayoreo en inventario", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-inventory-prices-001", "UI-PRICES-001", "Producto para cambiar precios");
  await page.reload();
  await iniciarSesion(page);
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-PRICES-001"
  });
  await productRow.getByRole("button", { name: "Editar" }).click();
  await page.locator("#prodRetail").fill("19.50");
  await page.locator("#prodWholesale").fill("16.25");
  await page.locator("#productForm button[type='submit']").click();

  await expect(page.locator("#productModal")).toBeHidden();
  await expect(productRow).toContainText("Men: C$19.50");
  await expect(productRow).toContainText("May: C$16.25");
});

test("editar costo actualiza el costo del producto en inventario", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-inventory-cost-001", "UI-COST-001", "Producto para cambiar costo");
  await page.reload();
  await iniciarSesion(page);
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-COST-001"
  });
  await productRow.getByRole("button", { name: "Editar" }).click();
  await page.locator("#prodCost").fill("12.34");
  await page.locator("#productForm button[type='submit']").click();

  await expect(page.locator("#productModal")).toBeHidden();
  await expect(productRow).toContainText("C$12.34");
});

test("no permite guardar un producto con nombre compuesto solo por espacios", async ({ page }) => {
  await iniciarSesion(page);
  await abrirInventario(page);
  await page.locator("#addNewProductBtn").click();

  await page.locator("#prodBarcode").fill("UI-BLANK-NAME-001");
  await page.locator("#prodName").fill("   ");
  await page.locator("#prodCost").fill("10");
  await page.locator("#prodRetail").fill("15");
  await page.locator("#prodWholesale").fill("13");
  await page.locator("#productForm button[type='submit']").click();

  await expect(page.locator("#customAlertModal")).toBeVisible();
  await expect(page.locator("#customAlertMessage")).toContainText("nombre del producto es obligatorio");
  await expect(page.locator("#productModal")).toBeVisible();
  await expect(page.locator("#inventoryTableBody tr")).toHaveCount(0);
});

test("inventario muestra correctamente productos activos, bajos y agotados", async ({ page }) => {
  await iniciarSesion(page);
  await abrirInventario(page);

  async function crearProductoConStock(barcode, name, stock, minStock) {
    await page.locator("#addNewProductBtn").click();
    await page.locator("#prodBarcode").fill(barcode);
    await page.locator("#prodName").fill(name);
    await page.locator("#prodCost").fill("10");
    await page.locator("#prodStock").fill(String(stock));
    await page.locator("#prodMinStock").fill(String(minStock));
    await page.locator("#productForm button[type='submit']").click();
    await expect(page.locator("#productModal")).toBeHidden();
    await page.locator("#customAlertModal .close-modal-btn").click();
  }

  await crearProductoConStock("UI-STOCK-OK", "Producto con stock normal", 8, 5);
  await crearProductoConStock("UI-STOCK-LOW", "Producto con stock bajo", 2, 5);
  await crearProductoConStock("UI-STOCK-OUT", "Producto agotado", 0, 5);

  await expect(page.locator("#invTotalProducts")).toHaveText("3");
  await expect(page.locator("#invLowStock")).toHaveText("1");
  await expect(page.locator("#invOutOfStock")).toHaveText("1");
  await expect(page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-STOCK-LOW"
  })).toContainText("2 (Bajo)");
  await expect(page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-STOCK-OUT"
  })).toContainText("0 (Agotado)");
});

test("ajuste positivo registra una entrada y aumenta el stock", async ({ page }) => {
  await page.goto("/");
  await crearProducto(page, "test-inventory-entry-001", "UI-ENTRY-001", "Producto para entrada");
  await page.reload();
  await page.locator("#loginUsername").fill("gestor");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-ENTRY-001"
  });
  await productRow.getByRole("button", { name: /Ajuste/ }).click();
  await expect(page.locator("#ajusteInventarioModal")).toBeVisible();
  await page.locator("#ajusteTipo").selectOption("AJUSTE_POSITIVO");
  await page.locator("#ajusteCantidad").fill("3");
  await page.locator("#ajusteMotivo").fill("Entrada por sobrante físico");
  await page.locator("#ajusteInventarioForm button[type='submit']").click();

  await expect(page.locator("#ajusteInventarioModal")).toBeHidden();
  await expect(productRow.locator("td").nth(3)).toContainText("13");
});

test("merma válida descuenta unidades del stock", async ({ page }) => {
  await page.goto("/");
  await crearProducto(page, "test-inventory-waste-001", "UI-WASTE-001", "Producto para merma");
  await page.reload();
  await page.locator("#loginUsername").fill("gestor");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-WASTE-001"
  });
  await productRow.getByRole("button", { name: /Ajuste/ }).click();
  await page.locator("#ajusteTipo").selectOption("MERMA");
  await page.locator("#ajusteCantidad").fill("4");
  await page.locator("#ajusteMotivo").fill("Producto dañado");
  await page.locator("#ajusteInventarioForm button[type='submit']").click();

  await expect(page.locator("#ajusteInventarioModal")).toBeHidden();
  await expect(productRow.locator("td").nth(3)).toContainText("6");
});

test("no permite registrar una merma mayor al stock disponible", async ({ page }) => {
  await page.goto("/");
  await crearProducto(page, "test-inventory-excess-waste-001", "UI-WASTE-LIMIT-001", "Producto con stock limitado");
  await page.reload();
  await page.locator("#loginUsername").fill("gestor");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-WASTE-LIMIT-001"
  });
  await productRow.getByRole("button", { name: /Ajuste/ }).click();
  await page.locator("#ajusteCantidad").fill("11");
  await page.locator("#ajusteMotivo").fill("Intento de merma excedida");
  await page.locator("#ajusteInventarioForm button[type='submit']").click();

  await expect(page.locator("#customAlertModal")).toBeVisible();
  await expect(page.locator("#customAlertMessage")).toContainText("solo hay 10 en stock");
  await expect(page.locator("#ajusteInventarioModal")).toBeVisible();
  await expect(productRow.locator("td").nth(3)).toContainText("10");
});

test("activar e inactivar producto actualiza estado y contador", async ({ page }) => {
  await page.goto("/");
  await crearProducto(page, "test-inventory-status-001", "UI-STATUS-001", "Producto para cambiar estado");
  await page.reload();
  await page.locator("#loginUsername").fill("gestor");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-STATUS-001"
  });
  await productRow.getByRole("button", { name: "Inactivar" }).click();
  await page.locator("#customConfirmBtn").click();
  await expect(productRow).toContainText("Inactivo");
  await expect(page.locator("#invTotalProducts")).toHaveText("0");

  await page.locator("#customAlertModal .close-modal-btn").click();
  await productRow.getByRole("button", { name: "Activar" }).click();
  await page.locator("#customConfirmBtn").click();
  await expect(productRow).toContainText("Activo");
  await expect(page.locator("#invTotalProducts")).toHaveText("1");
});

test("cancelar eliminación conserva producto y confirmar lo elimina lógicamente", async ({ page }) => {
  await page.goto("/");
  await crearProducto(page, "test-inventory-delete-001", "UI-DELETE-001", "Producto para eliminar");
  await page.reload();
  await page.locator("#loginUsername").fill("gestor");
  await page.locator("#loginPassword").fill("4321");
  await page.locator("#loginForm button[type='submit']").click();
  await expect(page.locator("#salesView")).toBeVisible();
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-DELETE-001"
  });
  await productRow.getByRole("button", { name: "Eliminar" }).click();
  await page.locator("#customConfirmModal .close-modal-btn").click();
  await expect(productRow).toBeVisible();

  await productRow.getByRole("button", { name: "Eliminar" }).click();
  await page.locator("#customConfirmBtn").click();
  await expect(page.locator("#customAlertMessage")).toContainText("Producto eliminado");
  await expect(productRow).toHaveCount(0);

  const savedProduct = await page.evaluate(async id => {
    const request = indexedDB.open("POS_OfflineDB");
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("products", "readonly");
      const getRequest = transaction.objectStore("products").get(id);
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
    });
  }, "test-inventory-delete-001");
  expect(savedProduct.deleted).toBe(true);
});

test("producto creado desde inventario persiste después de recargar", async ({ page }) => {
  await iniciarSesion(page);
  await abrirInventario(page);
  await page.locator("#addNewProductBtn").click();
  await page.locator("#prodBarcode").fill("UI-PERSIST-001");
  await page.locator("#prodName").fill("Producto persistente");
  await page.locator("#prodCost").fill("10");
  await page.locator("#prodStock").fill("7");
  await page.locator("#prodMinStock").fill("2");
  await page.locator("#productForm button[type='submit']").click();
  await expect(page.locator("#productModal")).toBeHidden();

  await page.reload();
  await iniciarSesion(page);
  await abrirInventario(page);

  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "UI-PERSIST-001"
  });
  await expect(productRow).toContainText("Producto persistente");
  await expect(productRow.locator("td").nth(3)).toContainText("7");
});

test("crear compra al contado con producto existente actualiza factura e inventario", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-purchase-basic-001", "PURCHASE-BASIC-001", "Producto compra contado");
  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();

  await page.locator("#purchSupplier").fill("Proveedor contado");
  await page.locator("#purchInvoice").fill("FACT-CONT-001");
  await page.locator("#purchProductTemp").fill("Producto compra contado");
  await page.locator("#purchQtyTemp").fill("3");
  await page.locator("#purchCostTemp").fill("10");
  await page.locator("#btnAddItemToPurch").click();

  await expect(page.locator("#purchCartBody")).toContainText("Producto compra contado");
  await expect(page.locator("#purchCartBody")).toContainText("C$30.00");
  await expect(page.locator("#purchTotalDisplay")).toHaveText("C$30.00");
  await page.locator("#purchaseForm button[type='submit']").click();

  await expect(page.locator("#purchaseModal")).toBeHidden();
  const purchaseRow = page.locator("#purchasesTableBody tr").filter({
    hasText: "FACT-CONT-001"
  });
  await expect(purchaseRow).toContainText("Proveedor contado");
  await expect(purchaseRow).toContainText("C$30.00");
  await expect(purchaseRow).toContainText("CONTADO");

  await page.locator("#customAlertModal .close-modal-btn").click();
  await abrirInventario(page);
  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "PURCHASE-BASIC-001"
  });
  await expect(productRow.locator("td").nth(3)).toContainText("13");
});

test("no permite agregar a una compra un producto inexistente", async ({ page }) => {
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();

  await page.locator("#purchProductTemp").fill("Producto que no existe");
  await page.locator("#purchQtyTemp").fill("2");
  await page.locator("#purchCostTemp").fill("8");
  await page.locator("#btnAddItemToPurch").click();

  await expect(page.locator("#customAlertModal")).toBeVisible();
  await expect(page.locator("#customAlertMessage")).toContainText("El producto no existe");
  await expect(page.locator("#purchCartBody")).toContainText("Aún no hay productos");
  await expect(page.locator("#purchTotalDisplay")).toHaveText("C$0.00");
});

test("crear producto nuevo desde Compras permite agregarlo a la factura", async ({ page }) => {
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#quickAddProductFromPurchBtn").click();
  await expect(page.locator("#productModal")).toBeVisible();

  await page.locator("#prodBarcode").fill("PURCHASE-NEW-001");
  await page.locator("#prodName").fill("Producto nuevo desde compra");
  await page.locator("#prodCost").fill("5");
  await page.locator("#prodStock").fill("0");
  await page.locator("#prodMinStock").fill("1");
  await page.locator("#productForm button[type='submit']").click();
  await expect(page.locator("#productModal")).toBeHidden();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await expect(page.locator("#purchProductTemp")).toHaveValue("Producto nuevo desde compra");
  await expect(page.locator("#purchCostTemp")).toHaveValue("5");
  await page.locator("#purchQtyTemp").fill("4");
  await page.locator("#btnAddItemToPurch").click();
  await expect(page.locator("#purchCartBody")).toContainText("Producto nuevo desde compra");
  await expect(page.locator("#purchTotalDisplay")).toHaveText("C$20.00");

  await page.locator("#purchSupplier").fill("Proveedor producto nuevo");
  await page.locator("#purchInvoice").fill("FACT-NEW-PROD-001");
  await page.locator("#purchaseForm button[type='submit']").click();
  await expect(page.locator("#purchasesTableBody")).toContainText("FACT-NEW-PROD-001");
});

test("rechaza cantidad no positiva y costo negativo al agregar productos", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-purchase-invalid-001", "PURCHASE-INVALID-001", "Producto para validar compra");
  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();

  await page.locator("#purchProductTemp").fill("Producto para validar compra");
  await page.locator("#purchQtyTemp").fill("0");
  await page.locator("#purchCostTemp").fill("10");
  await page.locator("#btnAddItemToPurch").click();
  await expect(page.locator("#customAlertMessage")).toContainText("Ingrese producto, cantidad y costo unitario");
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#purchCartBody")).toContainText("Aún no hay productos");

  await page.locator("#purchQtyTemp").fill("2");
  await page.locator("#purchCostTemp").fill("-1");
  await page.locator("#btnAddItemToPurch").click();
  await expect(page.locator("#customAlertMessage")).toContainText("costo unitario no puede ser negativo");
  await expect(page.locator("#purchCartBody")).toContainText("Aún no hay productos");
});

test("una compra actualiza el costo y los precios derivados del producto", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-purchase-cost-001", "PURCHASE-COST-001", "Producto para actualizar costo");
  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchSupplier").fill("Proveedor cambio costo");
  await page.locator("#purchInvoice").fill("FACT-COST-001");
  await page.locator("#purchProductTemp").fill("Producto para actualizar costo");
  await page.locator("#purchQtyTemp").fill("2");
  await page.locator("#purchCostTemp").fill("15");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();
  await expect(page.locator("#purchaseModal")).toBeHidden();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await abrirInventario(page);
  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "PURCHASE-COST-001"
  });
  await expect(productRow.locator("td").nth(4)).toHaveText("C$15.00");
  await expect(productRow.locator("td").nth(5)).toContainText("Men: C$16.50");
  await expect(productRow.locator("td").nth(5)).toContainText("May: C$16.50");
});

test("compra a crédito guarda proveedor, factura y vencimiento", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-purchase-credit-001", "PURCHASE-CREDIT-001", "Producto para compra a crédito");
  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();

  await page.locator("#quickAddSupplierFromPurchBtn").click();
  await page.locator("#suppName").fill("Proveedor crédito prueba");
  await page.locator("#suppContact").fill("Contacto prueba");
  await page.locator("#suppPhone").fill("88881234");
  await page.locator("#supplierForm button[type='submit']").click();
  await expect(page.locator("#supplierModal")).toBeHidden();
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#purchSupplier")).toHaveValue("Proveedor crédito prueba");

  await page.locator("#purchInvoice").fill("FACT-CREDIT-001");
  await page.locator("#purchType").selectOption("credito");
  await expect(page.locator("#purchDaysContainer")).toBeVisible();
  await page.locator("#purchDays").fill("15");
  await page.locator("#purchProductTemp").fill("Producto para compra a crédito");
  await page.locator("#purchQtyTemp").fill("2");
  await page.locator("#purchCostTemp").fill("8");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();

  const purchaseRow = page.locator("#purchasesTableBody tr").filter({
    hasText: "FACT-CREDIT-001"
  });
  await expect(purchaseRow).toContainText("Proveedor crédito prueba");
  await expect(purchaseRow).toContainText("C$16.00");
  await expect(purchaseRow).toContainText("CRÉDITO");
  await expect(purchaseRow).toContainText("Pendiente C$16.00");
  await expect(purchaseRow).toContainText("Vence:");

  await page.locator("#customAlertModal .close-modal-btn").click();
  await purchaseRow.getByRole("button", { name: "Ver Factura" }).click();
  await expect(page.locator("#ticketContent")).toContainText("FACT-CREDIT-001");
  await expect(page.locator("#ticketContent")).toContainText("Vence:");
  const expectedDueDate = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() + 15);
    return date.toLocaleDateString();
  });
  await expect(page.locator("#ticketContent")).toContainText(expectedDueDate);
});

test("valida proveedor y factura obligatorios y exige al menos un producto", async ({ page }) => {
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchaseForm button[type='submit']").click();

  const missingRequiredFields = await page.locator("#purchaseForm").evaluate(form =>
    [...form.querySelectorAll("[required]")]
      .filter(field => !field.checkValidity())
      .map(field => field.id)
  );
  expect(missingRequiredFields).toEqual(["purchSupplier", "purchInvoice"]);
  await expect(page.locator("#purchaseModal")).toBeVisible();

  await page.locator("#purchSupplier").fill("Proveedor sin productos");
  await page.locator("#purchInvoice").fill("FACT-EMPTY-001");
  await page.locator("#purchaseForm button[type='submit']").click();
  await expect(page.locator("#customAlertMessage")).toContainText("Agrega al menos un producto");
  await expect(page.locator("#purchaseModal")).toBeVisible();
  await expect(page.locator("#purchasesTableBody")).not.toContainText("FACT-EMPTY-001");
});

test("anular compra requiere motivo, revierte stock y conserva factura anulada", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-purchase-void-001", "PURCHASE-VOID-001", "Producto para anular compra");
  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchSupplier").fill("Proveedor anulación prueba");
  await page.locator("#purchInvoice").fill("FACT-VOID-001");
  await page.locator("#purchProductTemp").fill("Producto para anular compra");
  await page.locator("#purchQtyTemp").fill("3");
  await page.locator("#purchCostTemp").fill("10");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();
  await page.locator("#customAlertModal .close-modal-btn").click();

  const purchaseRow = page.locator("#purchasesTableBody tr").filter({
    hasText: "FACT-VOID-001"
  });
  await purchaseRow.getByRole("button", { name: "Anular" }).click();
  await expect(page.locator("#anularRegistroModal")).toBeVisible();
  await page.locator("#anularRegistroModal .close-modal-btn").click();
  await page.locator("#customConfirmBtn").click();
  await expect(page.locator("#anularRegistroModal")).toBeHidden();
  await expect(purchaseRow).not.toContainText("ANULADA");

  await purchaseRow.getByRole("button", { name: "Anular" }).click();
  await page.locator("#anularRegistroMotivo").fill("Factura capturada por error");
  await page.locator("#anularRegistroForm button[type='submit']").click();
  await expect(purchaseRow).toContainText("ANULADA");
  await expect(purchaseRow.getByRole("button", { name: "Anular" })).toHaveCount(0);
  await page.locator("#customAlertModal .close-modal-btn").click();

  await abrirInventario(page);
  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "PURCHASE-VOID-001"
  });
  await expect(productRow.locator("td").nth(3)).toContainText("10");
});

test("rechaza cantidades fraccionarias sin truncarlas en la compra", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-purchase-fraction-001", "PURCHASE-FRACTION-001", "Producto para cantidad entera");
  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchProductTemp").fill("Producto para cantidad entera");
  await page.locator("#purchQtyTemp").evaluate(input => {
    input.value = "1.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#purchQtyTemp")).toHaveValue("1.5");
  expect(await page.locator("#purchQtyTemp").evaluate(input => input.validity.stepMismatch)).toBe(true);
  await page.locator("#purchCostTemp").fill("10");
  await page.locator("#btnAddItemToPurch").click();

  await expect(page.locator("#customAlertMessage")).toContainText("La cantidad debe ser un número entero");
  await expect(page.locator("#purchCartBody")).toContainText("Aún no hay productos");
});

test("compra e incremento de stock persisten después de recargar", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-purchase-persist-001", "PURCHASE-PERSIST-001", "Producto de compra persistente");
  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchSupplier").fill("Proveedor compra persistente");
  await page.locator("#purchInvoice").fill("FACT-PERSIST-001");
  await page.locator("#purchProductTemp").fill("Producto de compra persistente");
  await page.locator("#purchQtyTemp").fill("2");
  await page.locator("#purchCostTemp").fill("10");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  const purchaseRow = page.locator("#purchasesTableBody tr").filter({
    hasText: "FACT-PERSIST-001"
  });
  await expect(purchaseRow).toContainText("Proveedor compra persistente");
  await expect(purchaseRow).toContainText("C$20.00");

  await abrirInventario(page);
  const productRow = page.locator("#inventoryTableBody tr").filter({
    hasText: "PURCHASE-PERSIST-001"
  });
  await expect(productRow.locator("td").nth(3)).toContainText("12");
});

test("compra calcula el total y actualiza stock para varios productos", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-purchase-multi-001", "PURCHASE-MULTI-001", "Producto múltiple uno");
  await crearProducto(page, "test-purchase-multi-002", "PURCHASE-MULTI-002", "Producto múltiple dos");
  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#purchSupplier").fill("Proveedor compra múltiple");
  await page.locator("#purchInvoice").fill("FACT-MULTI-001");

  await page.locator("#purchProductTemp").fill("Producto múltiple uno");
  await page.locator("#purchQtyTemp").fill("2");
  await page.locator("#purchCostTemp").fill("3");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchProductTemp").fill("Producto múltiple dos");
  await page.locator("#purchQtyTemp").fill("4");
  await page.locator("#purchCostTemp").fill("2.5");
  await page.locator("#btnAddItemToPurch").click();

  await expect(page.locator("#purchCartBody tr")).toHaveCount(2);
  await expect(page.locator("#purchCartBody")).toContainText("C$6.00");
  await expect(page.locator("#purchCartBody")).toContainText("C$10.00");
  await expect(page.locator("#purchTotalDisplay")).toHaveText("C$16.00");
  await page.locator("#purchaseForm button[type='submit']").click();
  await expect(page.locator("#purchasesTableBody")).toContainText("FACT-MULTI-001");
  await page.locator("#customAlertModal .close-modal-btn").click();

  await abrirInventario(page);
  await expect(page.locator("#inventoryTableBody tr").filter({
    hasText: "PURCHASE-MULTI-001"
  }).locator("td").nth(3)).toContainText("12");
  await expect(page.locator("#inventoryTableBody tr").filter({
    hasText: "PURCHASE-MULTI-002"
  }).locator("td").nth(3)).toContainText("14");
});

test("no permite anular una compra si el stock ya no cubre la factura", async ({ page }) => {
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await page.locator("#quickAddProductFromPurchBtn").click();
  await page.locator("#prodBarcode").fill("PURCHASE-PARTIAL-001");
  await page.locator("#prodName").fill("Producto con mercancía vendida");
  await page.locator("#prodCost").fill("10");
  await page.locator("#prodStock").fill("0");
  await page.locator("#prodMinStock").fill("1");
  await page.locator("#productForm button[type='submit']").click();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.locator("#purchSupplier").fill("Proveedor stock parcial");
  await page.locator("#purchInvoice").fill("FACT-PARTIAL-001");
  await page.locator("#purchQtyTemp").fill("5");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.evaluate(async id => {
    const request = indexedDB.open("POS_OfflineDB");
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("products", "readwrite");
      const store = transaction.objectStore("products");
      const getRequest = store.getAll();
      getRequest.onsuccess = () => {
        const product = getRequest.result.find(item => item.barcode === id);
        if (!product) {
          reject(new Error(`No se encontró el producto con código ${id}`));
          return;
        }
        product.stock = 2;
        store.put(product);
      };
      getRequest.onerror = () => reject(getRequest.error);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }, "PURCHASE-PARTIAL-001");

  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  const purchaseRow = page.locator("#purchasesTableBody tr").filter({
    hasText: "FACT-PARTIAL-001"
  });
  await purchaseRow.getByRole("button", { name: "Anular" }).click();
  await page.locator("#anularRegistroMotivo").fill("Intento de anular mercancía ya vendida");
  await page.locator("#anularRegistroForm button[type='submit']").click();

  await expect(page.locator("#customAlertMessage")).toContainText("No se puede anular");
  await expect(page.locator("#customAlertMessage")).toContainText("stock 2, factura 5");
  await expect(purchaseRow).not.toContainText("ANULADA");
});

test("CLIENTES: crear cliente guarda sus datos y crédito inicial en la tabla", async ({ page }) => {
  await iniciarSesion(page);
  await abrirClientes(page);
  await page.locator("#addNewClientBtn").click();

  await page.locator("#clientName").fill("Cliente nuevo UI");
  await page.locator("#clientRuc").fill("RUC-CLIENTE-001");
  await page.locator("#clientPhone").fill("88881234");
  await page.locator("#clientAddress").fill("Dirección de prueba");
  await page.locator("#clientLimit").fill("1000");
  await page.locator("#clientDebt").fill("125.50");
  await page.locator("#clientForm button[type='submit']").click();

  await expect(page.locator("#clientModal")).toBeHidden();
  const clientRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente nuevo UI"
  });
  await expect(clientRow).toContainText("88881234");
  await expect(clientRow).toContainText("C$1000.00");
  await expect(clientRow).toContainText("C$874.50");
  await expect(clientRow).toContainText("C$125.50");
  await expect(clientRow).toContainText("Activo");
  await clientRow.getByRole("button", { name: "Editar" }).click();
  await expect(page.locator("#clientRuc")).toHaveValue("RUC-CLIENTE-001");
  await expect(page.locator("#clientAddress")).toHaveValue("Dirección de prueba");
});

test("CLIENTES: editar cliente actualiza datos y mantiene la deuda protegida", async ({ page }) => {
  await iniciarSesion(page);
  await abrirClientes(page);
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientName").fill("Cliente antes de editar");
  await page.locator("#clientPhone").fill("11112222");
  await page.locator("#clientLimit").fill("500");
  await page.locator("#clientDebt").fill("100");
  await page.locator("#clientForm button[type='submit']").click();

  const clientRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente antes de editar"
  });
  const clientId = (await clientRow.locator("td").first().innerText()).split("\n")[0];
  await clientRow.getByRole("button", { name: "Editar" }).click();
  await expect(page.locator("#clientDebt")).toHaveAttribute("readonly", "");
  await expect(page.locator("#clientDebtHint")).toContainText("La deuda solo cambia");

  await page.locator("#clientName").fill("Cliente después de editar");
  await page.locator("#clientPhone").fill("33334444");
  await page.locator("#clientLimit").fill("700");
  await page.locator("#clientForm button[type='submit']").click();

  const editedRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente después de editar"
  });
  await expect(editedRow.locator("td").first()).toContainText(clientId);
  await expect(editedRow).toContainText("33334444");
  await expect(editedRow).toContainText("C$700.00");
  await expect(editedRow).toContainText("C$600.00");
  await expect(editedRow).toContainText("C$100.00");
});

test("CLIENTES: el formulario exige nombre, límite y deuda", async ({ page }) => {
  await iniciarSesion(page);
  await abrirClientes(page);
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientLimit").fill("");
  await page.locator("#clientDebt").fill("");
  await page.locator("#clientForm button[type='submit']").click();

  const invalidRequiredFields = await page.locator("#clientForm").evaluate(form =>
    [...form.querySelectorAll("[required]")]
      .filter(field => !field.checkValidity())
      .map(field => field.id)
  );
  expect(invalidRequiredFields).toEqual(["clientName", "clientLimit", "clientDebt"]);
  await expect(page.locator("#clientModal")).toBeVisible();
  await expect(page.locator("#clientsTableBody tr")).toHaveCount(0);
});

test("CLIENTES: rechaza nombre en blanco y montos negativos", async ({ page }) => {
  await iniciarSesion(page);
  await abrirClientes(page);
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientName").fill("   ");
  await page.locator("#clientForm button[type='submit']").click();

  await expect(page.locator("#customAlertMessage")).toContainText("nombre del cliente es obligatorio");
  await expect(page.locator("#clientModal")).toBeVisible();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.locator("#clientName").fill("Cliente con datos inválidos");
  await page.locator("#clientLimit").fill("-1");
  await page.locator("#clientForm button[type='submit']").click();
  await expect(page.locator("#customAlertMessage")).toContainText("no negativos");
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#clientsTableBody tr")).toHaveCount(0);

  await page.locator("#clientLimit").fill("100");
  await page.locator("#clientDebt").fill("-0.01");
  await page.locator("#clientForm button[type='submit']").click();
  await expect(page.locator("#customAlertMessage")).toContainText("no negativos");
  await expect(page.locator("#clientsTableBody tr")).toHaveCount(0);
});

test("CLIENTES: el alta rápida asocia cliente con venta a crédito y actualiza su deuda", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-client-sale-001", "CLIENT-SALE-001", "Producto para venta del cliente");
  await page.reload();
  await iniciarSesion(page);

  await page.locator('input[name="paymentMethod"][value="credit"]').check();
  await expect(page.locator("#creditClientContainer")).toBeVisible();
  await page.locator("#quickAddClientBtn").click();
  await page.locator("#clientName").fill("Cliente venta a crédito");
  await page.locator("#clientLimit").fill("1000");
  await page.locator("#clientDebt").fill("0");
  await page.locator("#clientForm button[type='submit']").click();
  await expect(page.locator("#clientModal")).toBeHidden();
  await expect(page.locator("#creditClientSelect")).toHaveValue(/.+/);

  await page.locator("#barcodeInput").fill("CLIENT-SALE-001");
  await page.locator("#addBarcodeBtn").click();
  await page.locator("#processSaleBtn").click();

  await expect(page.locator("#ticketModal")).toBeVisible();
  await expect(page.locator("#ticketContent")).toContainText("Cliente venta a crédito");
  await expect(page.locator("#ticketContent")).toContainText("Saldo Pendiente");
  await page.locator("#newSaleBtn").click();

  await abrirClientes(page);
  const clientRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente venta a crédito"
  });
  await expect(clientRow).toContainText("C$985.00");
  await expect(clientRow).toContainText("C$15.00");
  await expect(clientRow).toContainText("Activo");
});

test("CLIENTES: no permite una venta a crédito superior al límite disponible", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-client-limit-001", "CLIENT-LIMIT-001", "Producto sobre límite de crédito");
  await page.reload();
  await iniciarSesion(page);
  await abrirClientes(page);
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientName").fill("Cliente con límite bajo");
  await page.locator("#clientLimit").fill("10");
  await page.locator("#clientDebt").fill("0");
  await page.locator("#clientForm button[type='submit']").click();

  const clientRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente con límite bajo"
  });
  const clientId = (await clientRow.locator("td").first().innerText()).split("\n")[0];
  await page.locator("#navSalesBtn").click();
  await expect(page.locator("#salesView")).toBeVisible();
  await page.locator('input[name="paymentMethod"][value="credit"]').check();
  await page.locator("#creditClientSelect").selectOption(clientId);
  await page.locator("#barcodeInput").fill("CLIENT-LIMIT-001");
  await page.locator("#addBarcodeBtn").click();
  await page.locator("#processSaleBtn").click();

  await expect(page.locator("#customAlertMessage")).toContainText("Crédito Excedido");
  await expect(page.locator("#ticketModal")).toBeHidden();
  await expect(clientRow).toContainText("C$10.00");
  await expect(clientRow).toContainText("C$0.00");
});

test("CLIENTES: inactivar y reactivar controla disponibilidad para crédito", async ({ page }) => {
  await iniciarSesion(page);
  await abrirClientes(page);
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientName").fill("Cliente para activar");
  await page.locator("#clientLimit").fill("500");
  await page.locator("#clientDebt").fill("0");
  await page.locator("#clientForm button[type='submit']").click();

  const clientRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente para activar"
  });
  await expect(clientRow.getByRole("button", { name: "Historial" })).toBeVisible();
  await expect(clientRow.getByRole("button", { name: "Editar" })).toBeVisible();
  await expect(clientRow.getByRole("button", { name: "Borrar" })).toHaveCount(0);

  await page.locator("#navSalesBtn").click();
  await page.locator('input[name="paymentMethod"][value="credit"]').check();
  await expect(page.locator("#creditClientSelect option")).toHaveCount(1);
  await page.locator("#navClientsBtn").click();

  await clientRow.getByRole("button", { name: "Inactivar" }).click();
  await page.locator("#customConfirmBtn").click();
  await expect(clientRow).toContainText("Inactivo");
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.locator("#navSalesBtn").click();
  await expect(page.locator("#creditClientSelect option")).toHaveCount(0);

  await page.locator("#navClientsBtn").click();
  await expect(page.locator("#clientsView")).toBeVisible();
  await clientRow.getByRole("button", { name: "Activar" }).click();
  await page.locator("#customConfirmBtn").click();
  await expect(clientRow).toContainText("Al día");
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.locator("#navSalesBtn").click();
  await expect(page.locator("#creditClientSelect option")).toHaveCount(1);
  await expect(page.locator("#creditClientSelect")).toContainText("Cliente para activar");
});

test("CLIENTES: historial muestra venta a crédito y permite abonar a su factura", async ({ page }) => {
  await iniciarSesion(page);
  await crearProducto(page, "test-client-ledger-001", "CLIENT-LEDGER-001", "Producto estado de cuenta");
  await page.reload();
  await iniciarSesion(page);
  await abrirClientes(page);
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientName").fill("Cliente con historial");
  await page.locator("#clientLimit").fill("500");
  await page.locator("#clientDebt").fill("0");
  await page.locator("#clientForm button[type='submit']").click();
  const clientRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente con historial"
  });
  const clientId = (await clientRow.locator("td").first().innerText()).split("\n")[0];

  await page.locator("#navSalesBtn").click();
  await page.locator('input[name="paymentMethod"][value="credit"]').check();
  await page.locator("#creditClientSelect").selectOption(clientId);
  await page.locator("#barcodeInput").fill("CLIENT-LEDGER-001");
  await page.locator("#addBarcodeBtn").click();
  await page.locator("#processSaleBtn").click();
  await expect(page.locator("#ticketModal")).toBeVisible();
  await page.locator("#newSaleBtn").click();

  await abrirClientes(page);
  await clientRow.getByRole("button", { name: "Historial" }).click();
  await expect(page.locator("#statementModal")).toBeVisible();
  await expect(page.locator("#statementModalTitle")).toContainText("Cliente con historial");
  await expect(page.locator("#statementTableBody")).toContainText("Factura de crédito");
  await expect(page.locator("#statementTableBody")).toContainText("Pendiente C$15.00");
  await expect(page.locator("#statementTableBody").getByRole("button", { name: "Borrar" })).toHaveCount(0);
  await page.locator("#statementTableBody").getByRole("button", { name: "Abonar" }).click();

  await expect(page.locator("#paymentSaleModal")).toBeVisible();
  await expect(page.locator("#paySaleSaldo")).toHaveText("C$15.00");
  await page.locator("#paySaleAmount").fill("5");
  await page.locator("#paySaleMethod").selectOption("tarjeta");
  await page.locator("#paymentSaleForm button[type='submit']").click();

  await expect(page.locator("#paymentSaleModal")).toBeHidden();
  await expect(page.locator("#customAlertMessage")).toContainText("Abono de factura registrado");
  await expect(clientRow).toContainText("C$10.00");
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#statementTableBody")).toContainText("Pago recibido por tarjeta");
  await expect(page.locator("#statementTableBody")).toContainText("C$10.00");

  const paymentRow = page.locator("#statementTableBody tr").filter({
    hasText: "Pago recibido por tarjeta"
  });
  await paymentRow.getByRole("button", { name: "Anular" }).click();
  await expect(page.locator("#anularRegistroModal")).toBeVisible();
  await page.locator("#anularRegistroMotivo").fill("Pago aplicado por error");
  await page.locator("#anularRegistroForm button[type='submit']").click();
  await expect(page.locator("#customAlertMessage")).toContainText("Abono anulado");
  await expect(clientRow).toContainText("C$15.00");
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#statementTableBody")).toContainText("ANULADO");
});

test("CLIENTES: persiste después de recargar y permite teléfono opcional", async ({ page }) => {
  await iniciarSesion(page);
  await abrirClientes(page);
  await page.locator("#addNewClientBtn").click();
  await page.locator("#clientName").fill("Cliente persistente sin teléfono");
  await page.locator("#clientLimit").fill("250");
  await page.locator("#clientDebt").fill("0");
  await page.locator("#clientForm button[type='submit']").click();
  await expect(page.locator("#clientsTableBody")).toContainText("Cliente persistente sin teléfono");

  await page.reload();
  await iniciarSesion(page);
  await page.locator('input[name="paymentMethod"][value="credit"]').check();
  await expect(page.locator("#creditClientSelect")).toContainText("Cliente persistente sin teléfono");
  await page.locator("#navClientsBtn").click();
  await expect(page.locator("#clientsView")).toBeVisible();
  await abrirClientes(page);
  const clientRow = page.locator("#clientsTableBody tr").filter({
    hasText: "Cliente persistente sin teléfono"
  });
  await expect(clientRow).toBeVisible();
  await expect(clientRow).toContainText("C$250.00");
  await expect(clientRow).toContainText("C$0.00");
  await clientRow.getByRole("button", { name: "Editar" }).click();
  await expect(page.locator("#clientPhone")).toHaveValue("");
  await expect(page.locator("#clientRuc")).toHaveValue("");
  await expect(page.locator("#clientAddress")).toHaveValue("");
});

test("PROVEEDORES: crear proveedor guarda contacto y datos opcionales", async ({ page }) => {
  await iniciarSesion(page);
  await abrirProveedores(page);
  await page.locator("#addNewSupplierBtn").click();

  await page.locator("#suppName").fill("Proveedor nuevo UI");
  await page.locator("#suppContact").fill("Contacto de prueba");
  await page.locator("#suppPhone").fill("505-8888-1234 ext. 2");
  await page.locator("#suppRuc").fill("RUC-PROV-001");
  await page.locator("#suppAddress").fill("Bodega central");
  await page.locator("#supplierForm button[type='submit']").click();

  await expect(page.locator("#supplierModal")).toBeHidden();
  const supplierRow = page.locator("#suppliersTableBody tr").filter({
    hasText: "Proveedor nuevo UI"
  });
  await expect(supplierRow).toContainText("Contacto de prueba");
  await expect(supplierRow).toContainText("505-8888-1234 ext. 2");
  await expect(supplierRow).toContainText("Bodega central");
  await expect(supplierRow).toContainText("C$0.00");
  await expect(supplierRow).toContainText("0 compras");
  await page.locator("#customAlertModal .close-modal-btn").click();
  await supplierRow.getByRole("button", { name: "Editar" }).click();
  await expect(page.locator("#suppRuc")).toHaveValue("RUC-PROV-001");
  await expect(page.locator("#suppAddress")).toHaveValue("Bodega central");
});

test("PROVEEDORES: editar proveedor actualiza sus datos y conserva identidad", async ({ page }) => {
  await iniciarSesion(page);
  await abrirProveedores(page);
  await page.locator("#addNewSupplierBtn").click();
  await page.locator("#suppName").fill("Proveedor antes de editar");
  await page.locator("#suppContact").fill("Contacto anterior");
  await page.locator("#suppPhone").fill("22223333");
  await page.locator("#supplierForm button[type='submit']").click();
  await page.locator("#customAlertModal .close-modal-btn").click();

  const supplierRow = page.locator("#suppliersTableBody tr").filter({
    hasText: "Proveedor antes de editar"
  });
  await supplierRow.getByRole("button", { name: "Editar" }).click();
  await expect(page.locator("#suppName")).toHaveValue("Proveedor antes de editar");
  await expect(page.locator("#suppContact")).toHaveValue("Contacto anterior");
  await expect(page.locator("#suppPhone")).toHaveValue("22223333");
  const supplierId = await page.locator("#supplierId").inputValue();

  await page.locator("#suppName").fill("Proveedor después de editar");
  await page.locator("#suppContact").fill("Contacto actualizado");
  await page.locator("#suppPhone").fill("+505 8888-9999");
  await page.locator("#suppRuc").fill("RUC-EDITADO-002");
  await page.locator("#suppAddress").fill("Sucursal norte");
  await page.locator("#supplierForm button[type='submit']").click();

  const editedRow = page.locator("#suppliersTableBody tr").filter({
    hasText: "Proveedor después de editar"
  });
  await expect(page.locator("#supplierId")).toHaveValue(supplierId);
  await expect(editedRow).toContainText("Contacto actualizado");
  await expect(editedRow).toContainText("+505 8888-9999");
  await expect(editedRow).toContainText("RUC-EDITADO-002");
  await expect(editedRow).toContainText("Sucursal norte");
});

test("PROVEEDORES: exige nombre, contacto y teléfono", async ({ page }) => {
  await iniciarSesion(page);
  await abrirProveedores(page);
  await page.locator("#addNewSupplierBtn").click();
  await page.locator("#supplierForm button[type='submit']").click();

  const invalidRequiredFields = await page.locator("#supplierForm").evaluate(form =>
    [...form.querySelectorAll("[required]")]
      .filter(field => !field.checkValidity())
      .map(field => field.id)
  );
  expect(invalidRequiredFields).toEqual(["suppName", "suppContact", "suppPhone"]);
  await expect(page.locator("#supplierModal")).toBeVisible();
  await expect(page.locator("#suppliersTableBody tr")).toHaveCount(0);
});

test("PROVEEDORES: no guarda campos obligatorios compuestos solo por espacios", async ({ page }) => {
  await iniciarSesion(page);
  await abrirProveedores(page);
  await page.locator("#addNewSupplierBtn").click();
  for (const field of ["#suppName", "#suppContact", "#suppPhone"]) {
    await page.locator("#suppName").fill("Proveedor válido");
    await page.locator("#suppContact").fill("Contacto válido");
    await page.locator("#suppPhone").fill("123");
    await page.locator(field).fill("   ");
    await expect(page.locator(field)).toHaveValue("   ");
    expect(await page.locator(field).evaluate(input => input.checkValidity())).toBe(true);
    await page.locator("#supplierForm button[type='submit']").click();

    await expect(page.locator("#customAlertMessage")).toHaveText("Complete nombre, contacto y teléfono.");
    await expect(page.locator("#suppliersTableBody tr")).toHaveCount(0);
    if (field !== "#suppPhone") {
      await page.locator("#customAlertModal .close-modal-btn").click();
    }
  }
  await expect(page.locator("#supplierModal")).toBeVisible();
});

test("PROVEEDORES: inactivar y reactivar controla su disponibilidad en Compras", async ({ page }) => {
  await iniciarSesion(page);
  await abrirProveedores(page);
  await page.locator("#addNewSupplierBtn").click();
  await page.locator("#suppName").fill("Proveedor estado UI");
  await page.locator("#suppContact").fill("Contacto estado");
  await page.locator("#suppPhone").fill("88889999");
  await page.locator("#supplierForm button[type='submit']").click();
  await page.locator("#customAlertModal .close-modal-btn").click();

  let supplierRow = page.locator("#suppliersTableBody tr").filter({
    hasText: "Proveedor estado UI"
  });
  await supplierRow.getByRole("button", { name: "Inactivar" }).click();
  await page.locator("#customConfirmBtn").click();
  await expect(supplierRow.getByRole("button", { name: "Activar" })).toBeVisible();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await expect(page.locator("#supplierDataList option[value='Proveedor estado UI']")).toHaveCount(0);

  await page.reload();
  await iniciarSesion(page);
  await abrirProveedores(page);
  supplierRow = page.locator("#suppliersTableBody tr").filter({
    hasText: "Proveedor estado UI"
  });
  await supplierRow.getByRole("button", { name: "Activar" }).click();
  await page.locator("#customConfirmBtn").click();
  await expect(supplierRow.getByRole("button", { name: "Inactivar" })).toBeVisible();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.reload();
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();
  await expect(page.locator("#supplierDataList option[value='Proveedor estado UI']")).toHaveCount(1);
});

test("PROVEEDORES: compra a crédito actualiza historial, deuda y pagos persistentes", async ({ page }) => {
  await iniciarSesion(page);
  await abrirCompras(page);
  await page.locator("#addNewPurchaseBtn").click();

  await page.locator("#quickAddProductFromPurchBtn").click();
  await page.locator("#prodBarcode").fill("PROV-LEDGER-001");
  await page.locator("#prodName").fill("Producto historial proveedor");
  await page.locator("#prodCost").fill("10");
  await page.locator("#prodStock").fill("0");
  await page.locator("#prodMinStock").fill("1");
  await page.locator("#productForm button[type='submit']").click();
  await expect(page.locator("#productModal")).toBeHidden();
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.locator("#quickAddSupplierFromPurchBtn").click();
  await page.locator("#suppName").fill("Proveedor historial UI");
  await page.locator("#suppContact").fill("Contacto historial");
  await page.locator("#suppPhone").fill("87776655");
  await page.locator("#supplierForm button[type='submit']").click();
  await expect(page.locator("#supplierModal")).toBeHidden();
  await expect(page.locator("#purchSupplier")).toHaveValue("Proveedor historial UI");
  await page.locator("#customAlertModal .close-modal-btn").click();

  await page.locator("#purchInvoice").fill("FACT-PROV-LEDGER-001");
  await page.locator("#purchType").selectOption("credito");
  await page.locator("#purchProductTemp").fill("Producto historial proveedor");
  await page.locator("#purchQtyTemp").fill("2");
  await page.locator("#purchCostTemp").fill("12");
  await page.locator("#btnAddItemToPurch").click();
  await page.locator("#purchaseForm button[type='submit']").click();

  const purchaseRow = page.locator("#purchasesTableBody tr").filter({
    hasText: "FACT-PROV-LEDGER-001"
  });
  await expect(purchaseRow).toContainText("Proveedor historial UI");
  await expect(purchaseRow).toContainText("C$24.00");
  await page.locator("#customAlertModal .close-modal-btn").click();

  await abrirProveedores(page);
  const supplierRow = page.locator("#suppliersTableBody tr").filter({
    hasText: "Proveedor historial UI"
  });
  await expect(supplierRow).toContainText("C$24.00");
  await expect(supplierRow).toContainText("1 compras");
  await supplierRow.getByRole("button", { name: "Edo. Cuenta" }).click();
  await expect(page.locator("#statementModalTitle")).toContainText("Proveedor historial UI");
  await expect(page.locator("#statementTableBody")).toContainText("FACT-PROV-LEDGER-001");
  await expect(page.locator("#statementTableBody")).toContainText("Pendiente C$24.00");
  await page.locator("#statementTableBody").getByRole("button", { name: "Abonar" }).click();

  await expect(page.locator("#paymentInvoiceModal")).toBeVisible();
  await expect(page.locator("#payInvoiceSaldo")).toHaveText("C$24.00");
  await page.locator("#payInvoiceAmount").fill("5");
  await page.locator("#payInvoiceMethod").selectOption("transferencia");
  await page.locator("#paymentInvoiceForm button[type='submit']").click();
  await expect(supplierRow).toContainText("C$19.00");
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#statementTableBody")).toContainText("Pago a proveedor por transferencia");

  const paymentRow = page.locator("#statementTableBody tr").filter({
    hasText: "Pago a proveedor por transferencia"
  });
  await paymentRow.getByRole("button", { name: "Anular" }).click();
  await expect(page.locator("#anularRegistroModal")).toBeVisible();
  await page.locator("#anularRegistroMotivo").fill("Pago aplicado por error");
  await page.locator("#anularRegistroForm button[type='submit']").click();
  await expect(page.locator("#customAlertMessage")).toContainText("Pago anulado exitosamente");
  await expect(supplierRow).toContainText("C$24.00");
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#statementTableBody")).toContainText("ANULADO");

  await page.reload();
  await iniciarSesion(page);
  await abrirProveedores(page);
  const persistedSupplierRow = page.locator("#suppliersTableBody tr").filter({
    hasText: "Proveedor historial UI"
  });
  await expect(persistedSupplierRow).toContainText("C$24.00");
  await expect(persistedSupplierRow).toContainText("1 compras");
  await persistedSupplierRow.getByRole("button", { name: "Edo. Cuenta" }).click();
  await expect(page.locator("#statementTableBody")).toContainText("FACT-PROV-LEDGER-001");
  await expect(page.locator("#statementTableBody")).toContainText("ANULADO");
});

async function abrirCajaDesdeUI(page, efectivoInicial) {
  await page.locator("#navCajaBtn").click();
  await expect(page.locator("#cajaView")).toBeVisible();
  await page.locator("#cajaEfectivoInicialInput").fill(String(efectivoInicial));
  await page.locator("#abrirCajaBtn").click();
  await expect(page.locator("#cajaAbrirBox")).toBeHidden();
  await expect(page.locator("#cajaAbiertaBox")).toBeVisible();
}

async function crearProductoParaCaja(page, barcode, name) {
  await abrirInventario(page);
  await page.locator("#addNewProductBtn").click();
  await page.locator("#prodBarcode").fill(barcode);
  await page.locator("#prodName").fill(name);
  await page.locator("#prodCost").fill("10");
  await page.locator("#prodRetail").fill("15");
  await page.locator("#prodWholesale").fill("13");
  await page.locator("#prodStock").fill("10");
  await page.locator("#prodMinStock").fill("1");
  await page.locator("#productForm button[type='submit']").click();
  await expect(page.locator("#productModal")).toBeHidden();
  await expect(page.locator("#customAlertModal")).toBeVisible();
  await page.locator("#customAlertModal .close-modal-btn").click();
  await expect(page.locator("#inventoryTableBody")).toContainText(barcode);
}

async function venderProductoDesdeUI(page, barcode) {
  await page.locator("#navSalesBtn").click();
  await page.locator("#barcodeInput").fill(barcode);
  await page.locator("#addBarcodeBtn").click();
  await expect(page.locator("#cartItems")).not.toContainText("Carrito vacío");
  await page.locator("#processSaleBtn").click();
}

const cajaConsoleErrors = new WeakMap();

test.describe("CAJA:", () => {
  test.beforeEach(async ({ page }) => {
    const errors = [];
    cajaConsoleErrors.set(page, errors);
    monitorRequests(page, errors);
  });

  async function crearProductoParaPayables(page, barcode, name) {
    await abrirInventario(page);
    await page.locator("#addNewProductBtn").click();
    await page.locator("#prodBarcode").fill(barcode);
    await page.locator("#prodName").fill(name);
    await page.locator("#prodCost").fill("10");
    await page.locator("#prodRetail").fill("15");
    await page.locator("#prodWholesale").fill("13");
    await page.locator("#prodStock").fill("0");
    await page.locator("#prodMinStock").fill("1");
    await page.locator("#productForm button[type='submit']").click();
    await expect(page.locator("#productModal")).toBeHidden();
    await page.locator("#customAlertModal .close-modal-btn").click();
  }

  async function registrarCompraPayables(page, { supplier, invoice, type = "credito", quantity = "1", cost = "10", days = "30", product }) {
    await abrirCompras(page);
    await page.locator("#addNewPurchaseBtn").click();
    await page.locator("#purchSupplier").fill(supplier);
    await page.locator("#purchInvoice").fill(invoice);
    await page.locator("#purchType").selectOption(type);
    if (type === "credito") await page.locator("#purchDays").fill(days);
    await page.locator("#purchProductTemp").fill(product);
    await page.locator("#purchQtyTemp").fill(quantity);
    await page.locator("#purchCostTemp").fill(cost);
    await page.locator("#btnAddItemToPurch").click();
    await page.locator("#purchaseForm button[type='submit']").click();
    await expect(page.locator("#purchaseModal")).toBeHidden();
    await expect(page.locator("#customAlertModal")).toBeVisible();
    await page.locator("#customAlertModal .close-modal-btn").click();
  }

  async function abrirEstadoCuentaDesdePayables(page, supplier) {
    await page.locator("#navPayablesBtn").click();
    await expect(page.locator("#payablesView")).toBeVisible();
    const payableRow = page.locator("#payablesTableBody tr").filter({ hasText: supplier });
    await expect(payableRow).toBeVisible();
    await payableRow.getByRole("button", { name: "Ver Facturas" }).click();
    await expect(page.locator("#statementModalTitle")).toContainText(supplier);
    return payableRow;
  }

  function filaFacturaEstadoCuenta(page, invoice) {
    return page.locator("#statementTableBody tr").filter({
      has: page.getByText(invoice, { exact: true })
    });
  }

  function filaPagoEstadoCuenta(page, invoice) {
    return page.locator("#statementTableBody tr").filter({
      has: page.getByText(`Pago ${invoice}`, { exact: true })
    });
  }

  const payablesConsoleErrors = new WeakMap();

  test.describe("PAYABLES:", () => {
    test.beforeEach(async ({ page }) => {
      const errors = [];
      payablesConsoleErrors.set(page, errors);
      monitorRequests(page, errors);
    });

    test.afterEach(async ({ page }) => {
      expect(payablesConsoleErrors.get(page)).toEqual([]);
    });

    test("crédito crea deuda pendiente por proveedor; contado no crea cuenta y el vencimiento pasa a la siguiente factura abierta", async ({ page }) => {
      await iniciarSesion(page);
      await crearProductoParaPayables(page, "PAYABLES-BILL-001", "Producto para cuenta por pagar");

      await registrarCompraPayables(page, {
        supplier: "Proveedor payables A",
        invoice: "PAY-OPEN-001",
        quantity: "3",
        cost: "10",
        days: "30",
        product: "Producto para cuenta por pagar"
      });
      await registrarCompraPayables(page, {
        supplier: "Proveedor payables A",
        invoice: "PAY-OPEN-002",
        quantity: "2",
        cost: "10",
        days: "15",
        product: "Producto para cuenta por pagar"
      });
      await registrarCompraPayables(page, {
        supplier: "Proveedor payables contado",
        invoice: "PAY-CASH-001",
        type: "contado",
        quantity: "1",
        cost: "10",
        product: "Producto para cuenta por pagar"
      });

      await page.locator("#navPayablesBtn").click();
      await expect(page.locator("#payablesView")).toBeVisible();
      const supplierRow = page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor payables A"
      });
      await expect(supplierRow).toContainText("C$50.00");
      const expectedNearestDueDate = await page.evaluate(() => {
        const due = new Date();
        due.setDate(due.getDate() + 15);
        return due.toLocaleDateString();
      });
      await expect(supplierRow).toContainText(expectedNearestDueDate);
      await expect(page.locator("#payablesTableBody")).not.toContainText("Proveedor payables contado");

      await supplierRow.getByRole("button", { name: "Ver Facturas" }).click();
      const secondInvoice = filaFacturaEstadoCuenta(page, "PAY-OPEN-002");
      await expect(secondInvoice).toContainText("C$20.00");
      await expect(secondInvoice).toContainText("Pendiente C$20.00");
      await secondInvoice.getByRole("button", { name: "Abonar" }).click();
      await page.locator("#payInvoiceAmount").fill("20");
      await page.locator("#payInvoiceMethod").selectOption("transferencia");
      await page.locator("#paymentInvoiceForm button[type='submit']").click();
      await expect(page.locator("#customAlertMessage")).toContainText("Pago de factura registrado");
      await page.locator("#customAlertModal .close-modal-btn").click();

      await expect(page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor payables A"
      })).toContainText("C$30.00");
      await expect(page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor payables A"
      })).toContainText(await page.evaluate(() => {
        const due = new Date();
        due.setDate(due.getDate() + 30);
        return due.toLocaleDateString();
      }));
      const paidInvoice = filaFacturaEstadoCuenta(page, "PAY-OPEN-002");
      await expect(paidInvoice).toContainText("Pendiente C$0.00");
      await expect(paidInvoice.getByRole("button", { name: "Abonar" })).toHaveCount(0);

      await page.reload();
      await iniciarSesion(page);
      await page.locator("#navPayablesBtn").click();
      await expect(page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor payables A"
      })).toContainText("C$30.00");
      await expect(page.locator("#payablesTableBody")).not.toContainText("Proveedor payables contado");
    });

    test("valida pagos, permite abonos parciales y exactos, muestra pagada y persiste", async ({ page }) => {
      await iniciarSesion(page);
      await crearProductoParaPayables(page, "PAYABLES-PAY-001", "Producto para pago de cuenta");
      await registrarCompraPayables(page, {
        supplier: "Proveedor pagos límite",
        invoice: "PAY-LIMIT-001",
        quantity: "2",
        cost: "10.25",
        days: "21",
        product: "Producto para pago de cuenta"
      });

      const payableRow = await abrirEstadoCuentaDesdePayables(page, "Proveedor pagos límite");
      await expect(payableRow).toContainText("C$20.50");
      const invoiceRow = filaFacturaEstadoCuenta(page, "PAY-LIMIT-001");
      await expect(invoiceRow).toContainText("Pendiente C$20.50");
      await expect(invoiceRow).toContainText("Abonado C$0.00");
      await invoiceRow.getByRole("button", { name: "Abonar" }).click();

      await expect(page.locator("#payInvoiceTotal")).toHaveText("C$20.50");
      await expect(page.locator("#payInvoiceSaldo")).toHaveText("C$20.50");
      expect(await page.locator("#payInvoiceAmount").evaluate(input => input.checkValidity())).toBe(false);

      for (const amount of ["0", "-1", "20.51"]) {
        await page.locator("#payInvoiceAmount").fill(amount);
        expect(await page.locator("#payInvoiceAmount").evaluate(input => input.checkValidity())).toBe(false);
        await page.locator("#paymentInvoiceForm button[type='submit']").click();
        await expect(page.locator("#paymentInvoiceModal")).toBeVisible();
        await expect(page.locator("#payInvoiceSaldo")).toHaveText("C$20.50");
      }
      await page.locator("#payInvoiceAmount").fill("   ");
      await expect(page.locator("#payInvoiceAmount")).toHaveValue("");
      expect(await page.locator("#payInvoiceAmount").evaluate(input => input.checkValidity())).toBe(false);
      await page.locator("#paymentInvoiceForm button[type='submit']").click();
      await expect(page.locator("#paymentInvoiceModal")).toBeVisible();

      await page.locator("#paymentInvoiceModal .close-modal-btn").click();
      await expect(page.locator("#customConfirmModal")).toBeVisible();
      await page.locator("#customConfirmBtn").click();
      await expect(page.locator("#paymentInvoiceModal")).toBeHidden();
      await abrirEstadoCuentaDesdePayables(page, "Proveedor pagos límite");
      await expect(invoiceRow).toContainText("Pendiente C$20.50");
      await invoiceRow.getByRole("button", { name: "Abonar" }).click();
      await page.locator("#payInvoiceAmount").fill("7.25");
      await page.locator("#paymentInvoiceForm button[type='submit']").click();
      await expect(page.locator("#customAlertMessage")).toContainText("No hay una caja abierta");
      await expect(invoiceRow).toContainText("Pendiente C$20.50");
      await page.locator("#customAlertModal .close-modal-btn").click();

      await page.locator("#payInvoiceAmount").fill("7.25");
      await page.locator("#payInvoiceMethod").selectOption("transferencia");
      await page.locator("#paymentInvoiceForm button[type='submit']").click();
      await expect(page.locator("#paymentInvoiceModal")).toBeHidden();
      await expect(invoiceRow).toContainText("Pendiente C$13.25");
      await expect(invoiceRow).toContainText("Abonado C$7.25");
      await expect(payableRow).toContainText("C$13.25");
      await page.locator("#customAlertModal .close-modal-btn").click();

      const partialPayment = page.locator("#statementTableBody tr").filter({
        hasText: "Pago a proveedor por transferencia"
      });
      await expect(partialPayment).toContainText("C$7.25");
      await expect(partialPayment).toContainText("andres");
      const paymentDate = await page.evaluate(() => new Date().toLocaleDateString());
      await expect(partialPayment).toContainText(paymentDate);
      await expect(invoiceRow).toContainText("Pendiente C$13.25");

      await invoiceRow.getByRole("button", { name: "Abonar" }).click();
      await page.locator("#payInvoiceAmount").fill("13.25");
      await page.locator("#paymentInvoiceForm button[type='submit']").click();
      await expect(page.locator("#customAlertModal")).toBeVisible();
      const paidInvoice = filaFacturaEstadoCuenta(page, "PAY-LIMIT-001");
      await expect(paidInvoice).toContainText("Pendiente C$0.00");
      await expect(paidInvoice.getByRole("button", { name: "Abonar" })).toHaveCount(0);
      await page.locator("#customAlertModal .close-modal-btn").click();
      await expect(page.locator("#payablesTableBody")).toContainText("No hay cuentas por pagar pendientes");

      await page.reload();
      await iniciarSesion(page);
      await page.locator("#navPayablesBtn").click();
      await expect(page.locator("#payablesTableBody")).toContainText("No hay cuentas por pagar pendientes");
      await page.locator("#navSuppliersBtn").click();
      const supplierRow = page.locator("#suppliersTableBody tr").filter({
        hasText: "Proveedor pagos límite"
      });
      await supplierRow.getByRole("button", { name: "Edo. Cuenta" }).click();
      await expect(page.locator("#statementTableBody")).toContainText("Pago PAY-LIMIT-001");
      await expect(page.locator("#statementTableBody")).toContainText("C$13.25");
      await expect(page.locator("#statementTableBody")).toContainText("C$7.25");
    });

    test("pago efectivo enlaza una sola salida a Caja; cancelar anulación conserva datos y anular después del cierre corrige historial", async ({ page }) => {
      await iniciarSesion(page);
      await crearProductoParaPayables(page, "PAYABLES-CASH-001", "Producto para pago efectivo");
      await registrarCompraPayables(page, {
        supplier: "Proveedor pago efectivo",
        invoice: "PAY-CASH-001",
        quantity: "2",
        cost: "10",
        product: "Producto para pago efectivo"
      });
      await abrirCajaDesdeUI(page, "100");

      await abrirEstadoCuentaDesdePayables(page, "Proveedor pago efectivo");
      let invoiceRow = filaFacturaEstadoCuenta(page, "PAY-CASH-001");
      await invoiceRow.getByRole("button", { name: "Abonar" }).click();
      await page.locator("#payInvoiceAmount").fill("5");
      await page.locator("#payInvoiceMethod").selectOption("efectivo");
      await page.locator("#paymentInvoiceForm button[type='submit']").click();
      await expect(page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor pago efectivo"
      })).toContainText("C$15.00");
      await page.locator("#customAlertModal .close-modal-btn").click();
      await expect(page.locator("#statementModal")).toBeVisible();

      await page.locator("#statementTableBody tr").filter({
        hasText: "Pago a proveedor por efectivo"
      }).getByRole("button", { name: "Anular" }).click();
      await expect(page.locator("#anularRegistroModal")).toBeVisible();
      await page.locator("#anularRegistroModal .close-modal-btn").click();
      await expect(page.locator("#customConfirmModal")).toBeVisible();
      await page.locator("#customConfirmBtn").click();
      await expect(page.locator("#anularRegistroModal")).toBeHidden();
      await expect(page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor pago efectivo"
      })).toContainText("C$15.00");
      await expect(page.locator("#statementTableBody")).not.toContainText("ANULADO");

      await page.locator("#navCajaBtn").click();
      await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$5.00");
      await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$95.00");
      await expect(page.locator("#cajaCentralBox #cajaMovimientosBody tr").filter({
        hasText: "Pago Factura PAY-CASH-001: Proveedor pago efectivo"
      })).toHaveCount(1);

      await page.locator("#cerrarCajaBtn").click();
      await page.locator("#cajaEfectivoRealInput").fill("95");
      await page.locator("#confirmCierreCajaBtn").click();
      await page.locator("#customAlertModal .close-modal-btn").click();

      await page.locator("#navPayablesBtn").click();
      const closedSessionPayableRow = page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor pago efectivo"
      });
      await closedSessionPayableRow.getByRole("button", { name: "Ver Facturas" }).click();
      const paymentRow = filaPagoEstadoCuenta(page, "PAY-CASH-001");
      await paymentRow.getByRole("button", { name: "Anular" }).click();
      await page.locator("#anularRegistroMotivo").fill("Pago aplicado incorrectamente");
      await page.locator("#anularRegistroForm button[type='submit']").click();
      await expect(page.locator("#customAlertMessage")).toContainText("Pago anulado exitosamente");
      await expect(page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor pago efectivo"
      })).toContainText("C$20.00");
      await page.locator("#customAlertModal .close-modal-btn").click();
      await expect(page.locator("#statementTableBody")).toContainText("ANULADO");
      await expect(page.locator("#statementTableBody tr").filter({
        hasText: "Pago PAY-CASH-001"
      }).getByRole("button", { name: "Anular" })).toHaveCount(0);

      await expect(page.locator("#statementModal")).toBeVisible();
      await page.locator("#statementModal .close-modal-btn").click();
      await page.locator("#navCajaBtn").click();
      const closedSession = page.locator("#cajaHistorialBody tr").first();
      await expect(closedSession.locator("td").nth(3)).toHaveText("C$100.00");
      await expect(closedSession.locator("td").nth(4)).toHaveText("C$100.00");
      await expect(closedSession.locator("td").nth(5)).toHaveText("C$95.00");
      await expect(closedSession.locator("td").nth(6)).toHaveText("C$-5.00");

      await page.reload();
      await iniciarSesion(page);
      await page.locator("#navPayablesBtn").click();
      await expect(page.locator("#payablesTableBody tr").filter({
        hasText: "Proveedor pago efectivo"
      })).toContainText("C$20.00");
      await page.locator("#navReportesBtn").click();
      await expect(page.locator("#repCxP")).toHaveText("C$20.00");
      await page.locator("#navCajaBtn").click();
      await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$-5.00");
    });
  });

  const gastosConsoleErrors = new WeakMap();

  test.describe("GASTOS:", () => {
    test.beforeEach(async ({ page }) => {
      const errors = [];
      gastosConsoleErrors.set(page, errors);
      monitorRequests(page, errors);
    });

    test.afterEach(async ({ page }) => {
      expect(gastosConsoleErrors.get(page)).toEqual([]);
    });

    test("valida descripción y monto obligatorios, rechaza cero, negativos y solo espacios", async ({ page }) => {
      await iniciarSesion(page);
      await page.locator("#navGastosBtn").click();
      await expect(page.locator("#gastosView")).toBeVisible();

      await page.locator("#formRegistrarGasto button[type='submit']").click();
      const invalidFields = await page.locator("#formRegistrarGasto").evaluate(form =>
        [...form.querySelectorAll("[required]")]
          .filter(field => !field.checkValidity())
          .map(field => field.id)
      );
      expect(invalidFields).toEqual(["gastoDescripcion", "gastoMonto"]);
      await expect(page.locator("#gastosTableBody")).toContainText("Sin gastos registrados");

      await page.locator("#gastoDescripcion").fill("Gasto inválido");
      for (const amount of ["0", "-1"]) {
        await page.locator("#gastoMonto").fill(amount);
        expect(await page.locator("#gastoMonto").evaluate(input => input.checkValidity())).toBe(false);
        await page.locator("#formRegistrarGasto button[type='submit']").click();
        await expect(page.locator("#gastosTableBody")).not.toContainText("Gasto inválido");
      }

      await page.locator("#gastoMetodo").selectOption("banco");
      await page.locator("#gastoMonto").fill("1.25");
      await page.locator("#gastoDescripcion").fill("   ");
      expect(await page.locator("#gastoDescripcion").evaluate(input => input.checkValidity())).toBe(true);
      await page.locator("#formRegistrarGasto button[type='submit']").click();
      await expect(page.locator("#customAlertMessage")).toContainText("Ingrese una descripción válida");
      await expect(page.locator("#gastosTableBody")).toContainText("Sin gastos registrados");
    });

    test("registra categorías, métodos, usuario y fecha; persiste y actualiza historial y reportes", async ({ page }) => {
      await iniciarSesion(page);
      await abrirCajaDesdeUI(page, "100");
      await page.locator("#navGastosBtn").click();

      const categories = await page.locator("#gastoCategoria option").allTextContents();
      expect(categories).toEqual([
        "Servicios Básicos",
        "Renta / Alquiler",
        "Transporte",
        "Sueldos",
        "Mantenimiento",
        "Insumos de Limpieza",
        "Otro"
      ]);

      await page.locator("#gastoCategoria").selectOption("Servicios Básicos");
      await page.locator("#gastoMetodo").selectOption("caja");
      await page.locator("#gastoDescripcion").fill("Electricidad de octubre");
      await page.locator("#gastoComprobante").fill("REC-GAS-001");
      await page.locator("#gastoMonto").fill("10.25");
      await page.locator("#formRegistrarGasto button[type='submit']").click();
      const cashExpenseRow = page.locator("#gastosTableBody tr").filter({
        hasText: "Electricidad de octubre"
      });
      await expect(cashExpenseRow).toBeVisible();
      const localDate = await page.evaluate(() => new Date().toLocaleDateString());
      await expect(cashExpenseRow).toContainText(localDate);
      await expect(page.locator("#gastosTableBody")).toContainText("Servicios Básicos");
      await expect(page.locator("#gastosTableBody")).toContainText("REC-GAS-001");
      await expect(page.locator("#gastosTableBody")).toContainText("C$10.25");
      await expect(page.locator("#gastosTableBody")).toContainText("andres");
      await expect(page.locator("#gastosResumenHoy")).toHaveText("C$10.25");
      await expect(page.locator("#gastosResumenTotal")).toHaveText("C$10.25");
      await expect(page.locator("#gastoDescripcion")).toHaveValue("");
      await expect(page.locator("#gastoMonto")).toHaveValue("");
      await page.locator("#customAlertModal .close-modal-btn").click();

      await page.locator("#gastoCategoria").selectOption("Transporte");
      await page.locator("#gastoMetodo").selectOption("banco");
      await page.locator("#gastoDescripcion").fill("Combustible pagado con tarjeta");
      await page.locator("#gastoMonto").fill("4.50");
      await page.locator("#formRegistrarGasto button[type='submit']").click();
      await expect(page.locator("#gastosResumenTotal")).toHaveText("C$14.75");
      await page.locator("#customAlertModal .close-modal-btn").click();

      await page.locator("#gastoCategoria").selectOption("Renta / Alquiler");
      await page.locator("#gastoMetodo").selectOption("pendiente");
      await page.locator("#gastoDescripcion").fill("Renta pendiente");
      await page.locator("#gastoMonto").fill("20");
      await page.locator("#formRegistrarGasto button[type='submit']").click();
      await expect(page.locator("#gastosResumenTotal")).toHaveText("C$34.75");
      await page.locator("#customAlertModal .close-modal-btn").click();

      await page.locator("#navCajaBtn").click();
      await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$10.25");
      await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$89.75");
      await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).toContainText("Gasto: Servicios Básicos - Electricidad de octubre");
      await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).not.toContainText("Combustible pagado con tarjeta");
      await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).not.toContainText("Renta pendiente");

      await page.locator("#navHistoryBtn").click();
      await expect(page.locator("#summaryTotalExpenses")).toHaveText("C$34.75");

      await page.reload();
      await iniciarSesion(page);
      await page.locator("#navGastosBtn").click();
      await expect(page.locator("#gastosTableBody")).toContainText("Electricidad de octubre");
      await expect(page.locator("#gastosTableBody")).toContainText("Combustible pagado con tarjeta");
      await expect(page.locator("#gastosTableBody")).toContainText("Renta pendiente");
      await expect(page.locator("#gastosResumenTotal")).toHaveText("C$34.75");
      await page.locator("#navReportesBtn").click();
      await expect(page.locator("#repGastos")).toHaveText("C$34.75");
      await page.locator('.rep-subtab[data-target="repGastosBox"]').click();
      await expect(page.locator("#repGastosCategoriaBody")).toContainText("Servicios Básicos");
      await expect(page.locator("#repGastosCategoriaBody")).toContainText("C$10.25");
      await expect(page.locator("#repGastosCategoriaBody")).toContainText("Transporte");
      await expect(page.locator("#repGastosCategoriaBody")).toContainText("C$4.50");
      await expect(page.locator("#repGastosCategoriaBody")).toContainText("Renta / Alquiler");
      await expect(page.locator("#repGastosCategoriaBody")).toContainText("C$20.00");
    });

    test("requiere caja solo para efectivo y anular permite cancelar o revertir gastos de la sesión", async ({ page }) => {
      await iniciarSesion(page);
      await page.locator("#navGastosBtn").click();

      await page.locator("#gastoMetodo").selectOption("caja");
      await page.locator("#gastoDescripcion").fill("Intento sin caja");
      await page.locator("#gastoMonto").fill("5");
      await page.locator("#formRegistrarGasto button[type='submit']").click();
      await expect(page.locator("#customAlertMessage")).toContainText("No hay caja abierta");
      await expect(page.locator("#gastosTableBody")).not.toContainText("Intento sin caja");
      await page.locator("#customAlertModal .close-modal-btn").click();

      await page.locator("#gastoMetodo").selectOption("banco");
      await page.locator("#gastoDescripcion").fill("Banco sin caja abierta");
      await page.locator("#gastoMonto").fill("2.50");
      await page.locator("#formRegistrarGasto button[type='submit']").click();
      await expect(page.locator("#gastosTableBody")).toContainText("Banco sin caja abierta");
      await expect(page.locator("#gastosTableBody")).toContainText("Banco");
      await page.locator("#customAlertModal .close-modal-btn").click();

      await abrirCajaDesdeUI(page, "50");
      await page.locator("#navGastosBtn").click();
      await page.locator("#gastoMetodo").selectOption("caja");
      await page.locator("#gastoDescripcion").fill("Gasto de sesión uno");
      await page.locator("#gastoMonto").fill("8.40");
      await page.locator("#formRegistrarGasto button[type='submit']").click();
      await page.locator("#customAlertModal .close-modal-btn").click();
      await page.locator("#navCajaBtn").click();
      await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$8.40");
      await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$41.60");
      await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).toContainText("Gasto: Servicios Básicos - Gasto de sesión uno");

      await page.locator("#navGastosBtn").click();
      const expenseRow = page.locator("#gastosTableBody tr").filter({
        hasText: "Gasto de sesión uno"
      });
      await expenseRow.getByRole("button", { name: "Anular" }).click();
      await expect(page.locator("#anularRegistroModal")).toBeVisible();
      await page.locator("#anularRegistroModal .close-modal-btn").click();
      await expect(page.locator("#customConfirmModal")).toBeVisible();
      await page.locator("#customConfirmBtn").click();
      await expect(expenseRow).not.toContainText("ANULADO");
      await expect(page.locator("#gastosResumenTotal")).toHaveText("C$10.90");

      await expenseRow.getByRole("button", { name: "Anular" }).click();
      await page.locator("#anularRegistroForm button[type='submit']").click();
      await expect(page.locator("#anularRegistroModal")).toBeVisible();
      expect(await page.locator("#anularRegistroMotivo").evaluate(input => input.checkValidity())).toBe(false);
      await page.locator("#anularRegistroMotivo").fill("Gasto equivocado");
      await page.locator("#anularRegistroForm button[type='submit']").click();
      await expect(page.locator("#customAlertMessage")).toContainText("Gasto anulado");
      await expect(expenseRow).toContainText("ANULADO");
      await expect(expenseRow.getByRole("button", { name: "Anular" })).toHaveCount(0);
      await expect(page.locator("#gastosResumenTotal")).toHaveText("C$2.50");
      await page.locator("#customAlertModal .close-modal-btn").click();

      await page.locator("#navCajaBtn").click();
      await expect(page.locator("#cajaResumenEntradas")).toHaveText("C$8.40");
      await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$8.40");
      await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$50.00");
      await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).toContainText("Anulación Gasto: Gasto de sesión uno (Gasto equivocado)");

      await page.locator("#cerrarCajaBtn").click();
      await page.locator("#cajaEfectivoRealInput").fill("50");
      await page.locator("#confirmCierreCajaBtn").click();
      await page.locator("#customAlertModal .close-modal-btn").click();
      await abrirCajaDesdeUI(page, "20");

      await page.locator("#navGastosBtn").click();
      await page.locator("#gastoMetodo").selectOption("caja");
      await page.locator("#gastoDescripcion").fill("Gasto de caja cerrada");
      await page.locator("#gastoMonto").fill("3");
      await page.locator("#formRegistrarGasto button[type='submit']").click();
      await page.locator("#customAlertModal .close-modal-btn").click();
      await page.locator("#navCajaBtn").click();
      await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$3.00");
      await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$17.00");
      await page.locator("#cerrarCajaBtn").click();
      await page.locator("#cajaEfectivoRealInput").fill("17");
      await page.locator("#confirmCierreCajaBtn").click();
      await page.locator("#customAlertModal .close-modal-btn").click();

      await page.locator("#navGastosBtn").click();
      const closedExpense = page.locator("#gastosTableBody tr").filter({
        hasText: "Gasto de caja cerrada"
      });
      await closedExpense.getByRole("button", { name: "Anular" }).click();
      await page.locator("#anularRegistroMotivo").fill("No correspondía cobrarlo");
      await page.locator("#anularRegistroForm button[type='submit']").click();
      await page.locator("#customAlertModal .close-modal-btn").click();
      await page.locator("#navCajaBtn").click();
      await expect(page.locator("#cajaAbrirBox")).toBeVisible();
      await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$20.00");
      await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$17.00");
      await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$-3.00");

      await page.reload();
      await iniciarSesion(page);
      await page.locator("#navGastosBtn").click();
      await expect(page.locator("#gastosTableBody")).toContainText("Banco sin caja abierta");
      await expect(page.locator("#gastosTableBody")).toContainText("Gasto de sesión uno");
      await expect(page.locator("#gastosTableBody")).toContainText("Gasto de caja cerrada");
      await expect(page.locator("#gastosResumenTotal")).toHaveText("C$2.50");
      await page.locator("#navHistoryBtn").click();
      await expect(page.locator("#summaryTotalExpenses")).toHaveText("C$2.50");
      await page.locator("#navReportesBtn").click();
      await expect(page.locator("#repGastos")).toHaveText("C$2.50");
      await page.locator('.rep-subtab[data-target="repGastosBox"]').click();
      await expect(page.locator("#repGastosCategoriaBody")).toContainText("C$2.50");
      await page.locator("#navCajaBtn").click();
      await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$20.00");
      await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$-3.00");
    });
  });

  test.afterEach(async ({ page }) => {
    expect(cajaConsoleErrors.get(page)).toEqual([]);
  });

  test("abre con monto válido, rechaza vacío y negativo, y persiste tras recargar", async ({ page }) => {
    await iniciarSesion(page);
    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaView")).toBeVisible();

    await page.locator("#abrirCajaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese el monto de efectivo inicial");
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#cajaEfectivoInicialInput").fill("  ");
    await expect(page.locator("#cajaEfectivoInicialInput")).toHaveValue("");
    await page.locator("#abrirCajaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese el monto de efectivo inicial");
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#cajaEfectivoInicialInput").fill("-1");
    await page.locator("#abrirCajaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese el monto de efectivo inicial");
    await expect(page.locator("#cajaAbrirBox")).toBeVisible();
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#cajaEfectivoInicialInput").fill("0");
    await page.locator("#abrirCajaBtn").click();
    await expect(page.locator("#cajaAbiertaBox")).toBeVisible();
    await expect(page.locator("#cajaResumenInicial")).toHaveText("C$0.00");
    await expect(page.locator("#cajaAbrirBox")).toBeHidden();

    await page.reload();
    await iniciarSesion(page);
    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaAbiertaBox")).toBeVisible();
    await expect(page.locator("#cajaResumenInicial")).toHaveText("C$0.00");
    await expect(page.locator("#cajaAbrirBox")).toBeHidden();
    await page.locator("#cerrarCajaBtn").click();
    await expect(page.locator("#cajaEsperadoDisplay")).toHaveText("C$0.00");
    await page.locator("#cajaEfectivoRealInput").fill("0");
    await page.locator("#confirmCierreCajaBtn").click();
    await expect(page.locator("#cajaAbiertaBox")).toBeHidden();
    await expect(page.locator("#cajaHistorialBody")).toContainText("C$0.00");
  });

  test("valida movimientos manuales, calcula decimales y confirma movimientos", async ({ page }) => {
    await iniciarSesion(page);
    await abrirCajaDesdeUI(page, "100.00");

    await page.locator("#cajaMovimientoConcepto").fill("Entrada con monto vacío");
    await page.locator("#registrarEntradaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese un monto válido");
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#cajaMovimientoConcepto").fill("Entrada negativa");
    await page.locator("#cajaMovimientoMonto").fill("-1");
    await page.locator("#registrarEntradaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese un monto válido");
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#cajaMovimientoConcepto").fill("Entrada de cero");
    await page.locator("#cajaMovimientoMonto").fill("0");
    await page.locator("#registrarEntradaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese un monto válido");
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#cajaMovimientoConcepto").fill("   ");
    await page.locator("#cajaMovimientoMonto").fill("1");
    await page.locator("#registrarEntradaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese un concepto");
    await page.locator("#customAlertModal .close-modal-btn").click();
    await expect(page.locator("#cajaMovimientosBody")).toContainText("Sin movimientos registrados");

    await page.locator("#cajaMovimientoConcepto").fill("Reposición de fondo");
    await page.locator("#cajaMovimientoMonto").fill("20.10");
    await page.locator("#registrarEntradaBtn").click();
    await page.locator("#cajaMovimientoConcepto").fill("Compra de bolsas");
    await page.locator("#cajaMovimientoMonto").fill("3.05");
    await page.locator("#registrarSalidaBtn").click();

    await expect(page.locator("#cajaResumenEntradas")).toHaveText("C$20.10");
    await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$3.05");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$117.05");

    const entryRow = page.locator("#cajaCentralBox #cajaMovimientosBody tr").filter({
      hasText: "Reposición de fondo"
    });
    await entryRow.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator("#cajaCentralBox #cajaMovimientosBody tr").filter({
      hasText: "Reposición de fondo"
    })).toContainText("Confirmado");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$117.05");

    await page.reload();
    await iniciarSesion(page);
    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$117.05");
    await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).toContainText("Compra de bolsas");
    await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).toContainText("Reposición de fondo");
  });

  test("ventas de contado sí suman efectivo; crédito y tarjeta no, y los cobros solo suman si son en efectivo", async ({ page }) => {
    await iniciarSesion(page);
    await crearProductoParaCaja(page, "CAJA-SALES-001", "Producto para integrar con Caja");
    await abrirClientes(page);
    await page.locator("#addNewClientBtn").click();
    await page.locator("#clientName").fill("Cliente para integración Caja");
    await page.locator("#clientLimit").fill("500");
    await page.locator("#clientDebt").fill("0");
    await page.locator("#clientForm button[type='submit']").click();
    const clientRow = page.locator("#clientsTableBody tr").filter({
      hasText: "Cliente para integración Caja"
    });
    const clientId = (await clientRow.locator("td").first().innerText()).split("\n")[0];

    await abrirCajaDesdeUI(page, "50.00");
    await venderProductoDesdeUI(page, "CAJA-SALES-001");
    await page.locator("#cashReceivedInput").fill("20");
    await page.locator("#confirmCashBtn").click();
    await expect(page.locator("#ticketModal")).toBeVisible();
    await page.locator("#newSaleBtn").click();
    await expect(page.locator("#cajaResumenVentas")).toHaveText("C$15.00");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$65.00");
    await page.locator("#navCajaBtn").click();
    const cashSale = page.locator("#cajaCentralBox #cajaOperacionesBody tr").filter({
      hasText: "Venta"
    }).filter({ hasText: "C$15.00" });
    await cashSale.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator("#cajaCentralBox #cajaOperacionesBody tr").filter({
      hasText: "Venta"
    }).filter({ hasText: "C$15.00" })).toContainText("Confirmado");
    await page.locator("#navSalesBtn").click();

    await page.locator('input[name="paymentMethod"][value="card"]').check();
    await venderProductoDesdeUI(page, "CAJA-SALES-001");
    await expect(page.locator("#ticketModal")).toBeVisible();
    await page.locator("#newSaleBtn").click();
    await expect(page.locator("#cajaResumenVentas")).toHaveText("C$15.00");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$65.00");

    await page.locator('input[name="paymentMethod"][value="credit"]').check();
    await page.locator("#creditClientSelect").selectOption(clientId);
    await venderProductoDesdeUI(page, "CAJA-SALES-001");
    await expect(page.locator("#ticketModal")).toBeVisible();
    await page.locator("#newSaleBtn").click();
    await expect(page.locator("#cajaResumenVentas")).toHaveText("C$15.00");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$65.00");
    await expect(page.locator("#cajaCentralVentas")).toHaveText("C$45.00");

    await abrirClientes(page);
    await clientRow.getByRole("button", { name: "Historial" }).click();
    await page.locator("#statementTableBody").getByRole("button", { name: "Abonar" }).click();
    await page.locator("#paySaleAmount").fill("5");
    await page.locator("#paySaleMethod").selectOption("efectivo");
    await page.locator("#paymentSaleForm button[type='submit']").click();
    await page.locator("#customAlertModal .close-modal-btn").click();
    await expect(page.locator("#statementTableBody")).toContainText("Pago recibido por efectivo");

    await page.locator("#statementTableBody").getByRole("button", { name: "Abonar" }).click();
    await page.locator("#paySaleAmount").fill("2");
    await page.locator("#paySaleMethod").selectOption("tarjeta");
    await page.locator("#paymentSaleForm button[type='submit']").click();
    await page.locator("#customAlertModal .close-modal-btn").click();
    await page.locator("#statementModal .close-modal-btn").click();

    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaResumenEntradas")).toHaveText("C$5.00");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$70.00");
    await expect(page.locator("#cajaCentralCobros")).toHaveText("C$7.00");
    const cashPayment = page.locator("#cajaCentralBox #cajaOperacionesBody tr").filter({
      hasText: "Cobro"
    }).filter({ hasText: "C$5.00" });
    await cashPayment.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator("#cajaCentralBox #cajaOperacionesBody tr").filter({
      hasText: "Cobro"
    }).filter({ hasText: "C$5.00" })).toContainText("Confirmado");
    await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).toContainText("Confirmado");

    await abrirClientes(page);
    await clientRow.getByRole("button", { name: "Historial" }).click();
    const cashAbono = page.locator("#statementTableBody tr").filter({
      hasText: "Pago recibido por efectivo"
    });
    await cashAbono.getByRole("button", { name: "Anular" }).click();
    await page.locator("#anularRegistroMotivo").fill("Cobro ingresado por error");
    await page.locator("#anularRegistroForm button[type='submit']").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Abono anulado exitosamente");
    await expect(page.locator("#statementTableBody")).toContainText("ANULADO");
    await page.locator("#customAlertModal .close-modal-btn").click();
    await page.locator("#statementModal .close-modal-btn").click();
    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaResumenEntradas")).toHaveText("C$5.00");
    await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$5.00");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$65.00");
    await expect(page.locator("#cajaCentralCobros")).toHaveText("C$2.00");

    await page.locator("#cerrarCajaBtn").click();
    await page.locator("#cajaEfectivoRealInput").fill("65");
    await page.locator("#confirmCierreCajaBtn").click();
    await page.locator("#customAlertModal .close-modal-btn").click();
    await page.locator("#navSalesBtn").click();
    await page.locator('input[name="paymentMethod"][value="cash"]').check();
    await venderProductoDesdeUI(page, "CAJA-SALES-001");
    await expect(page.locator("#customAlertMessage")).toContainText("No hay una caja abierta");
    await expect(page.locator("#ticketModal")).toBeHidden();
  });

  test("gastos en efectivo afectan la sesión correcta; otros medios no, y anular revierte el efectivo", async ({ page }) => {
    await iniciarSesion(page);
    await abrirCajaDesdeUI(page, "50.00");
    await page.locator("#navGastosBtn").click();
    await expect(page.locator("#gastosView")).toBeVisible();

    await page.locator("#gastoMetodo").selectOption("caja");
    await page.locator("#gastoDescripcion").fill("Reparación pagada en efectivo");
    await page.locator("#gastoComprobante").fill("G-CAJA-001");
    await page.locator("#gastoMonto").fill("20.15");
    await page.locator("#formRegistrarGasto button[type='submit']").click();
    await expect(page.locator("#gastosTableBody")).toContainText("Reparación pagada en efectivo");
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#gastoMetodo").selectOption("banco");
    await page.locator("#gastoDescripcion").fill("Servicio pagado por banco");
    await page.locator("#gastoMonto").fill("4.40");
    await page.locator("#formRegistrarGasto button[type='submit']").click();
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#gastoMetodo").selectOption("pendiente");
    await page.locator("#gastoDescripcion").fill("Servicio pendiente");
    await page.locator("#gastoMonto").fill("3.25");
    await page.locator("#formRegistrarGasto button[type='submit']").click();
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$20.15");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$29.85");

    await page.locator("#navGastosBtn").click();
    const cashExpense = page.locator("#gastosTableBody tr").filter({
      hasText: "Reparación pagada en efectivo"
    });
    await cashExpense.getByRole("button", { name: "Anular" }).click();
    await page.locator("#anularRegistroMotivo").fill("Gasto duplicado");
    await page.locator("#anularRegistroForm button[type='submit']").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Gasto anulado");
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaResumenEntradas")).toHaveText("C$20.15");
    await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$20.15");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$50.00");
    await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).toContainText("Anulación Gasto: Reparación pagada en efectivo");

    await page.locator("#cerrarCajaBtn").click();
    await page.locator("#cajaEfectivoRealInput").fill("50");
    await page.locator("#confirmCierreCajaBtn").click();
    await page.locator("#customAlertModal .close-modal-btn").click();
    await page.locator("#navGastosBtn").click();
    await page.locator("#gastoMetodo").selectOption("caja");
    await page.locator("#gastoDescripcion").fill("Gasto en efectivo posterior al cierre");
    await page.locator("#gastoMonto").fill("5");
    await page.locator("#formRegistrarGasto button[type='submit']").click();
    await expect(page.locator("#customAlertMessage")).toContainText("No hay caja abierta");
    await expect(page.locator("#gastosTableBody")).not.toContainText("Gasto en efectivo posterior al cierre");
  });

  test("compras no afectan Caja y pagos a proveedores en efectivo registran una salida", async ({ page }) => {
    await iniciarSesion(page);
    await crearProductoParaCaja(page, "CAJA-PURCHASE-001", "Producto comprado para Caja");
    await abrirCajaDesdeUI(page, "100.00");

    await abrirCompras(page);
    await page.locator("#addNewPurchaseBtn").click();
    await page.locator("#purchSupplier").fill("Proveedor pago Caja");
    await page.locator("#purchInvoice").fill("FACT-CAJA-001");
    await page.locator("#purchType").selectOption("credito");
    await page.locator("#purchProductTemp").fill("Producto comprado para Caja");
    await page.locator("#purchQtyTemp").fill("2");
    await page.locator("#purchCostTemp").fill("12");
    await page.locator("#btnAddItemToPurch").click();
    await page.locator("#purchaseForm button[type='submit']").click();
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#addNewPurchaseBtn").click();
    await page.locator("#purchSupplier").fill("Proveedor pago Caja");
    await page.locator("#purchInvoice").fill("FACT-CAJA-CASH-001");
    await page.locator("#purchType").selectOption("contado");
    await page.locator("#purchProductTemp").fill("Producto comprado para Caja");
    await page.locator("#purchQtyTemp").fill("1");
    await page.locator("#purchCostTemp").fill("10");
    await page.locator("#btnAddItemToPurch").click();
    await page.locator("#purchaseForm button[type='submit']").click();
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$100.00");
    await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$0.00");

    await abrirProveedores(page);
    const supplierRow = page.locator("#suppliersTableBody tr").filter({
      hasText: "Proveedor pago Caja"
    });
    await supplierRow.getByRole("button", { name: "Edo. Cuenta" }).click();
    await page.locator("#statementTableBody").getByRole("button", { name: "Abonar" }).click();
    await page.locator("#payInvoiceAmount").fill("5");
    await page.locator("#payInvoiceMethod").selectOption("efectivo");
    await page.locator("#paymentInvoiceForm button[type='submit']").click();
    await page.locator("#customAlertModal .close-modal-btn").click();
    await expect(supplierRow).toContainText("C$19.00");
    await page.locator("#statementTableBody").getByRole("button", { name: "Abonar" }).click();
    await page.locator("#payInvoiceAmount").fill("3");
    await page.locator("#payInvoiceMethod").selectOption("transferencia");
    await page.locator("#paymentInvoiceForm button[type='submit']").click();
    await page.locator("#customAlertModal .close-modal-btn").click();
    await expect(supplierRow).toContainText("C$16.00");
    await page.locator("#statementModal .close-modal-btn").click();

    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaResumenSalidas")).toHaveText("C$5.00");
    await expect(page.locator("#cajaResumenEsperado")).toHaveText("C$95.00");
    await expect(page.locator("#cajaCentralBox #cajaMovimientosBody")).toContainText("Pago Factura FACT-CAJA-001: Proveedor pago Caja");
  });

  test("cierra con validación y diferencia, permite corregir y anular movimientos del historial, conserva sesiones y reporta cierres", async ({ page }) => {
    await iniciarSesion(page);
    await abrirCajaDesdeUI(page, "100.10");

    await page.locator("#cajaMovimientoConcepto").fill("Ingreso registrado");
    await page.locator("#cajaMovimientoMonto").fill("20.20");
    await page.locator("#registrarEntradaBtn").click();
    await page.locator("#cerrarCajaBtn").click();
    await expect(page.locator("#cajaEsperadoDisplay")).toHaveText("C$120.30");

    await page.locator("#confirmCierreCajaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese el monto real de efectivo contado");
    await page.locator("#customAlertModal .close-modal-btn").click();
    await page.locator("#cajaEfectivoRealInput").fill("-1");
    await page.locator("#confirmCierreCajaBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Ingrese el monto real de efectivo contado");
    await page.locator("#customAlertModal .close-modal-btn").click();
    await page.locator("#cajaEfectivoRealInput").fill("125.30");
    await page.locator("#confirmCierreCajaBtn").click();
    await expect(page.locator("#cajaAbiertaBox")).toBeHidden();
    await expect(page.locator("#cajaAbrirBox")).toBeVisible();
    await expect(page.locator("#cajaHistorialBody tr")).toHaveCount(1);
    const firstClosedRow = page.locator("#cajaHistorialBody tr").first();
    await expect(firstClosedRow).toContainText("C$100.10");
    await expect(firstClosedRow).toContainText("C$120.30");
    await expect(firstClosedRow).toContainText("C$125.30");
    await expect(firstClosedRow).toContainText("C$5.00");
    await page.locator("#customAlertModal .close-modal-btn").click();

    let movementRow = page.locator("#cajaCentralBox #cajaMovimientosBody tr").filter({
      hasText: "Ingreso registrado"
    });
    await movementRow.getByRole("button", { name: "Corregir" }).click();
    await page.locator("#cashCorrectionNewAmount").fill("0");
    await page.locator("#cashCorrectionReason").fill("Corrección inválida");
    await page.locator("#confirmCashCorrectionBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("nuevo monto válido");
    await page.locator("#customAlertModal .close-modal-btn").click();
    await page.locator("#cashCorrectionNewAmount").fill("25.20");
    await page.locator("#cashCorrectionReason").fill("   ");
    await page.locator("#confirmCashCorrectionBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Indique el motivo");
    await page.locator("#customAlertModal .close-modal-btn").click();
    await page.locator("#cashCorrectionReason").fill("Conteo revisado");
    await page.locator("#confirmCashCorrectionBtn").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Corrección registrada");
    await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$125.30");
    await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$0.00");
    await page.locator("#customAlertModal .close-modal-btn").click();

    movementRow = page.locator("#cajaCentralBox #cajaMovimientosBody tr").filter({
      hasText: "Ingreso registrado"
    });
    await movementRow.getByRole("button", { name: "Anular" }).click();
    await page.locator("#anularRegistroForm button[type='submit']").click();
    await expect(page.locator("#anularRegistroModal")).toBeVisible();
    expect(await page.locator("#anularRegistroMotivo").evaluate(input => input.checkValidity())).toBe(false);
    await page.locator("#anularRegistroMotivo").fill("Movimiento duplicado");
    await page.locator("#anularRegistroForm button[type='submit']").click();
    await expect(page.locator("#customAlertMessage")).toContainText("Movimiento anulado");
    await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$100.10");
    await expect(page.locator("#cajaHistorialBody tr").first()).toContainText("C$25.20");
    await page.locator("#customAlertModal .close-modal-btn").click();

    await abrirCajaDesdeUI(page, "10.50");
    await page.locator("#cerrarCajaBtn").click();
    await expect(page.locator("#cajaEsperadoDisplay")).toHaveText("C$10.50");
    await page.locator("#cajaEfectivoRealInput").fill("10.50");
    await page.locator("#confirmCierreCajaBtn").click();
    await expect(page.locator("#cajaHistorialBody tr")).toHaveCount(2);
    await expect(page.locator("#cajaHistorialBody tr").nth(1)).toContainText("C$100.10");
    await expect(page.locator("#cajaHistorialBody tr").nth(1)).toContainText("C$25.20");
    await expect(page.locator("#customAlertModal .close-modal-btn")).toBeVisible();
    await page.locator("#customAlertModal .close-modal-btn").click();

    await page.reload();
    await iniciarSesion(page);
    await page.locator("#navCajaBtn").click();
    await expect(page.locator("#cajaAbrirBox")).toBeVisible();
    await expect(page.locator("#cajaAbiertaBox")).toBeHidden();
    await expect(page.locator("#cajaHistorialBody tr")).toHaveCount(2);
    await page.locator("#navReportesBtn").click();
    await expect(page.locator("#reportesView")).toBeVisible();
    await page.locator('.rep-subtab[data-target="repCajaBox"]').click();
    await expect(page.locator("#repCajaBody tr")).toHaveCount(2);
    await expect(page.locator("#repCajaBody")).toContainText("C$100.10");
    await expect(page.locator("#repCajaBody")).toContainText("C$25.20");
    await expect(page.locator("#repCajaBody")).toContainText("C$10.50");
  });
});
