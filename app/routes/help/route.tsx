import type { ReactNode } from "react";
import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import LegalFooter from "../../components/LegalFooter";
import styles from "./styles.module.css";

// Public help center (M6.4, G-8). The app links to its sections by id (app.help.tsx, quote page, import
// page): keep the ids stable. Texts follow app/locales/en.json: when a label changes there, change it here.
export const meta: MetaFunction = () => [{ title: "Help · Vendora" }];

const SUPPORT_EMAIL = "adhurimberisha07@gmail.com";

const TOPICS = [
  { id: "getting-started", title: "Getting started", summary: "What you need, the setup and your team." },
  { id: "quotes", title: "Creating a quote", summary: "Products, prices, discounts and versions." },
  { id: "csv", title: "Importing a CSV file", summary: "Add hundreds of lines at once." },
  { id: "approvals", title: "Approvals", summary: "Which quotes wait for a manager." },
  { id: "sending", title: "Sending and acceptance", summary: "Draft orders, invoices and orders." },
  { id: "customer-accounts", title: "Customer account page", summary: "Let buyers accept quotes themselves." },
  { id: "quote-requests", title: "Quote requests", summary: "Buyers ask for a quote from your store." },
  { id: "troubleshooting", title: "Troubleshooting", summary: "What each warning means and how to fix it." },
  { id: "privacy", title: "Privacy and data", summary: "What Vendora stores and how to export it." },
] as const;

// A button or menu name in the app.
const Ui = ({ children }: { children: ReactNode }) => <span className={styles.ui}>{children}</span>;

const Section = ({ id, children }: { id: (typeof TOPICS)[number]["id"] | "support"; children: ReactNode }) => (
  <section id={id} className={id === "support" ? `${styles.section} ${styles.support}` : styles.section}>
    {children}
  </section>
);

