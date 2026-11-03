import { expect, test } from "vitest";
import { createI18n } from "../lib/i18n";
import { escapeHtml, renderEmail } from "./templates";

test("escapeHtml escapes every HTML special character", () => {
  expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
});

test("renderEmail: translated subject and body, lang, URL in the text twin, user text escaped", () => {
  const { t } = createI18n("en");
  const email = renderEmail(
    "approvalNeeded",
    {
      quoteLabel: "Q-1001",
      shopName: "Snowdevil",
      url: "https://admin.shopify.com/store/x/apps/y/app/quotes/1",
      actor: "<b>Ana</b>",
      reasons: [{ code: "DISCOUNT_OVER", detail: "20 % > 15 %" }],
    },
    t,
    "en",
  );

  expect(email.subject).toBe("Approval needed: Q-1001");
  expect(email.html).toContain('<html lang="en">');
  expect(email.html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
  expect(email.html).not.toContain("<b>Ana</b>");
  expect(email.text).toContain("Reasons: Discount 20 % > 15 %.");
  expect(email.text).toContain("Review quote: https://admin.shopify.com/store/x/apps/y/app/quotes/1");
  expect(email.text).toContain("Snowdevil");
});

test("renderEmail quotes a rejection comment", () => {
  const { t } = createI18n("en");
  const email = renderEmail("rejected", { quoteLabel: "Q-1", shopName: "S", url: "https://a.test", actor: "Ben", comment: "Too cheap" }, t, "en");
  expect(email.text).toContain('"Too cheap"');
});
