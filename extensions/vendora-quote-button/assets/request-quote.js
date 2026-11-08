(() => {
  const root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";

  const messageFor = (block, response, result) => {
    if (response.ok) return block.dataset.msgDone.replace("__QUOTE__", result.quoteLabel);
    if (result.error === "forbidden") return block.dataset.msgForbidden;
    if (result.error === "rateLimited") return block.dataset.msgRateLimited;
    return block.dataset.msgFailed;
  };

  // Empty cart on a product page: quote the variant and quantity picked in the theme's product form.
  const productOnPage = (block) => {
    const productForm = document.querySelector('form[action*="/cart/add"]');
    const field = (name) => (productForm && productForm.elements.namedItem(name)) || null;
    const variantId = Number((field("id") && field("id").value) || block.dataset.variantId);
    const quantity = Math.max(1, Number(field("quantity") && field("quantity").value) || 1);
    return variantId ? [{ variantId, quantity }] : [];
  };

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest && event.target.closest(".vendora-rfq__form");
    if (!form) return;
    event.preventDefault();
    const block = form.closest(".vendora-rfq");
    const status = form.querySelector(".vendora-rfq__status");
    const button = form.querySelector("button");
    button.disabled = true;
    status.textContent = block.dataset.msgSending;
    try {
      const cart = await (await fetch(`${root}cart.js`)).json();
      const lines = cart.items.length
        ? cart.items.map((item) => ({ variantId: item.variant_id, quantity: item.quantity }))
        : productOnPage(block);
      if (!lines.length) {
        status.textContent = block.dataset.msgEmpty;
        return;
      }
      const response = await fetch("/apps/vendora/quote-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          locationId: block.dataset.locationId,
          message: form.elements.message ? form.elements.message.value : "",
          lines,
        }),
      });
      const result = await response.json().catch(() => ({}));
      status.textContent = messageFor(block, response, result);
      if (response.ok) form.reset();
    } catch {
      status.textContent = block.dataset.msgFailed;
    } finally {
      button.disabled = false;
    }
  });
})();
