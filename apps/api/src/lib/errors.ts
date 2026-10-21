export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
