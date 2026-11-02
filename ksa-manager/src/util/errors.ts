/** Fachlicher Fehler mit einer für Nutzer geeigneten, deutschen Meldung. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function isUserFacing(err: unknown): err is Error {
  return err instanceof Error && (err.name === 'UserError' || err.name === 'AuthorizationError');
}
