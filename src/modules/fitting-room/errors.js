/** Base class for every error the fitting room raises on purpose. */
export class FittingRoomError extends Error {
  constructor(message, { status = 500, code = 'fitting_room_error', details = [] } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class NotFoundError extends FittingRoomError {
  constructor(message = 'Not found') {
    super(message, { status: 404, code: 'not_found' });
  }
}

/** Raised when a selection breaks the catalogue rules. `details` lists each issue. */
export class ValidationError extends FittingRoomError {
  constructor(details, message = 'The selection is not valid.') {
    super(message, { status: 422, code: 'invalid_selection', details });
  }
}

export class BadRequestError extends FittingRoomError {
  constructor(message = 'Bad request', details = []) {
    super(message, { status: 400, code: 'bad_request', details });
  }
}
