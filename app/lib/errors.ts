// An expected, user-facing error. `key` is a translation key (app/locales/en.json from M2.8).
class UserError extends Error {
  constructor(
    public key: string,
    public params: Record<string, string | number> = {},
    public status = 400,
  ) {
    super(key);
    this.name = "UserError";
  }
}

class NotFoundError extends UserError {
  constructor(key = "errors.notFound") {
    super(key, {}, 404);
  }
}

class ForbiddenError extends UserError {
  constructor(key = "errors.forbidden") {
    super(key, {}, 403);
  }
}

class ConflictError extends UserError {
  constructor(key = "errors.conflict", params: Record<string, string | number> = {}) {
    super(key, params, 409);
  }
}

export { ConflictError, ForbiddenError, NotFoundError, UserError };
