/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.d.ts';

export type VendoraQuoteCompanyLocationQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type VendoraQuoteCompanyLocationQuery = { companyLocation?: AdminTypes.Maybe<(
    Pick<AdminTypes.CompanyLocation, 'id'>
    & { company: (
      Pick<AdminTypes.Company, 'id'>
      & { mainContact?: AdminTypes.Maybe<Pick<AdminTypes.CompanyContact, 'id'>> }
    ) }
  )> };

export type VendoraQuoteDraftOrderByTagQueryVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type VendoraQuoteDraftOrderByTagQuery = { draftOrders: { nodes: Array<Pick<AdminTypes.DraftOrder, 'id'>> } };

export type VendoraQuoteDraftOrderCreateMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.DraftOrderInput;
}>;


export type VendoraQuoteDraftOrderCreateMutation = { draftOrderCreate?: AdminTypes.Maybe<{ draftOrder?: AdminTypes.Maybe<Pick<AdminTypes.DraftOrder, 'id'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type VendoraQuoteShopAndVariantsQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type VendoraQuoteShopAndVariantsQuery = { shop: { plan: Pick<AdminTypes.ShopPlan, 'shopifyPlus' | 'partnerDevelopment'> }, productVariants: { nodes: Array<(
      Pick<AdminTypes.ProductVariant, 'id' | 'title'>
      & { product: Pick<AdminTypes.Product, 'title'> }
    )> } };

export type VendoraQuoteCompaniesQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type VendoraQuoteCompaniesQuery = { companies: { nodes: Array<(
      Pick<AdminTypes.Company, 'name'>
      & { mainContact?: AdminTypes.Maybe<Pick<AdminTypes.CompanyContact, 'id'>>, locations: { nodes: Array<Pick<AdminTypes.CompanyLocation, 'id' | 'name'>> } }
    )> } };

interface GeneratedQueryTypes {
  "#graphql\n    query VendoraQuoteCompanyLocation($id: ID!) {\n      companyLocation(id: $id) {\n        id\n        company { id mainContact { id } }\n      }\n    }": {return: VendoraQuoteCompanyLocationQuery, variables: VendoraQuoteCompanyLocationQueryVariables},
  "#graphql\n    query VendoraQuoteDraftOrderByTag($query: String!) {\n      draftOrders(first: 1, query: $query) {\n        nodes { id }\n      }\n    }": {return: VendoraQuoteDraftOrderByTagQuery, variables: VendoraQuoteDraftOrderByTagQueryVariables},
  "#graphql\n    query VendoraQuoteShopAndVariants {\n      shop { plan { shopifyPlus partnerDevelopment } }\n      productVariants(first: 50) {\n        nodes { id title product { title } }\n      }\n    }": {return: VendoraQuoteShopAndVariantsQuery, variables: VendoraQuoteShopAndVariantsQueryVariables},
  "#graphql\n      query VendoraQuoteCompanies {\n        companies(first: 50) {\n          nodes {\n            name\n            mainContact { id }\n            locations(first: 20) { nodes { id name } }\n          }\n        }\n      }": {return: VendoraQuoteCompaniesQuery, variables: VendoraQuoteCompaniesQueryVariables},
}

interface GeneratedMutationTypes {
  "#graphql\n    mutation VendoraQuoteDraftOrderCreate($input: DraftOrderInput!) {\n      draftOrderCreate(input: $input) {\n        draftOrder { id }\n        userErrors { field message }\n      }\n    }": {return: VendoraQuoteDraftOrderCreateMutation, variables: VendoraQuoteDraftOrderCreateMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
