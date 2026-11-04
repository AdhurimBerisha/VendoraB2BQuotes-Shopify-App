/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.d.ts';

export type VendoraCompanyLocationQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraCompanyLocationQuery = { companyLocation?: AdminTypes.Maybe<(
    Pick<AdminTypes.CompanyLocation, 'id' | 'name' | 'currency'>
    & { company: (
      Pick<AdminTypes.Company, 'id' | 'name'>
      & { mainContact?: AdminTypes.Maybe<(
        Pick<AdminTypes.CompanyContact, 'id'>
        & { customer: Pick<AdminTypes.Customer, 'id'> }
      )> }
    ), shippingAddress?: AdminTypes.Maybe<Pick<AdminTypes.CompanyAddress, 'address1' | 'address2' | 'city' | 'zip' | 'countryCode' | 'zoneCode' | 'companyName' | 'phone' | 'recipient'>>, billingAddress?: AdminTypes.Maybe<Pick<AdminTypes.CompanyAddress, 'address1' | 'address2' | 'city' | 'zip' | 'countryCode' | 'zoneCode' | 'companyName' | 'phone' | 'recipient'>> }
  )> };

export type VendoraCompanySearchQueryVariables = AdminTypes.Exact<{
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type VendoraCompanySearchQuery = { companies: { nodes: Array<(
      Pick<AdminTypes.Company, 'id' | 'name'>
      & { mainContact?: AdminTypes.Maybe<Pick<AdminTypes.CompanyContact, 'id'>>, locations: { nodes: Array<Pick<AdminTypes.CompanyLocation, 'id' | 'name' | 'currency'>> } }
    )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type VendoraContactQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraContactQuery = { companyContact?: AdminTypes.Maybe<(
    Pick<AdminTypes.CompanyContact, 'id'>
    & { customer: (
      Pick<AdminTypes.Customer, 'id' | 'displayName'>
      & { defaultEmailAddress?: AdminTypes.Maybe<Pick<AdminTypes.CustomerEmailAddress, 'emailAddress'>> }
    ) }
  )> };

export type VendoraCompanyNamesQueryVariables = AdminTypes.Exact<{
  ids: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraCompanyNamesQuery = { nodes: Array<AdminTypes.Maybe<Pick<AdminTypes.Company, 'id' | 'name'>>> };

export type VendoraCustomerCompaniesQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraCustomerCompaniesQuery = { customer?: AdminTypes.Maybe<{ companyContactProfiles: Array<(
      Pick<AdminTypes.CompanyContact, 'id'>
      & { company: Pick<AdminTypes.Company, 'id'> }
    )> }> };

export type VendoraBuyerLocationsQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraBuyerLocationsQuery = { customer?: AdminTypes.Maybe<{ companyContactProfiles: Array<(
      Pick<AdminTypes.CompanyContact, 'id'>
      & { roleAssignments: { nodes: Array<{ companyLocation: Pick<AdminTypes.CompanyLocation, 'id'> }> } }
    )> }> };

export type VendoraDraftOrderCreateMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.DraftOrderInput;
}>;


export type VendoraDraftOrderCreateMutation = { draftOrderCreate?: AdminTypes.Maybe<{ draftOrder?: AdminTypes.Maybe<Pick<AdminTypes.DraftOrder, 'id' | 'name' | 'updatedAt'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type VendoraDraftOrderUpdateMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  input: AdminTypes.DraftOrderInput;
}>;


export type VendoraDraftOrderUpdateMutation = { draftOrderUpdate?: AdminTypes.Maybe<{ draftOrder?: AdminTypes.Maybe<Pick<AdminTypes.DraftOrder, 'id' | 'name' | 'updatedAt'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type VendoraDraftOrderDeleteMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.DraftOrderDeleteInput;
}>;


export type VendoraDraftOrderDeleteMutation = { draftOrderDelete?: AdminTypes.Maybe<(
    Pick<AdminTypes.DraftOrderDeletePayload, 'deletedId'>
    & { userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }
  )> };

export type VendoraDraftOrderByTagQueryVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type VendoraDraftOrderByTagQuery = { draftOrders: { nodes: Array<(
      Pick<AdminTypes.DraftOrder, 'id' | 'status'>
      & { purchasingEntity?: AdminTypes.Maybe<{ company: Pick<AdminTypes.Company, 'id'>, location: Pick<AdminTypes.CompanyLocation, 'id'> }> }
    )> } };

export type VendoraDraftOrderQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraDraftOrderQuery = { draftOrder?: AdminTypes.Maybe<(
    Pick<AdminTypes.DraftOrder, 'id' | 'status' | 'updatedAt' | 'invoiceSentAt' | 'invoiceUrl'>
    & { subtotalPriceSet: { presentmentMoney: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> } }
  )> };

export type VendoraSubmittedDraftQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraSubmittedDraftQuery = { draftOrder?: AdminTypes.Maybe<(
    Pick<AdminTypes.DraftOrder, 'id' | 'tags'>
    & { lineItems: { nodes: Array<(
        Pick<AdminTypes.DraftOrderLineItem, 'quantity'>
        & { variant?: AdminTypes.Maybe<Pick<AdminTypes.ProductVariant, 'id'>> }
      )> }, purchasingEntity?: AdminTypes.Maybe<{ company: Pick<AdminTypes.Company, 'id'>, location: Pick<AdminTypes.CompanyLocation, 'id'>, contact?: AdminTypes.Maybe<(
        Pick<AdminTypes.CompanyContact, 'id'>
        & { customer: Pick<AdminTypes.Customer, 'id'> }
      )> }> }
  )> };

export type VendoraTagsAddMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  tags: Array<AdminTypes.Scalars['String']['input']> | AdminTypes.Scalars['String']['input'];
}>;


export type VendoraTagsAddMutation = { tagsAdd?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type VendoraTagsRemoveMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  tags: Array<AdminTypes.Scalars['String']['input']> | AdminTypes.Scalars['String']['input'];
}>;


export type VendoraTagsRemoveMutation = { tagsRemove?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type VendoraReconcileDraftQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraReconcileDraftQuery = { draftOrder?: AdminTypes.Maybe<(
    Pick<AdminTypes.DraftOrder, 'id' | 'status' | 'updatedAt'>
    & { order?: AdminTypes.Maybe<Pick<AdminTypes.Order, 'id'>>, lineItems: { nodes: Array<(
        Pick<AdminTypes.DraftOrderLineItem, 'quantity'>
        & { variant?: AdminTypes.Maybe<Pick<AdminTypes.ProductVariant, 'id'>> }
      )> } }
  )> };

export type VendoraDraftOrderSummaryQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraDraftOrderSummaryQuery = { draftOrder?: AdminTypes.Maybe<(
    Pick<AdminTypes.DraftOrder, 'id' | 'status' | 'invoiceSentAt' | 'invoiceUrl'>
    & { subtotalPriceSet: { presentmentMoney: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> }, totalTaxSet: { presentmentMoney: Pick<AdminTypes.MoneyV2, 'amount'> }, totalPriceSet: { presentmentMoney: Pick<AdminTypes.MoneyV2, 'amount'> }, order?: AdminTypes.Maybe<Pick<AdminTypes.Order, 'id' | 'name'>> }
  )> };

export type VendoraInvoiceSendMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  email?: AdminTypes.InputMaybe<AdminTypes.EmailInput>;
}>;


export type VendoraInvoiceSendMutation = { draftOrderInvoiceSend?: AdminTypes.Maybe<{ draftOrder?: AdminTypes.Maybe<Pick<AdminTypes.DraftOrder, 'id' | 'invoiceSentAt' | 'invoiceUrl'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type VendoraLocationCountryQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraLocationCountryQuery = { companyLocation?: AdminTypes.Maybe<{ shippingAddress?: AdminTypes.Maybe<Pick<AdminTypes.CompanyAddress, 'countryCode'>>, billingAddress?: AdminTypes.Maybe<Pick<AdminTypes.CompanyAddress, 'countryCode'>> }> };

export type VendoraVariantPricesQueryVariables = AdminTypes.Exact<{
  ids: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
  companyLocationId: AdminTypes.Scalars['ID']['input'];
  country?: AdminTypes.InputMaybe<AdminTypes.CountryCode>;
}>;


export type VendoraVariantPricesQuery = { nodes: Array<AdminTypes.Maybe<(
    Pick<AdminTypes.ProductVariant, 'id' | 'sku' | 'title' | 'inventoryQuantity'>
    & { inventoryItem: Pick<AdminTypes.InventoryItem, 'tracked'>, product: Pick<AdminTypes.Product, 'id' | 'title' | 'status' | 'isGiftCard'>, contextualPricing: { price: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>, quantityRule: Pick<AdminTypes.QuantityRule, 'minimum' | 'maximum' | 'increment'>, quantityPriceBreaks: { nodes: Array<(
          Pick<AdminTypes.QuantityPriceBreak, 'minimumQuantity'>
          & { price: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> }
        )> } } }
  )>> };

export type VendoraVariantsBySkuQueryVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type VendoraVariantsBySkuQuery = { productVariants: { nodes: Array<Pick<AdminTypes.ProductVariant, 'id' | 'sku'>> } };

export type VendoraShopInfoQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type VendoraShopInfoQuery = { shop: Pick<AdminTypes.Shop, 'id' | 'name' | 'ianaTimezone' | 'currencyCode'> };

interface GeneratedQueryTypes {
  "#graphql\n      query VendoraCompanyLocation($id: ID!) {\n        companyLocation(id: $id) {\n          id name currency\n          company { id name mainContact { id customer { id } } }\n          shippingAddress { address1 address2 city zip countryCode zoneCode companyName phone recipient }\n          billingAddress { address1 address2 city zip countryCode zoneCode companyName phone recipient }\n        }\n      }": {return: VendoraCompanyLocationQuery, variables: VendoraCompanyLocationQueryVariables},
  "#graphql\n      query VendoraCompanySearch($query: String, $after: String) {\n        companies(first: 20, after: $after, query: $query, sortKey: NAME) {\n          nodes { id name mainContact { id } locations(first: 50) { nodes { id name currency } } }\n          pageInfo { hasNextPage endCursor }\n        }\n      }": {return: VendoraCompanySearchQuery, variables: VendoraCompanySearchQueryVariables},
  "#graphql\n      query VendoraContact($id: ID!) {\n        companyContact(id: $id) { id customer { id displayName defaultEmailAddress { emailAddress } } }\n      }": {return: VendoraContactQuery, variables: VendoraContactQueryVariables},
  "#graphql\n      query VendoraCompanyNames($ids: [ID!]!) {\n        nodes(ids: $ids) { ... on Company { id name } }\n      }": {return: VendoraCompanyNamesQuery, variables: VendoraCompanyNamesQueryVariables},
  "#graphql\n      query VendoraCustomerCompanies($id: ID!) {\n        customer(id: $id) { companyContactProfiles { id company { id } } }\n      }": {return: VendoraCustomerCompaniesQuery, variables: VendoraCustomerCompaniesQueryVariables},
  "#graphql\n      query VendoraBuyerLocations($id: ID!) {\n        customer(id: $id) {\n          companyContactProfiles { id roleAssignments(first: 100) { nodes { companyLocation { id } } } }\n        }\n      }": {return: VendoraBuyerLocationsQuery, variables: VendoraBuyerLocationsQueryVariables},
  "#graphql\n      query VendoraDraftOrderByTag($query: String!) {\n        draftOrders(first: 5, query: $query) {\n          nodes { id status purchasingEntity { ... on PurchasingCompany { company { id } location { id } } } }\n        }\n      }": {return: VendoraDraftOrderByTagQuery, variables: VendoraDraftOrderByTagQueryVariables},
  "#graphql\n      query VendoraDraftOrder($id: ID!) {\n        draftOrder(id: $id) {\n          id status updatedAt invoiceSentAt invoiceUrl\n          subtotalPriceSet { presentmentMoney { amount currencyCode } }\n        }\n      }": {return: VendoraDraftOrderQuery, variables: VendoraDraftOrderQueryVariables},
  "#graphql\n      query VendoraSubmittedDraft($id: ID!) {\n        draftOrder(id: $id) {\n          id tags\n          lineItems(first: 250) { nodes { quantity variant { id } } }\n          purchasingEntity { ... on PurchasingCompany { company { id } location { id } contact { id customer { id } } } }\n        }\n      }": {return: VendoraSubmittedDraftQuery, variables: VendoraSubmittedDraftQueryVariables},
  "#graphql\n      query VendoraReconcileDraft($id: ID!) {\n        draftOrder(id: $id) {\n          id status updatedAt\n          order { id }\n          lineItems(first: 250) { nodes { quantity variant { id } } }\n        }\n      }": {return: VendoraReconcileDraftQuery, variables: VendoraReconcileDraftQueryVariables},
  "#graphql\n      query VendoraDraftOrderSummary($id: ID!) {\n        draftOrder(id: $id) {\n          id status invoiceSentAt invoiceUrl\n          subtotalPriceSet { presentmentMoney { amount currencyCode } }\n          totalTaxSet { presentmentMoney { amount } }\n          totalPriceSet { presentmentMoney { amount } }\n          order { id name }\n        }\n      }": {return: VendoraDraftOrderSummaryQuery, variables: VendoraDraftOrderSummaryQueryVariables},
  "#graphql\n      query VendoraLocationCountry($id: ID!) {\n        companyLocation(id: $id) {\n          shippingAddress { countryCode }\n          billingAddress { countryCode }\n        }\n      }": {return: VendoraLocationCountryQuery, variables: VendoraLocationCountryQueryVariables},
  "#graphql\n        query VendoraVariantPrices($ids: [ID!]!, $companyLocationId: ID!, $country: CountryCode) {\n          nodes(ids: $ids) {\n            ... on ProductVariant {\n              id\n              sku\n              title\n              inventoryQuantity\n              inventoryItem { tracked }\n              product { id title status isGiftCard }\n              contextualPricing(context: { companyLocationId: $companyLocationId, country: $country }) {\n                price { amount currencyCode }\n                quantityRule { minimum maximum increment }\n                quantityPriceBreaks(first: 10) { nodes { minimumQuantity price { amount currencyCode } } }\n              }\n            }\n          }\n        }": {return: VendoraVariantPricesQuery, variables: VendoraVariantPricesQueryVariables},
  "#graphql\n      query VendoraVariantsBySku($query: String!) {\n        productVariants(first: 250, query: $query) { nodes { id sku } }\n      }": {return: VendoraVariantsBySkuQuery, variables: VendoraVariantsBySkuQueryVariables},
  "#graphql\n    query VendoraShopInfo {\n      shop { id name ianaTimezone currencyCode }\n    }": {return: VendoraShopInfoQuery, variables: VendoraShopInfoQueryVariables},
}

interface GeneratedMutationTypes {
  "#graphql\n      mutation VendoraDraftOrderCreate($input: DraftOrderInput!) {\n        draftOrderCreate(input: $input) { draftOrder { id name updatedAt } userErrors { field message } }\n      }": {return: VendoraDraftOrderCreateMutation, variables: VendoraDraftOrderCreateMutationVariables},
  "#graphql\n      mutation VendoraDraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {\n        draftOrderUpdate(id: $id, input: $input) { draftOrder { id name updatedAt } userErrors { field message } }\n      }": {return: VendoraDraftOrderUpdateMutation, variables: VendoraDraftOrderUpdateMutationVariables},
  "#graphql\n      mutation VendoraDraftOrderDelete($input: DraftOrderDeleteInput!) {\n        draftOrderDelete(input: $input) { deletedId userErrors { field message } }\n      }": {return: VendoraDraftOrderDeleteMutation, variables: VendoraDraftOrderDeleteMutationVariables},
  "#graphql\n      mutation VendoraTagsAdd($id: ID!, $tags: [String!]!) {\n        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }\n      }": {return: VendoraTagsAddMutation, variables: VendoraTagsAddMutationVariables},
  "#graphql\n      mutation VendoraTagsRemove($id: ID!, $tags: [String!]!) {\n        tagsRemove(id: $id, tags: $tags) { userErrors { field message } }\n      }": {return: VendoraTagsRemoveMutation, variables: VendoraTagsRemoveMutationVariables},
  "#graphql\n      mutation VendoraInvoiceSend($id: ID!, $email: EmailInput) {\n        draftOrderInvoiceSend(id: $id, email: $email) { draftOrder { id invoiceSentAt invoiceUrl } userErrors { field message } }\n      }": {return: VendoraInvoiceSendMutation, variables: VendoraInvoiceSendMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
