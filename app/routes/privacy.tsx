import type { MetaFunction } from "react-router";
import LegalFooter from "../components/LegalFooter";
import styles from "../components/legal.module.css";

// Public privacy policy (B-20, M5.4). Keep in step with roadmap/compliance/protected-customer-data.md.
export const meta: MetaFunction = () => [{ title: "Privacy policy · Vendora" }];

export default function Privacy() {
  return (
    <main className={styles.legal}>
      <h1>Privacy policy</h1>
      <p>Last updated: 14 November 2026</p>

      <h2>Who we are</h2>
      <p>
        Vendora is a Shopify app for B2B quotes. It is run by Adhurim Berisha, an individual based in Kosovo
        (&quot;we&quot;). Contact: <a href="mailto:adhurimberisha07@gmail.com">adhurimberisha07@gmail.com</a>.
      </p>

      <h2>Our role</h2>
      <p>
        For the data of a merchant&apos;s staff and store, we provide the service to the merchant. For the
        personal data of the merchant&apos;s customers (their B2B buyers), the merchant is the controller and
        we process it on the merchant&apos;s behalf, only to provide Vendora.
      </p>

      <h2>What we process and why</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Why</th>
            <th>Stored by us?</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Merchant staff: name, email (if verified by Shopify), Shopify user id, language, role, last visit</td>
            <td>Show who created and approved quotes; permissions; staff notification emails</td>
            <td>Yes, while the app is installed</td>
          </tr>
          <tr>
            <td>Store data: products, variants, prices, companies and locations (ids and names)</td>
            <td>Build quotes and draft orders</td>
            <td>Only ids and the product titles, prices and quantities on each quote</td>
          </tr>
          <tr>
            <td>Buyer (company contact): name and email</td>
            <td>Show who the quote is for; Shopify sends the invoice to that email</td>
            <td>No. Read from Shopify when needed; we store only Shopify ids</td>
          </tr>
          <tr>
            <td>Company location: shipping and billing address, including phone</td>
            <td>Put on the draft order</td>
            <td>No. Read from Shopify when the draft order is built</td>
          </tr>
          <tr>
            <td>Quotes: lines, prices, discounts, notes, status, history; what a buyer sends with the &quot;Request a quote&quot; form</td>
            <td>The quoting service itself</td>
            <td>Yes, while the app is installed</td>
          </tr>
          <tr>
            <td>Technical data: request logs, error reports, IP address</td>
            <td>Security, abuse limits and fixing errors</td>
            <td>
              IP addresses are used in memory for rate limiting and not stored. Logs and error reports have
              names, emails, phone numbers, addresses and tokens removed and are kept for at most 90 days
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        We don&apos;t sell personal data, use it for advertising, or combine it with other sources. Our pages
        use no tracking or advertising cookies.
      </p>

      <h2>Legal basis</h2>
      <p>
        We process data to perform our contract with the merchant (providing the app). For buyer data we act
        on the merchant&apos;s instructions.
      </p>

      <h2>Service providers</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Purpose</th>
            <th>Location</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Shopify</td>
            <td>The platform the app runs on; sends draft order invoices</td>
            <td>Per Shopify&apos;s privacy policy</td>
          </tr>
          <tr>
            <td>Render</td>
            <td>Hosting</td>
            <td>Frankfurt, Germany (EU)</td>
          </tr>
          <tr>
            <td>Supabase</td>
            <td>Database</td>
            <td>Frankfurt, Germany (EU)</td>
          </tr>
          <tr>
            <td>Sentry</td>
            <td>Error reports, without personal data</td>
            <td>Germany (EU)</td>
          </tr>
          <tr>
            <td>Resend</td>
            <td>Notification emails to merchant staff</td>
            <td>United States</td>
          </tr>
        </tbody>
      </table>

      <h2>How long we keep data</h2>
      <p>
        While the app is installed. When a merchant uninstalls Vendora, login sessions are deleted at once and
        all of the store&apos;s data is deleted when Shopify asks us to (about 48 hours later), so a quick
        reinstall keeps the quotes. When Shopify tells us a buyer asked to be forgotten, we remove their ids
        from the merchant&apos;s quotes.
      </p>

      <h2>Your rights</h2>
      <p>
        Buyers: ask the merchant you buy from. Shopify passes access and deletion requests to us and we answer
        them through the merchant. Merchants and their staff can export all quotes in Settings, and can
        contact us to access, correct or delete their data.
      </p>

      <h2>Security</h2>
      <p>
        All connections use HTTPS. Access to the production systems is limited to the operator. Personal data
        is removed from logs and error reports. We will tell affected merchants without undue delay if a
        security incident affects their data.
      </p>

      <h2>Changes</h2>
      <p>We update this page when what we process changes, and change the date above.</p>

      <LegalFooter />
    </main>
  );
}
