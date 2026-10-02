const { test, expect } = require("@playwright/test");

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
