# Installing Vendora on your store

Vendora is a Shopify app for B2B quotes. Your team builds quotes for your B2B companies, approval rules decide which quotes need a manager, and every approved quote becomes a Shopify draft order whose invoice Shopify emails to the buyer.

Adhurim runs Vendora for you: there is nothing to host or set up outside your Shopify admin. This guide covers installing the app, setting it up, and the first quote.

## Before you start

Your store needs:

- **B2B (companies).** Vendora only makes quotes for B2B companies (Shopify admin → Customers → Companies).
- **At least one company with a main contact and a location.** Quotes are made for a contact at a company location. Open the company in Customers → Companies to add them.
- **Shopify's new customer accounts** (Settings → Customer accounts), only if you want buyers to see their quotes in their account. Everything else works without it.

You also need to be the store owner, or a staff member allowed to install apps.

## Step 1: Install the app

How you install depends on the kind of store.

### A development store (for trying Vendora)

Vendora can be installed on development stores that belong to Adhurim's Shopify organization.

1. Ask Adhurim for a development store with B2B. He creates it in his organization, installs Vendora on it and invites you as staff.
2. Accept the staff invitation in your email and sign in to the store's admin.
3. Open **Apps → Vendora** in the left menu.

A development store you created in your own Shopify Partner account can't install the hosted Vendora. To try it there, run your own copy instead: see **Run your own copy** in the [README](../README.md#run-your-own-copy).

### Your real store

The hosted Vendora is not on the Shopify App Store, so it can't be installed on real (paid) stores.

Your quotes and settings are stored on Adhurim's Vendora server. What is stored and why is in the privacy policy, linked at the bottom of the app's help pages.

## Step 2: The setup

The first time you open Vendora, a short setup guides you through six steps:

1. **Welcome:** what Vendora adds to your store.
2. **Check your store:** B2B, a company, a main contact with a location, and permissions. Anything marked "Needs fixing" tells you what to change. Fix it in Shopify, then press **Check again**.
3. **Approval rules:** the largest quote total and discount a quote can have without a manager's approval.
4. **Your team:** what each role can do.
5. **Test the connection:** Vendora creates a test draft order, reads it back and deletes it. Nothing is sent to anyone.
6. **Create your first quote.**

You can skip the setup and change everything later in **Settings**.

**Using Vendora on your own?** Go to **Settings → Approval rules** and turn off **"The approver must be a different person than the requester"**. Otherwise, quotes above your limits wait for an approval nobody can give.

The first time Vendora opens after a quiet period it can take up to a minute to load. After that it's quick.

## Step 3: Add your team

Each staff member appears in Vendora the first time they open it from **Apps → Vendora**, as a **sales rep**. The owner changes roles in **Settings → Team**:

| Role | Can |
|---|---|
| Owner | everything, including settings and the team |
| Manager | create, approve and send quotes, and fix problems |
| Sales rep | create and send quotes; quotes above the limits need approval |
| Viewer | look at quotes, nothing else |

## Step 4: Let buyers see their quotes (optional)

**A Quotes page in your customers' accounts.** There, buyers accept a quote (which takes them to checkout), decline it, or ask for changes.

1. Shopify admin → **Settings → Checkout → Customize** (the checkout and accounts editor).
2. Open the **Apps** sidebar and add Vendora's **Quotes** page.
3. When Shopify asks, add the page to the customer account menu, then **Save**.

**A "Request a quote" button on the cart page.** Logged-in B2B buyers send their cart to you as a quote request.

1. Shopify admin → **Online Store → Themes → Customize**, then open the cart page.
2. **Add block → Apps → Request a quote**, then **Save**.

Requests arrive in Vendora as draft quotes. Check the prices, then submit them like any other quote.

## Using Vendora

1. **Quotes → New quote:** pick the company location, press **Add products**, then adjust quantities, prices or discounts and press **Save lines**.
2. **Submit:** within your approval rules the quote is approved at once. Otherwise a manager approves or rejects it on the quote page.
3. **Send:** Vendora creates the draft order in Shopify, and Shopify emails the invoice to the company's main contact.
4. The buyer pays, or accepts in their account, and the quote changes to **Ordered**.

Need to change a submitted quote? Use **Revise (new version)**. Every version keeps its own PDF.

Vendora doesn't send its own emails yet (approval requests, expiry reminders). Check the **Dashboard** for quotes waiting for approval or about to expire. Shopify's invoice email to buyers works as usual.

## Help and support

- In Vendora, open **Help** in the menu: it links to step-by-step help for every part of the app, including what each warning means.
- **Help → Contact support** opens an email to Adhurim with your store's details already filled in. Add the quote number and what you expected to happen. Never send passwords or payment details.

## Removing Vendora

Shopify admin → **Settings → Apps** → Vendora → **Uninstall**. Before you do, you can download all quotes with **Settings → Export all quotes**. Draft orders that Vendora created stay in Shopify.
