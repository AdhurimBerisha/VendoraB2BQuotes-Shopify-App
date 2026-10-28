import { z } from "zod";

const gid = (type: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${type}/\\d+$`), `Invalid ${type} id`);
const quantity = z.coerce.number().int().min(1).max(100_000);

// Parse FormData with a zod schema (repeated keys become arrays).
const parseForm = <T extends z.ZodType>(form: FormData, schema: T): z.infer<T> => {
  const values: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    values[key] = key in values ? [values[key], value].flat() : value;
  }
  return schema.parse(values);
};

export { gid, parseForm, quantity };
