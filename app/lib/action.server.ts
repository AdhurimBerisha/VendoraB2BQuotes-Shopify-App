import { ZodError } from "zod";
import { UserError } from "./errors";

type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { key: string; params: Record<string, string | number> } };

// Wraps route actions: expected errors become data for the page; unexpected ones go to the error boundary.
const runAction = async <T>(fn: () => Promise<T>): Promise<ActionResult<T>> => {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof Response) throw error; // auth redirects, etc.
    if (error instanceof UserError) {
      return { ok: false, error: { key: error.key, params: error.params } };
    }
    if (error instanceof ZodError) {
      const fields = error.issues.map((issue) => issue.path.join(".")).join(", ");
      return { ok: false, error: { key: "errors.invalidInput", params: { fields } } };
    }
    throw error;
  }
};

export { runAction };
export type { ActionResult };
