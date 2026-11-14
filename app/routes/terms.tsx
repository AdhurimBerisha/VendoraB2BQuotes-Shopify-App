import type { MetaFunction } from "react-router";
import LegalFooter from "../components/LegalFooter";
import styles from "../components/legal.module.css";

// Public terms of service (B-20). Free app (D-8): no billing section until pricing exists.
export const meta: MetaFunction = () => [{ title: "Terms of service · Vendora" }];

export default function Terms() {
  return (
    <main className={styles.legal}>
      <h1>Terms of service</h1>
      <p>Last updated: 14 November 2026</p>

      <h2>1. Who we are</h2>
      <p>
        Vendora is run by Adhurim Berisha, an individual based in Kosovo. Contact:{" "}
        <a href="mailto:adhurimberisha07@gmail.com">adhurimberisha07@gmail.com</a>. By installing Vendora on a
        Shopify store you (the merchant) agree to these terms.
      </p>

      <h2>2. The service</h2>
      <p>
        Vendora lets merchants create B2B quotes for their Shopify companies, approve them and turn them into
        Shopify draft orders. Vendora is currently free. If we introduce paid plans, we will tell you in
        advance and charge only through Shopify&apos;s billing, after you accept.
      </p>
      <p>
        Vendora does not replace your own checks: you are responsible for the prices, discounts, taxes and
        terms in the quotes and draft orders you send.
      </p>

      <h2>3. Your responsibilities</h2>
      <ul>
        <li>Use Vendora lawfully and in line with Shopify&apos;s terms.</li>
        <li>Make sure you may share your buyers&apos; data with Vendora for quoting.</li>
        <li>Keep access to your store and the app limited to the right staff.</li>
      </ul>

      <h2>4. Your data</h2>
      <p>
        Your data stays yours. We use it only to provide Vendora, as described in our{" "}
        <a href="/privacy">privacy policy</a>. You can export all quotes in Settings at any time. When you
        uninstall Vendora, your data is deleted about 48 hours later, when Shopify asks us to.
      </p>

      <h2>5. Availability</h2>
      <p>
        We work to keep Vendora available and correct, but we don&apos;t guarantee uninterrupted service. We may
        change features or pause the service for maintenance.
      </p>

      <h2>6. Warranty and liability</h2>
      <p>
        Vendora is provided &quot;as is&quot;, without warranties of any kind. To the extent the law allows, we
        are not liable for indirect or consequential losses, lost profits or lost data, and our total
        liability is limited to the amount you paid for Vendora in the 12 months before the claim.
      </p>

      <h2>7. Ending</h2>
      <p>
        You can stop using Vendora at any time by uninstalling it. We may stop providing it to a store that
        breaks these terms, or end the service with 30 days&apos; notice.
      </p>

      <h2>8. Changes</h2>
      <p>
        We may update these terms. We change the date above and, for important changes, tell merchants in the
        app in advance. Continuing to use Vendora after a change means you accept it.
      </p>

      <h2>9. Law</h2>
      <p>These terms are governed by the laws of the Republic of Kosovo, and its courts have jurisdiction.</p>

      <LegalFooter />
    </main>
  );
}
