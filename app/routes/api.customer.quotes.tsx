import type { LoaderFunctionArgs } from "react-router";
import { authenticateCustomer, listCustomerQuotes } from "../models/customer-quotes.server";

// GET: the logged-in buyer's quotes for the customer account "Quotes" page (M3.4).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { actor, companyIds, cors } = await authenticateCustomer(request);
  return cors(Response.json(await listCustomerQuotes(actor.shop, companyIds)));
};

// The CORS preflight (OPTIONS) is routed to the action; authenticateCustomer answers it.
export const action = loader;