export default function Help() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <Link to="/" className={styles.brand}>
            Vendora
          </Link>
          <h1>How can we help?</h1>
          <p>Vendora turns B2B quotes into Shopify draft orders. Pick a topic, or contact us at the bottom of the page.</p>
        </div>
      </header>

      <nav className={styles.topics} aria-label="Help topics">
        {TOPICS.map((topic, index) => (
          <a key={topic.id} href={`#${topic.id}`} className={styles.card}>
            <span className={styles.cardNumber}>{index + 1}</span>
            <strong>{topic.title}</strong>
            <span>{topic.summary}</span>
          </a>
        ))}
      </nav>

      <div className={styles.layout}>
        <aside className={styles.toc} aria-label="On this page">
          <p>On this page</p>
          <ul>
            {TOPICS.map((topic) => (
              <li key={topic.id}>
                <a href={`#${topic.id}`}>{topic.title}</a>
              </li>
            ))}
            <li>
              <a href="#support">Contact support</a>
            </li>
          </ul>
        </aside>

        <main className={styles.content}>
          <Section id="getting-started">
            <h2>Getting started</h2>
            <p>You need:</p>
            <ul>
              <li>A Shopify plan with B2B (companies).</li>
              <li>
                At least one company with a <strong>main contact</strong> and a <strong>location</strong> (Shopify admin
                → Customers → Companies). Quotes are made for a contact at a location.
              </li>
            </ul>
            <p>
              The first time you open Vendora, a short setup checks your store, sets your approval rules and creates a
              test draft order. The test order is deleted right away and nothing is sent. You can skip the setup and
              change everything later in <Ui>Settings</Ui>. Vendora is free.
            </p>
            <h3>Your team</h3>
            <p>
              Staff appear in Vendora the first time they open the app, as sales reps. Owners change roles in{" "}
              <Ui>Settings → Team</Ui>.
            </p>
            <div className={styles.roles}>
              <div>
                <strong>Owner</strong>
                <span>Everything, including settings and the team.</span>
              </div>
              <div>
                <strong>Manager</strong>
                <span>Creates, approves and sends quotes, and fixes problems.</span>
              </div>
              <div>
                <strong>Sales rep</strong>
                <span>Creates and sends quotes. Quotes above the limits need approval.</span>
              </div>
              <div>
                <strong>Viewer</strong>
                <span>Can look at quotes, nothing else.</span>
              </div>
            </div>
          </Section>

          <Section id="quotes">
            <h2>Creating a quote</h2>
            <ol className={styles.steps}>
              <li>
                Go to <Ui>Quotes</Ui> → <Ui>New quote</Ui>, choose the company location and press <Ui>Create quote</Ui>.
              </li>
              <li>
                Press <Ui>Add products</Ui>. Each line starts at the company&apos;s catalog price. Change the quantity,
                or set <Ui>Your price</Ui> or a <Ui>Discount</Ui> % on a line. A quote discount applies to the whole
                quote.
              </li>
              <li>
                Press <Ui>Save lines</Ui>. The totals update when you save.
              </li>
              <li>
                Press <Ui>Submit</Ui>. Within your approval rules the quote is approved at once. Otherwise it waits for
                a manager (see <a href="#approvals">Approvals</a>).
              </li>
            </ol>
            <div className={styles.tip}>
              <strong>Versions</strong>A submitted version is locked. To change it, use <Ui>Revise (new version)</Ui>.
              Vendora keeps every version with its own PDF and shows what changed.
            </div>
            <p>
              A quote expires at the end of its expiry date, in your store&apos;s time zone. The default is 30 days:
              change it on the quote or in <Ui>Settings → General</Ui>. <Ui>Settings → Branding</Ui> sets the logo,
              terms and footer of the quote PDFs.
            </p>
          </Section>

          <Section id="csv">
            <h2>Importing a CSV file</h2>
            <p>
              On a quote, <Ui>Import CSV</Ui> adds many lines at once. <Ui>Download template</Ui> gives you a ready file.
            </p>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Required</th>
                    <th>Example</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>sku</code></td>
                    <td>Yes</td>
                    <td>SNOW-HYD-01</td>
                  </tr>
                  <tr>
                    <td><code>quantity</code></td>
                    <td>Yes</td>
                    <td>25 (whole number, 1 to 100,000)</td>
                  </tr>
                  <tr>
                    <td><code>price</code></td>
                    <td>No</td>
                    <td>499.00 (your price per unit)</td>
                  </tr>
                  <tr>
                    <td><code>discount</code></td>
                    <td>No</td>
                    <td>10 (percent, 0 to 100)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ol className={styles.steps}>
              <li>Choose the file. Comma or semicolon separated, up to 10,000 rows and 5 MB.</li>
              <li>
                Press <Ui>Check file</Ui>. Every row is shown as OK, warning or error before anything is added. Download
                the report to fix errors in your spreadsheet.
              </li>
              <li>Choose to add the lines to the existing ones, or to replace all lines.</li>
            </ol>
            <div className={styles.tip}>
              <strong>Good to know</strong>Repeated SKUs are merged and their quantities added. Repeated SKUs with
              different prices are an error. You can only import into an editable version: revise a submitted quote
              first.
            </div>
          </Section>

          <Section id="approvals">
            <h2>Approvals</h2>
            <p>
              <Ui>Settings → Approval rules</Ui> decides which submitted quotes need a manager. A quote needs approval
              when it breaks any rule:
            </p>
            <ul>
              <li>Its discount, compared with the catalog total, is above the maximum discount.</li>
              <li>Its total is above the maximum for its currency. A currency without a limit always needs approval.</li>
              <li>
                <Ui>Always require approval</Ui> is on.
              </li>
            </ul>
            <p>
              Managers and owners approve or reject on the quote page. Rejecting needs a comment and sends the quote back
              to draft.
            </p>
            <div className={styles.warn}>
              <strong>Using Vendora alone?</strong>With{" "}
              <Ui>The approver must be a different person than the requester</Ui> on, nobody can approve their own
              quote. Turn it off, or your quotes above the limits stay in Pending approval.
            </div>
          </Section>

          <Section id="sending">
            <h2>Sending and customer acceptance</h2>
            <ol className={styles.steps}>
              <li>
                On an approved quote, add an optional message under <Ui>Send to the customer</Ui> and press{" "}
                <Ui>Send</Ui>.
              </li>
              <li>
                Vendora creates (or updates) the draft order in Shopify, then Shopify emails the invoice to the
                company&apos;s main contact. The quote changes to <strong>Sent</strong>.
              </li>
              <li>
                The buyer pays through Shopify&apos;s checkout and the quote changes to <strong>Ordered</strong>.
              </li>
            </ol>
            <ul>
              <li>
                The draft order follows the quote: a new approved version updates it. Don&apos;t edit it in Shopify. If
                you do, Vendora asks which version to keep.
              </li>
              <li>
                <Ui>Reserve stock while a quote is open</Ui> (in <Ui>Settings → General</Ui>) makes draft orders hold the
                items until the quote expires.
              </li>
            </ul>
            <div className={styles.warn}>
              <strong>Expired or cancelled quotes</strong>Their draft order is deleted, so the invoice link stops
              working.
            </div>
          </Section>

          <Section id="customer-accounts">
            <h2>Customer account page</h2>
            <p>
              Vendora adds a <strong>Quotes</strong> page to your customer accounts. There, B2B buyers see their
              company&apos;s quotes and can accept (go to checkout), decline, or ask for changes. It needs Shopify&apos;s
              customer accounts, not the legacy ones.
            </p>
            <ol className={styles.steps}>
              <li>
                In Shopify admin, open <Ui>Settings → Checkout</Ui> and press <Ui>Customize</Ui> (the checkout and
                accounts editor).
              </li>
              <li>
                Open the <Ui>Apps</Ui> sidebar and add Vendora&apos;s <strong>Quotes</strong> page.
              </li>
              <li>When asked, add it to the customer account menu, then save.</li>
            </ol>
            <div className={styles.tip}>
              <strong>When a buyer answers</strong>If a buyer declines or asks for changes, the sales rep gets an email
              and the quote shows it under &quot;This quote needs attention&quot;. Answer a change request with{" "}
              <Ui>Start a new version</Ui>.
            </div>
          </Section>

          <Section id="quote-requests">
            <h2>Quote requests from the store</h2>
            <h3>Request a quote button</h3>
            <ol className={styles.steps}>
              <li>
                Open <Ui>Online Store → Themes → Customize</Ui> and go to the cart page.
              </li>
              <li>
                Add the app block <Ui>Request a quote</Ui>. In its settings you can change the button text and hide the
                message field.
              </li>
            </ol>
            <p>
              Logged-in B2B buyers send their cart, with an optional message. It becomes a draft quote with no one
              assigned, and managers get an email.
            </p>
            <h3>Company draft orders</h3>
            <p>
              With <Ui>Turn company draft orders into quotes</Ui> on (in <Ui>Settings → General</Ui>), B2B checkouts
              submitted for review and draft orders you make for a company in the Shopify admin become draft quotes.
            </p>
            <div className={styles.tip}>
              <strong>Next step</strong>Check the prices of a request, then submit it like any other quote.
            </div>
          </Section>

          <Section id="troubleshooting">
            <h2>Troubleshooting</h2>
            <p>
              When something needs a person, the quote shows <strong>This quote needs attention</strong> with buttons
              to fix it. The Dashboard lists these quotes under Needs attention.
            </p>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Message</th>
                    <th>What it means</th>
                    <th>What to do</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Shopify rejected the draft order</td>
                    <td>Shopify refused the draft order, for example because of a product or an address.</td>
                    <td>Read the message, fix the cause, then <Ui>Retry</Ui>.</td>
                  </tr>
                  <tr>
                    <td>We couldn&apos;t reach Shopify after several tries</td>
                    <td>Shopify was unavailable for a while.</td>
                    <td><Ui>Retry</Ui></td>
                  </tr>
                  <tr>
                    <td>Another draft order carries this quote&apos;s tag</td>
                    <td>A draft order with this quote&apos;s tag exists for another company.</td>
                    <td><Ui>Create a new draft order</Ui></td>
                  </tr>
                  <tr>
                    <td>The draft order was deleted in Shopify</td>
                    <td>Someone deleted it in the Shopify admin.</td>
                    <td><Ui>Recreate the draft order</Ui> or <Ui>Cancel quote</Ui></td>
                  </tr>
                  <tr>
                    <td>The draft order was edited in Shopify</td>
                    <td>The draft order no longer matches the quote.</td>
                    <td>
                      <Ui>Overwrite with the quote</Ui>, or <Ui>Keep Shopify&apos;s version</Ui> (becomes a new quote
                      version)
                    </td>
                  </tr>
                  <tr>
                    <td>A product was deleted / isn&apos;t active any more</td>
                    <td>A quoted product changed in Shopify.</td>
                    <td><Ui>Edit quote</Ui>, then replace or remove the line.</td>
                  </tr>
                  <tr>
                    <td>Shopify&apos;s subtotal differs from the quote</td>
                    <td>Prices changed in Shopify, so Vendora didn&apos;t send an invoice the approver didn&apos;t see.</td>
                    <td>Check the draft order, revise the quote if needed, then <Ui>Dismiss</Ui>.</td>
                  </tr>
                  <tr>
                    <td>The invoice couldn&apos;t be sent</td>
                    <td>Shopify didn&apos;t send the invoice email.</td>
                    <td>Check the contact&apos;s email address, then <Ui>Send again</Ui>.</td>
                  </tr>
                  <tr>
                    <td>Stock is now lower than the quoted quantity</td>
                    <td>The nightly check found less stock than quoted.</td>
                    <td><Ui>Start a new version</Ui> with less, or <Ui>Dismiss</Ui>.</td>
                  </tr>
                  <tr>
                    <td>An order was placed for a quote that was already closed</td>
                    <td>The buyer paid an old invoice link.</td>
                    <td>Check the order in Shopify, then <Ui>Dismiss</Ui>.</td>
                  </tr>
                  <tr>
                    <td>The buyer asked for changes</td>
                    <td>The buyer sent a change request from their account.</td>
                    <td><Ui>Start a new version</Ui></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3>Other common questions</h3>
            <ul>
              <li>
                <strong>A quote stays in Pending approval.</strong> Someone other than the requester must approve it, or
                turn off &quot;different approver&quot; (see <a href="#approvals">Approvals</a>).
              </li>
              <li>
                <strong>A company is missing from New quote, or says &quot;No main contact&quot;.</strong> Give it a
                main contact and a location in Shopify admin → Customers → Companies.
              </li>
              <li>
                <strong>&quot;Shopify is responding slowly&quot; or &quot;Emails are delayed&quot;.</strong> Nothing is
                lost: the work is queued and retried automatically.
              </li>
              <li>
                <strong>Failed background work.</strong> Owners and managers see it on the <Ui>Jobs</Ui> page and can
                retry it there.
              </li>
              <li>
                <strong>I don&apos;t get emails.</strong> <Ui>Settings → Notifications</Ui> shows the address and which
                emails you get. Shopify must have a verified email address for you.
              </li>
            </ul>
          </Section>

          <Section id="privacy">
            <h2>Privacy and data</h2>
            <p>
              Vendora reads companies, contacts and products from Shopify to build quotes. It stores the quotes, their
              history and your settings. The details are in the <a href="/privacy">privacy policy</a> and the{" "}
              <a href="/dpa">data processing agreement</a>.
            </p>
            <p>
              <Ui>Settings → Export all quotes</Ui> downloads every quote with its lines as a CSV file. When you
              uninstall Vendora, your data is deleted as described in the privacy policy.
            </p>
          </Section>

          <Section id="support">
            <h2>Still stuck? Contact support</h2>
            <p>
              We answer within one business day. The quickest way is <Ui>Help → Contact support</Ui> inside Vendora: it
              fills in your store and app version. Add the quote number and what you expected to happen. Never send
              passwords or payment details.
            </p>
            <a className={styles.supportButton} href={`mailto:${SUPPORT_EMAIL}`}>
              Email {SUPPORT_EMAIL}
            </a>
          </Section>
        </main>
      </div>
      <div className={styles.footer}>
        <LegalFooter />
      </div>
    </div>
  );
}
