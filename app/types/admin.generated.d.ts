/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.d.ts';

export type VendoraDraftOrderByTagQueryVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type VendoraDraftOrderByTagQuery = { draftOrders: { nodes: Array<(
      Pick<AdminTypes.DraftOrder, 'id' | 'status'>
      & { purchasingEntity?: AdminTypes.Maybe<{ company: Pick<AdminTypes.Company, 'id'>, location: Pick<AdminTypes.CompanyLocation, 'id'> }> }
    )> } };

export type VendoraDraftOrderCreateMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.DraftOrderInput;
}>;


export type VendoraDraftOrderCreateMutation = { draftOrderCreate?: AdminTypes.Maybe<{ draftOrder?: AdminTypes.Maybe<Pick<AdminTypes.DraftOrder, 'id' | 'name' | 'updatedAt'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type VendoraQuoteShopAndVariantsQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type VendoraQuoteShopAndVariantsQuery = { shop: { plan: Pick<AdminTypes.ShopPlan, 'shopifyPlus' | 'partnerDevelopment'> }, productVariants: { nodes: Array<(
      Pick<AdminTypes.ProductVariant, 'id' | 'title'>
      & { product: Pick<AdminTypes.Product, 'title'> }
    )> } };

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
    ) }
  )> };

export type VendoraCompanySearchQueryVariables = AdminTypes.Exact<{
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type VendoraCompanySearchQuery = { companies: { nodes: Array<(
      Pick<AdminTypes.Company, 'id' | 'name'>
      & { mainContact?: AdminTypes.Maybe<Pick<AdminTypes.CompanyContact, 'id'>>, locations: { nodes: Array<Pick<AdminTypes.CompanyLocation, 'id' | 'name' | 'currency'>> } }
    )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

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

export type VendoraShopInfoQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type VendoraShopInfoQuery = { shop: Pick<AdminTypes.Shop, 'id' | 'ianaTimezone' | 'currencyCode'> };

interface GeneratedQueryTypes {
  "#graphql\n      query VendoraDraftOrderByTag($query: String!) {\n        draftOrders(first: 5, query: $query) {\n          nodes { id status purchasingEntity { ... on PurchasingCompany { company { id } location { id } } } }\n        }\n      }": {return: VendoraDraftOrderByTagQuery, variables: VendoraDraftOrderByTagQueryVariables},
  "#graphql\n    query VendoraQuoteShopAndVariants {\n      shop { plan { shopifyPlus partnerDevelopment } }\n      productVariants(first: 50) {\n        nodes { id title product { title } }\n      }\n    }": {return: VendoraQuoteShopAndVariantsQuery, variables: VendoraQuoteShopAndVariantsQueryVariables},
  "#graphql\n      query VendoraCompanyLocation($id: ID!) {\n        companyLocation(id: $id) {\n          id name currency\n          company { id name mainContact { id customer { id } } }\n        }\n      }": {return: VendoraCompanyLocationQuery, variables: VendoraCompanyLocationQueryVariables},
  "#graphql\n      query VendoraCompanySearch($query: String, $after: String) {\n        companies(first: 20, after: $after, query: $query, sortKey: NAME) {\n          nodes { id name mainContact { id } locations(first: 50) { nodes { id name currency } } }\n          pageInfo { hasNextPage endCursor }\n        }\n      }": {return: VendoraCompanySearchQuery, variables: VendoraCompanySearchQueryVariables},
  "#graphql\n      query VendoraLocationCountry($id: ID!) {\n        companyLocation(id: $id) {\n          shippingAddress { countryCode }\n          billingAddress { countryCode }\n        }\n      }": {return: VendoraLocationCountryQuery, variables: VendoraLocationCountryQueryVariables},
  "#graphql\n        query VendoraVariantPrices($ids: [ID!]!, $companyLocationId: ID!, $country: CountryCode) {\n          nodes(ids: $ids) {\n            ... on ProductVariant {\n              id\n              sku\n              title\n              inventoryQuantity\n              inventoryItem { tracked }\n              product { id title status isGiftCard }\n              contextualPricing(context: { companyLocationId: $companyLocationId, country: $country }) {\n                price { amount currencyCode }\n                quantityRule { minimum maximum increment }\n                quantityPriceBreaks(first: 10) { nodes { minimumQuantity price { amount currencyCode } } }\n              }\n            }\n          }\n        }": {return: VendoraVariantPricesQuery, variables: VendoraVariantPricesQueryVariables},
  "#graphql\n    query VendoraShopInfo {\n      shop { id ianaTimezone currencyCode }\n    }": {return: VendoraShopInfoQuery, variables: VendoraShopInfoQueryVariables},
}

interface GeneratedMutationTypes {
  "#graphql\n      mutation VendoraDraftOrderCreate($input: DraftOrderInput!) {\n        draftOrderCreate(input: $input) { draftOrder { id name updatedAt } userErrors { field message } }\n      }": {return: VendoraDraftOrderCreateMutation, variables: VendoraDraftOrderCreateMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
