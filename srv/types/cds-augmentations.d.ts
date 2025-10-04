import '@sap/cds';

declare module '@sap/cds' {
  interface RequestConstructor {
    new <T = any>(init?: Record<string, unknown>): Request<T>;
    prototype: Request;
  }

  const Request: RequestConstructor;

  function raw(sql: TemplateStringsArray, ...values: unknown[]): any;
  function raw(sql: string, ...values: unknown[]): any;

  namespace utils {
    function guid(): string;
    function uuid(): string;
  }
}
