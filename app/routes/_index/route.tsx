import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, Form, useActionData, useLoaderData } from "react-router";

import LegalFooter from "../../components/LegalFooter";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

import styles from "./styles.module.css";

// Public landing page (B-20). Also the shop login form for opening the app outside the Shopify admin.
export const meta: MetaFunction = () => [
  { title: "Vendora: B2B quotes for Shopify" },
  {
    name: "description",
    content: "Build B2B quotes for your Shopify companies, get them approved, and turn them into draft orders.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData?.errors;

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Vendora</h1>
        <p className={styles.text}>
          B2B quotes for Shopify: price a quote for a company, get it approved, and send it as a draft order.
        </p>
        {showForm && (
          <Form className={styles.form} method="post">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>{errors?.shop ?? "e.g: my-shop-domain.myshopify.com"}</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Quotes with your B2B prices</strong>. Lines start from each company location&apos;s
            catalog price; adjust prices, discounts and quantities per line.
          </li>
          <li>
            <strong>Approvals</strong>. Rules by discount or total send quotes to a manager before they
            go out.
          </li>
          <li>
            <strong>Draft orders and invoices</strong>. An approved quote becomes a Shopify draft order
            with the agreed prices, and the buyer gets Shopify&apos;s invoice with a link to the quote and its PDF.
          </li>
        </ul>
        <LegalFooter />
      </div>
    </div>
  );
}
