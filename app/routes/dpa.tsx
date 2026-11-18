import type { MetaFunction } from "react-router";
import LegalFooter from "../components/LegalFooter";
import styles from "../components/legal.module.css";

// Data processing agreement (13 §3.3), part of the terms. Keep the providers in step with /privacy.
export const meta: MetaFunction = () => [{ title: "Data processing agreement · Vendora" }];

export default function Dpa() {
  return (
    <main className={styles.legal}>
      <h1>Data processing agreement</h1>
      <p>Last updated: 18 November 2026</p>

      <p>
        This agreement is part of the <a href="/terms">terms of service</a> between the merchant who installs
        Vendora (&quot;you&quot;) and Adhurim Berisha, who runs Vendora (&quot;we&quot;). It applies when we
        process personal data of your customers for you, and meets Article 28 of the EU General Data
        Protection Regulation (GDPR). By installing Vendora you accept it; no signature is needed.
      </p>

      <h2>1. Roles</h2>
      <p>
        You are the controller of your customers&apos; personal data. We are your processor and handle it only
        to provide Vendora.
      </p>

      <h2>2. What we process</h2>
      <ul>
        <li>
          <strong>People:</strong> contacts of your B2B companies (buyers) and anyone who sends the
          &quot;Request a quote&quot; form.
        </li>
        <li>
          <strong>Data:</strong> name, email, company location address and phone, Shopify ids, and what a buyer
          writes in a quote request or reply.
        </li>
        <li>
          <strong>Purpose:</strong> creating, approving and sending quotes and turning them into Shopify draft
          orders, as described in our <a href="/privacy">privacy policy</a>.
        </li>
        <li>
          <strong>Duration:</strong> while Vendora is installed; see section 8.
        </li>
      </ul>

      <h2>3. Your instructions</h2>
      <p>
        We process the data only on your documented instructions: these terms and the way you use Vendora. If
        we think an instruction breaks data protection law, we tell you. If the law requires us to process data
        in another way, we tell you first unless the law forbids it.
      </p>

      <h2>4. Confidentiality and security</h2>
      <p>
        Only the operator of Vendora can access production systems, and is bound to keep the data
        confidential. We protect the data with these measures:
      </p>
      <ul>
        <li>HTTPS for every connection; data at rest encrypted by our hosting and database providers.</li>
        <li>Buyer names, emails and addresses are read from Shopify when needed and not stored by us.</li>
        <li>Personal data is removed from logs and error reports.</li>
        <li>Weekly encrypted backups; the key is kept offline; restores are tested.</li>
        <li>Separate test and production systems; production data is never copied to test.</li>
        <li>Two-factor login and strong, unique passwords on every account with access.</li>
        <li>An audit log of quote actions and data exports.</li>
      </ul>

      <h2>5. Subprocessors</h2>
      <p>You allow us to use these providers. We tell you in the app at least 30 days before adding one:</p>
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
            <td>GitHub</td>
            <td>Encrypted backups (unreadable without our offline key)</td>
            <td>United States</td>
          </tr>
          <tr>
            <td>Sentry</td>
            <td>Error reports, without personal data</td>
            <td>Germany (EU)</td>
          </tr>
          <tr>
            <td>Google (Gmail)</td>
            <td>Notification emails to your staff (not to buyers)</td>
            <td>United States</td>
          </tr>
        </tbody>
      </table>
      <p>
        We put data protection terms with the same duties in place with each provider and remain responsible
        for them. You may object to a new provider by uninstalling Vendora before the change.
      </p>

      <h2>6. Transfers outside the EU</h2>
      <p>
        Your data is stored in the EU. Where a provider outside the EU or the European Economic Area handles it,
        the transfer is covered by the European Commission&apos;s Standard Contractual Clauses or another
        lawful mechanism.
      </p>

      <h2>7. Helping you</h2>
      <ul>
        <li>
          <strong>Requests from people:</strong> Shopify passes access and deletion requests to us and we answer
          them through you; you can also export all quotes in Settings.
        </li>
        <li>
          <strong>Incidents:</strong> we tell you without undue delay, and at the latest within 48 hours, after
          we learn of a breach affecting your customers&apos; data, with what we know and what we are doing.
        </li>
        <li>
          <strong>Assessments:</strong> we give you the information you reasonably need for a data protection
          impact assessment or a question from a regulator.
        </li>
      </ul>

      <h2>8. End of processing</h2>
      <p>
        When you uninstall Vendora, all of your store&apos;s data is deleted when Shopify asks us to, about 48
        hours later. Encrypted backups expire within 90 days.
      </p>

      <h2>9. Audits</h2>
      <p>
        We make available the information needed to show we meet this agreement and answer your written
        questions about it. If that is not enough, you may audit us with 30 days&apos; notice, at your cost,
        without access to other merchants&apos; data.
      </p>

      <h2>10. Contact</h2>
      <p>
        <a href="mailto:adhurimberisha07@gmail.com">adhurimberisha07@gmail.com</a>
      </p>

      <LegalFooter />
    </main>
  );
}
