import { Prisma } from "@prisma/client";

// All money is Prisma.Decimal (never JS numbers) so totals are exact.
type Money = Prisma.Decimal;

const D = (value: Prisma.Decimal.Value): Money => new Prisma.Decimal(value);
const ZERO = D(0);
const sum = (values: Money[]) => values.reduce((total, value) => total.plus(value), ZERO);

const digitsCache = new Map<string, number>();

// Minor units for a currency: JPY 0, USD 2, KWD 3.
const minorUnits = (currency: string): number => {
  let digits = digitsCache.get(currency);
  if (digits === undefined) {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    digitsCache.set(currency, digits);
  }
  return digits;
};

const roundMoney = (value: Money, currency: string) =>
  value.toDecimalPlaces(minorUnits(currency), Prisma.Decimal.ROUND_HALF_UP);

// Discount amounts round down (toward zero), as Shopify does for percentage discounts (B-33).
const roundMoneyDown = (value: Money, currency: string) =>
  value.toDecimalPlaces(minorUnits(currency), Prisma.Decimal.ROUND_DOWN);

// The string Shopify accepts in MoneyInput.amount.
const toShopifyAmount = (value: Money, currency: string) =>
  roundMoney(value, currency).toFixed(minorUnits(currency));

const formatMoney = (value: Money, currency: string, locale = "en") =>
  new Intl.NumberFormat(locale, { style: "currency", currency }).format(value.toNumber());

export { D, ZERO, formatMoney, minorUnits, roundMoney, roundMoneyDown, sum, toShopifyAmount };
export type { Money };
